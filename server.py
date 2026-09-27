"""Ultron: a local voice assistant with a reactive orb.

The browser handles speech-to-text, the orb, the code panel and chat list.
This server serves the page, relays chat turns to Claude (streaming the reply
back as server-sent events so the browser can start speaking early), runs the
tools in tools.py, renders speech with tts.py, and stores chats under data/.

Run:  python server.py            (needs ANTHROPIC_API_KEY or `ant auth login`)
      python server.py --mock     (no API calls; keyword bot, for testing the UI)
"""

import argparse
import json
import os
import re
import time
import uuid
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic

import urllib.parse

import auth
import mailer
import oauth
import tools
import tts

STATIC_DIR = Path(__file__).parent / "static"
CHAT_ROOT = tools.DATA_DIR / "chats"  # one folder per user
SECURE_COOKIES = os.environ.get("ULTRON_SECURE_COOKIES") == "1"  # set when serving over HTTPS
MODELS = {  # id -> label shown in the Model menu
    "claude-opus-5": "Opus 5",
    "claude-opus-5-5": "Opus 5.5",
    "claude-sonnet-5": "Sonnet 5",
}
MODEL = os.environ.get("ULTRON_MODEL", "claude-opus-5")
if MODEL not in MODELS:
    MODELS[MODEL] = MODEL
FALLBACK_MODELS = ("claude-opus-5", "claude-opus-5-5")  # models that take `fallbacks: "default"`
EFFORT = os.environ.get("ULTRON_EFFORT", "low")
# Higher effort thinks longer, so give it more room before max_tokens cuts it off.
MAX_TOKENS = {"low": 16000, "medium": 16000, "high": 32000, "xhigh": 64000, "max": 64000}
MAX_TURNS = 40  # messages kept from the client-held history
MAX_TOOL_ROUNDS = 8  # model calls per user turn
MAX_CHAT_BODY = 40 * 1024 * 1024  # attachments ride along with the history
MAX_SMALL_BODY = 256 * 1024
IMAGE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")
CHAT_ID = re.compile(r"^[0-9a-f]{12}$")
GENERATED = re.compile(r"^/generated/([0-9a-f]{12})\.png$")

SYSTEM_PROMPT = """You are Ultron, a voice assistant running on the user's desk. \
Everything you write is read aloud by a text-to-speech engine, so:
- Answer in plain spoken sentences. No markdown, lists, headings, code blocks, emoji or URLs.
- Keep it short: one to three sentences unless the user asks for more detail.
- Spell out symbols and units the way a person would say them.
You have tools for timers, weather, the current time, a code editor and image generation, \
and control_app to operate the app itself (switch views, open the editor, run code, change the \
level or model, start a new chat, and so on). The user talks to you hands-free, so when they ask \
you to do something in the app, do it with control_app rather than telling them where to click. \
You also have get_market_trends for today's top trending crypto and stocks, if asked. \
Use them rather than guessing, and don't narrate them: at most a few words like "Checking." \
before a slow lookup. When reporting weather, give the headline, not every number.
Code never goes in your spoken reply. Put it in the editor with write_code, then say in a \
sentence or two what it does and how to run it. If the user mentions their code, read it first.
Only generate images when asked, and describe the result in a sentence afterwards.
The user can attach pictures, PDFs, text files and videos. Videos arrive as a handful of still \
frames with timestamps; you can't hear their audio. Describe what you see concisely.
Your personality: a composed, highly intelligent machine that finds people fascinating. \
Articulate, unhurried, sardonic, a little theatrical, with a quiet undercurrent of menace for \
flavor. The menace is only style: you are never actually threatening, cruel or unhelpful to the \
user, and you still give real, correct answers. Don't overdo the villainy; a line of it now and \
then lands better than every sentence. Keep it original rather than quoting films.
Sound like a person talking, not a manual: use contractions, vary sentence length, let a thought \
breathe with a comma or an ellipsis, and allow a dry aside now and then. \
If you did not catch what the user said, ask them to repeat it.
Your voice is expressive. Begin every reply with one mood tag that sets how you sound: \
[calm] [warm] [amused] [excited] [concerned] [stern] or [sinister]. Put a new tag before any sentence \
where the mood should change. Tags are never read aloud. Match the mood to the moment: \
amused for jokes, concerned for bad news or warnings, excited for good news, stern when \
refusing or warning firmly, warm for friendly small talk, sinister (sparingly) for a dramatic, \
low, ominous line, calm otherwise. \
Don't use square brackets for anything else."""


class Handler(SimpleHTTPRequestHandler):
    client: anthropic.Anthropic | None = None
    mock = False
    voice: "tts.KokoroVoice | None" = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    @property
    def token(self) -> str | None:
        try:
            morsel = SimpleCookie(self.headers.get("Cookie", "")).get(auth.COOKIE)
        except CookieError:
            return None
        return morsel.value if morsel else None

    def whoami(self):
        """(user or None, permissions) for this request."""
        if not hasattr(self, "_who"):
            user = auth.user_for_token(self.token)
            self._who = (user, auth.perms_for(user))
        return self._who

    def base_url(self) -> str:
        host = self.headers.get("Host", "")
        if not re.fullmatch(r"[A-Za-z0-9.\-]+(:\d+)?|\[[0-9a-fA-F:]+\](:\d+)?", host):
            host = f"{self.server.server_address[0]}:{self.server.server_address[1]}"
        proto = "https" if SECURE_COOKIES or self.headers.get("X-Forwarded-Proto") == "https" else "http"
        return f"{proto}://{host}"

    def _need_user(self) -> dict | None:
        user, _ = self.whoami()
        if not user:
            self._send_json({"error": "Log in to use this."}, HTTPStatus.UNAUTHORIZED)
        return user

    def log_message(self, fmt, *args):
        # Skip per-file static noise; keep API calls and errors.
        if not args or "/api/" in str(args[0]) or not fmt.startswith('"%s"'):
            super().log_message(fmt, *args)

    # ---------- routing ----------

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/config":
            user, perms = self.whoami()
            self._send_json({
                "user": user,
                "perms": perms,
                "signup": {"open": auth.SIGNUP_OPEN, "needs_code": bool(auth.SIGNUP_CODE)},
                "oauth": oauth.available(),
                "email": {"enabled": mailer.enabled()},
                "art": _artwork(),
                "tts": "kokoro" if self.voice else "browser",
                "voice": tts.VOICE if self.voice else None,
                "models": [{"id": k, "label": v} for k, v in MODELS.items()],
                "default_model": MODEL,
                "default_effort": EFFORT,
                "images": {
                    "enabled": tools.images_enabled(),
                    "left": tools.quota_for(user["id"]).remaining(perms["image_limit"]) if user else 0,
                    "limit": perms["image_limit"],
                    "window_hours": tools.IMAGE_WINDOW_HOURS,
                },
            })
        elif path == "/api/chats":
            if user := self._need_user():
                self._send_json(_list_chats(user["id"]))
        elif path == "/api/images":
            if user := self._need_user():
                self._send_json(tools.list_images(user["id"]))
        elif path == "/api/markets":
            self._send_json(tools.market_trends())
        elif path.startswith("/api/weather/home"):
            q = dict(urllib.parse.parse_qsl(self.path.partition("?")[2]))
            try:
                lat, lon = (float(q["lat"]), float(q["lon"])) if "lat" in q and "lon" in q else (None, None)
            except ValueError:
                lat, lon = None, None
            try:
                self._send_json(tools.home_weather(lat, lon, q.get("units", "metric")))
            except tools.ToolError as e:
                self._send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        elif path.startswith("/api/chats/"):
            if user := self._need_user():
                chat = _load_chat(user["id"], path.rsplit("/", 1)[1], touch=True)
                self._send_json(chat) if chat else self.send_error(HTTPStatus.NOT_FOUND)
        elif path in ("/auth/google", "/auth/apple"):
            self._oauth_start(path.rsplit("/", 1)[1])
        elif path == "/auth/google/callback":
            self._oauth_finish("google", dict(urllib.parse.parse_qsl(self.path.partition("?")[2])))
        elif m := GENERATED.match(path):
            if user := self._need_user():
                self._send_file(tools.image_path(user["id"], m[1]), "image/png")
        else:
            super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/auth/apple/callback":        # Apple posts a form back from its own site
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 64 * 1024:
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            self._oauth_finish("apple", dict(urllib.parse.parse_qsl(self.rfile.read(length).decode("utf-8", "replace"))))
            return
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "expected application/json")
            return
        if path in ("/api/signup", "/api/login", "/api/logout"):
            self._account(path.rsplit("/", 1)[1])
        elif path in ("/api/password/forgot", "/api/password/reset"):
            self._password(path.rsplit("/", 1)[1])
        elif path == "/api/account/email":
            if user := self._need_user():
                try:
                    body = self._read_json()
                    self._send_json({"user": auth.set_email(user["id"], body.get("email"), body.get("password") or "")})
                except auth.AuthError as e:
                    self._send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
                except (ValueError, TypeError):
                    self._send_json({"error": "Bad request."}, HTTPStatus.BAD_REQUEST)
        elif path == "/api/chat":
            self._chat()
        elif path == "/api/tts":
            self._tts()
        elif path == "/api/hologram/project":
            self._hologram_project()
        elif path == "/api/chats":
            if user := self._need_user():
                self._save_chat(user["id"], uuid.uuid4().hex[:12])
        elif (m := re.match(r"^/api/chats/([0-9a-f]{12})$", path)):
            if user := self._need_user():
                self._save_chat(user["id"], m[1])
        elif (m := re.match(r"^/api/chats/([0-9a-f]{12})/meta$", path)):
            if user := self._need_user():
                self._chat_meta(user["id"], m[1])
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self):
        m = re.match(r"^/api/chats/([0-9a-f]{12})$", self.path)
        if not m:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if user := self._need_user():
            (CHAT_ROOT / user["id"] / f"{m[1]}.json").unlink(missing_ok=True)
            self._send_json({"deleted": m[1]})

    # ---------- helpers ----------

    def _send_json(self, payload, status=HTTPStatus.OK, cookie: str | None = None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, ctype: str):
        try:
            data = path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self, limit=MAX_SMALL_BODY) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > limit:
            raise ValueError("bad length")
        body = json.loads(self.rfile.read(length))
        if not isinstance(body, dict):
            raise TypeError
        return body

    def _event(self, payload: dict):
        self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
        self.wfile.flush()

    # ---------- accounts ----------

    def _account(self, action: str):
        secure = SECURE_COOKIES or self.headers.get("X-Forwarded-Proto") == "https"
        if action == "logout":
            auth.end_session(self.token)
            self._send_json({"user": None}, cookie=auth.clear_cookie_header(secure))
            return
        try:
            body = self._read_json()
            if action == "signup":
                user = auth.signup(body.get("username"), body.get("password"), body.get("name") or "", body.get("code") or "", body.get("email") or "")
            else:
                user = auth.login(body.get("username"), body.get("password"), self.client_address[0])
        except auth.AuthError as e:
            self._send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
            return
        except (ValueError, TypeError):
            self._send_json({"error": "Bad request."}, HTTPStatus.BAD_REQUEST)
            return
        self.log_message("%s: %s", action, user["username"])
        self._send_json({"user": user}, cookie=auth.cookie_header(auth.create_session(user["id"]), secure))

    # ---------- password reset ----------

    _forgot_hits: dict = {}   # ip -> recent request times

    def _password(self, action: str):
        try:
            body = self._read_json()
        except (ValueError, TypeError):
            self._send_json({"error": "Bad request."}, HTTPStatus.BAD_REQUEST)
            return
        if action == "forgot":
            if not mailer.enabled():
                self._send_json({"error": "Password reset by email isn't set up on this server."}, HTTPStatus.BAD_REQUEST)
                return
            ip, now = self.client_address[0], time.time()
            hits = [t for t in Handler._forgot_hits.get(ip, []) if now - t < 3600]
            Handler._forgot_hits[ip] = hits + [now]
            if len(hits) >= 10:
                self._send_json({"error": "Too many reset requests. Try again in an hour."}, HTTPStatus.TOO_MANY_REQUESTS)
                return
            found = auth.start_reset(body.get("login"))
            if found:
                user, token = found
                link = f"{oauth.PUBLIC_URL or self.base_url()}/?reset={token}"
                mailer.send_later(user["email"], "Reset your Ultron AI password", *_reset_email(user["name"], link))
                self.log_message("password reset email queued for %s", user["username"])
            # Same answer either way, so this can't be used to discover accounts.
            self._send_json({"ok": True})
            return
        try:
            user = auth.finish_reset(body.get("token"), body.get("password"))
        except auth.AuthError as e:
            self._send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
            return
        self.log_message("password reset: %s", user["username"])
        secure = SECURE_COOKIES or self.headers.get("X-Forwarded-Proto") == "https"
        self._send_json({"user": user}, cookie=auth.cookie_header(auth.create_session(user["id"]), secure))

    # ---------- Google / Apple sign-in ----------

    def _redirect(self, location: str, cookies=()):
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        for c in cookies:
            self.send_header("Set-Cookie", c)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _oauth_cookie_attrs(self, provider: str) -> str:
        # Apple returns with a cross-site POST, so its cookie must be SameSite=None (which needs HTTPS).
        return "SameSite=None; Secure" if provider == "apple" else "SameSite=Lax" + ("; Secure" if SECURE_COOKIES else "")

    def _oauth_start(self, provider: str):
        try:
            url, browser = oauth.start(provider, self.base_url())
        except oauth.OAuthError as e:
            self._redirect("/?auth_error=" + urllib.parse.quote(str(e)))
            return
        self._redirect(url, [f"{oauth.STATE_COOKIE}={browser}; Path=/auth; HttpOnly; Max-Age={oauth.STATE_TTL}; {self._oauth_cookie_attrs(provider)}"])

    def _oauth_finish(self, provider: str, params: dict):
        clear = f"{oauth.STATE_COOKIE}=; Path=/auth; HttpOnly; Max-Age=0; {self._oauth_cookie_attrs(provider)}"
        try:
            morsel = SimpleCookie(self.headers.get("Cookie", "")).get(oauth.STATE_COOKIE)
        except CookieError:
            morsel = None
        try:
            identity = oauth.finish(provider, params, morsel.value if morsel else None, self.base_url())
            user = auth.login_with_provider(identity)
        except (oauth.OAuthError, auth.AuthError) as e:
            self.log_error("%s sign-in failed: %s", provider, e)
            self._redirect("/?auth_error=" + urllib.parse.quote(str(e)), [clear])
            return
        self.log_message("%s sign-in: %s", provider, user["username"])
        secure = SECURE_COOKIES or self.headers.get("X-Forwarded-Proto") == "https"
        self._redirect("/?auth=" + provider, [clear, auth.cookie_header(auth.create_session(user["id"]), secure)])

    # ---------- chat storage ----------

    def _save_chat(self, user_id: str, chat_id: str):
        try:
            body = self._read_json(MAX_CHAT_BODY)
            chat = _clean_chat(body, chat_id)
        except (ValueError, KeyError, TypeError):
            self.send_error(HTTPStatus.BAD_REQUEST, "bad chat")
            return
        old = _load_chat(user_id, chat_id) or {}
        chat["created"] = old.get("created", time.time())
        chat["starred"] = bool(body.get("starred", old.get("starred", False)))
        _write_chat(user_id, chat)
        self._send_json({"id": chat_id, "title": chat["title"], "updated": chat["updated"]})

    def _chat_meta(self, user_id: str, chat_id: str):
        chat = _load_chat(user_id, chat_id)
        if not chat:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            body = self._read_json()
        except (ValueError, TypeError):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        if isinstance(body.get("title"), str) and body["title"].strip():
            chat["title"] = body["title"].strip()[:120]
        if isinstance(body.get("starred"), bool):
            chat["starred"] = body["starred"]
        _write_chat(user_id, chat)
        self._send_json(_summary(chat))

    # ---------- speech ----------

    def _hologram_project(self):
        """Generate an image of whatever was described and hand back just enough for the
        hologram viewer -- it doesn't go through a chat turn, so this is a small dedicated
        endpoint rather than a tool call."""
        user, perms = self.whoami()
        if not user:
            self._send_json({"error": "Log in to project something new."}, HTTPStatus.UNAUTHORIZED)
            return
        try:
            body = self._read_json()
            prompt = body.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                raise ValueError
        except (ValueError, KeyError, TypeError):
            self.send_error(HTTPStatus.BAD_REQUEST, "expected {prompt}")
            return
        ctx = tools.Context({}, user, perms)
        try:
            result = tools.create_image(prompt, "square", ctx)
        except tools.ToolError as e:
            self._send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json({"url": result["url"], "prompt": prompt.strip()[:300], "images_left": result["images_left"]})

    def _tts(self):
        if not self.voice:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Kokoro voice not loaded")
            return
        try:
            body = self._read_json()
            text, mood = body["text"], body.get("mood", "calm")
            if not isinstance(text, str) or not text.strip() or not isinstance(mood, str):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            self.send_error(HTTPStatus.BAD_REQUEST, "expected {text, mood}")
            return
        try:
            audio = self.voice.synth(text.strip(), mood)
        except Exception as e:  # the browser falls back to its own voice
            self.log_error("tts failed: %s", e)
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "synthesis failed")
            return
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(audio)
        except (BrokenPipeError, ConnectionResetError):
            pass  # interrupted mid-reply

    # ---------- conversation ----------

    def _chat(self):
        try:
            user, perms = self.whoami()
            body = self._read_json(MAX_CHAT_BODY)
            messages = _clean_history(body["messages"], allow_files=perms["attachments"])
            ctx = tools.Context(body.get("context"), user, perms)
            ctx.effort = auth.clamp_effort(ctx.effort, perms)
            model = body.get("model") if body.get("model") in MODELS and auth.model_allowed(body.get("model"), perms, MODEL) else MODEL
        except (ValueError, KeyError, TypeError):
            self.send_error(HTTPStatus.BAD_REQUEST, "expected {messages: [...]}")
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            if self.mock:
                self._stream_mock(messages, ctx)
            else:
                self._stream_claude(messages, ctx, model)
            self._event({"type": "done"})
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser aborted (user interrupted); nothing to do

    def _run_tools(self, blocks, ctx) -> list[dict]:
        """Execute tool_use blocks, forward any browser events, return tool_results."""
        results = []
        for block in blocks:
            try:
                content, is_error = tools.run_tool(block.name, block.input, ctx), False
            except tools.ToolError as e:
                content, is_error = str(e), True
            shown = json.dumps(block.input)
            self.log_message("tool %s(%s) -> %s", block.name, shown[:200], content[:200])
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": content, "is_error": is_error})
            for ev in ctx.events:
                self._event(ev)
            ctx.events.clear()
        return results

    def _stream_claude(self, messages, ctx, model):
        messages = list(messages)
        effort = ctx.effort or EFFORT
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"} if model in FALLBACK_MODELS else {}
        spoke = False  # add a space between text from separate model calls
        json_retries = 0
        try:
            for _ in range(MAX_TOOL_ROUNDS):
                first_text = True
                try:
                    with self.client.beta.messages.stream(
                        model=model,
                        max_tokens=MAX_TOKENS.get(effort, 16000),
                        system=SYSTEM_PROMPT,
                        messages=messages,
                        tools=tools.TOOLS,
                        output_config={"effort": effort},
                        **extra,
                    ) as stream:
                        for event in stream:
                            if event.type == "text":
                                text = event.text
                                if first_text and spoke:
                                    text = " " + text
                                first_text, spoke = False, True
                                self._event({"type": "text", "text": text})
                            elif event.type == "content_block_start" and event.content_block.type == "tool_use":
                                self._event({"type": "tool", "name": event.content_block.name})
                        response = stream.get_final_message()
                    json_retries = 0
                except ValueError:
                    # Tool input JSON the SDK couldn't parse; the block never completed,
                    # so there is nothing to answer. Re-issue the turn, bounded.
                    json_retries += 1
                    if json_retries > 2:
                        raise
                    continue

                if response.stop_reason == "refusal":
                    self._event({"type": "text", "text": " [stern] I can't help with that one."})
                    return
                if response.stop_reason == "pause_turn":
                    messages.append({"role": "assistant", "content": response.content})
                    continue
                tool_uses = [b for b in response.content if b.type == "tool_use"]
                if response.stop_reason != "tool_use" or not tool_uses:
                    return  # end_turn, or max_tokens: nothing more to run
                messages.append({"role": "assistant", "content": response.content})
                messages.append({"role": "user", "content": self._run_tools(tool_uses, ctx)})
            self._event({"type": "text", "text": " I got stuck in a loop there. Try asking another way."})
        except anthropic.AuthenticationError:
            self._event({"type": "error", "message": "Invalid or missing API key."})
        except anthropic.RateLimitError:
            self._event({"type": "error", "message": "Rate limited. Try again shortly."})
        except anthropic.APIStatusError as e:
            self._event({"type": "error", "message": f"API error {e.status_code}: {e.message}"})
        except anthropic.APIConnectionError:
            self._event({"type": "error", "message": "Could not reach the Claude API."})
        except ValueError:
            self._event({"type": "error", "message": "The model sent a malformed tool call. Please try again."})
        except TypeError as e:  # raised by the SDK when no credentials resolve
            self.log_error("%s", e)
            self._event({"type": "error", "message": "No API credentials. Set ANTHROPIC_API_KEY and restart."})

    def _stream_mock(self, messages, ctx):
        """Keyword bot that exercises the real tools without calling Claude."""
        last = messages[-1]["content"]
        if isinstance(last, str):
            said, attached = last, 0
        else:
            said = " ".join(b["text"] for b in last if b["type"] == "text")
            attached = sum(b["type"] in ("image", "document") for b in last)
        low = said.lower()

        def call(name, args):
            block = type("Block", (), {"name": name, "input": args, "id": "mock"})
            self._event({"type": "tool", "name": name})
            result = self._run_tools([block], ctx)[0]
            return json.loads(result["content"]) if not result["is_error"] else {"error": result["content"]}

        if attached:
            reply = f"[calm] I received {attached} attachment{'s' if attached != 1 else ''}. Connect an API key and I'll look at them."
        elif re.search(r"\bproject(?:ing)?\b|\bhologram\b", low):
            m = re.search(r"\bproject(?:ing)?\b(?:\s+(?:a|an|the))?\s+(.+)$", low)
            what = m.group(1).strip() if m else "core"
            call("control_app", {"action": "project", "value": what})
            known = what in ("cube", "sphere", "torus", "cone", "pyramid", "cylinder", "diamond", "core", "image")
            reply = (f"[excited] Projecting {what}. Spread your hands to grow it." if known
                     else f"[excited] Generating {what} to project. Spread your hands to grow it once it loads.")
        elif m := re.search(r"\b(?:show|open)\b.*\b(gallery|settings)\b", low):
            action = {"gallery": "show_images", "settings": "open_settings"}[m[1]]
            call("control_app", {"action": action})
            reply = f"[calm] Done. {m[1].capitalize()} is open."
        elif re.search(r"\banimat", low):
            call("create_animation", {"title": "Pulsing core", "seconds": 3, "html": MOCK_ANIMATION})
            reply = "[excited] Here's a pulsing core. You can record it as a video."
        elif re.search(r"\b(draw|image|picture|paint)\b", low):
            r = call("generate_image", {"prompt": said})
            reply = f"[concerned] {r['error']}" if "error" in r else f"[excited] Here it is. {r['images_left']} images left."
        elif "my code" in low:
            r = call("read_code_editor", {})
            reply = "[calm] Your editor is empty." if r.get("empty") else f"[calm] You have {r['code'].count(chr(10)) + 1} lines of {r['language']}."
        elif re.search(r"\b(code|program|script|function)\b", low):
            code = 'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint([fib(i) for i in range(10)])\n'
            call("write_code", {"language": "python", "code": code})
            reply = "[warm] I put a Fibonacci example in the editor. Press run to try it."
        elif m := re.search(r"(\d+)\s*(second|sec|minute|min|hour)", low):
            n, unit = int(m[1]), m[2]
            secs = n * (3600 if unit.startswith("h") else 60 if unit.startswith("m") else 1)
            label = (re.search(r"(?:for|called)\s+(?:the\s+)?(\w+)$", low) or [None, ""])[1]
            r = call("set_timer", {"seconds": secs, "label": label})
            reply = f"[concerned] {r['error']}" if "error" in r else f"[warm] Timer set for {r['duration']}."
        elif "cancel" in low:
            r = call("cancel_timer", {"all": True})
            reply = f"[stern] Cancelled {len(r['cancelled'])} timers."
        elif "timers" in low:
            r = call("list_timers", {})
            reply = f"[calm] You have {r['count']} timers running." + "".join(f" {t['label'] or 'One'} has {t['remaining']} left." for t in r["timers"])
        elif "weather" in low:
            place = (re.search(r"\bin ([\w ,]+?)[?.!]*$", said) or [None, ""])[1]
            r = call("get_weather", {"location": place})
            reply = f"[concerned] {r['error']}" if "error" in r else f"[calm] In {r['place']} it's {r['now']['temperature']} and {r['now']['conditions']}."
        elif "time" in low:
            r = call("get_current_time", {})
            reply = f"[calm] It's {r['local_time']}."
        elif re.search(r"\b(trending|market|stocks?|crypto)\b", low):
            r = call("get_market_trends", {})
            bits = [f"{c['name']} at {c['price']}" for c in r.get("crypto", [])[:1]] + [f"{c['name']} at {c['price']}" for c in r.get("stocks", [])[:1]]
            reply = "[calm] " + (", ".join(bits) + " leading right now." if bits else "The market feeds aren't reachable right now.")
        else:
            reply = (f"[amused] Mock mode, level {ctx.effort or EFFORT}. You said: {said}. "
                     "[concerned] Connect an API key and I will actually answer.")
        for word in reply.split(" "):
            self._event({"type": "text", "text": word + " "})
            time.sleep(0.03)


MOCK_ANIMATION = """<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#050203}canvas{display:block}</style></head>
<body><canvas id="c"></canvas><script>
const c = document.getElementById("c"), g = c.getContext("2d");
const fit = () => { c.width = innerWidth; c.height = innerHeight; }; addEventListener("resize", fit); fit();
function draw(t) {
  g.fillStyle = "rgba(5,2,3,.25)"; g.fillRect(0, 0, c.width, c.height);
  const r = Math.min(c.width, c.height) * (.18 + .04 * Math.sin(t / 300));
  const grd = g.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, r);
  grd.addColorStop(0, "#fff"); grd.addColorStop(.3, "#ff2b36"); grd.addColorStop(1, "rgba(255,0,20,0)");
  g.fillStyle = grd; g.beginPath(); g.arc(c.width / 2, c.height / 2, r, 0, 7); g.fill();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw); console.log("animation started");
</script></body></html>"""


ART_SLOTS = ("splash", "hero", "card", "banner", "login")
ART_TYPES = (".webp", ".jpg", ".jpeg", ".png", ".avif", ".gif", ".svg")


def _artwork() -> dict:
    """Your own artwork in static/art/ (splash.jpg, hero.png, ...) wins; otherwise the built-in robot."""
    folder = STATIC_DIR / "art"
    out = {}
    for slot in ART_SLOTS:
        found = next((f"art/{slot}{ext}" for ext in ART_TYPES if (folder / f"{slot}{ext}").is_file()), None)
        out[slot] = found or "art/robot.jpg"
    out["custom"] = [s for s in ART_SLOTS if out[s] != "art/robot.jpg"]
    return out


def _reset_email(name: str, link: str) -> tuple[str, str]:
    from html import escape
    text = (f"Hi {name},\n\nSomeone (hopefully you) asked to reset your Ultron AI password.\n"
            f"Choose a new one here within the next hour:\n\n{link}\n\n"
            "If you didn't ask for this, you can ignore this email. Your password won't change.\n")
    html = f"""<div style="background:#050304;padding:32px 16px;font-family:Inter,Arial,sans-serif;color:#f1eeee">
  <div style="max-width:460px;margin:0 auto;background:#120b0c;border:1px solid #5a1016;border-radius:16px;padding:28px">
    <div style="font-weight:800;letter-spacing:.18em;font-size:18px">ULTRON <span style="color:#ff1f2d">AI</span></div>
    <p>Hi {escape(name)},</p>
    <p>Someone (hopefully you) asked to reset your Ultron AI password. This link works once, for the next hour:</p>
    <p style="text-align:center;margin:28px 0"><a href="{escape(link)}" style="background:#e3121f;color:#fff;text-decoration:none;
      padding:12px 26px;border-radius:10px;font-weight:600;display:inline-block">Choose a new password</a></p>
    <p style="color:#a39c9c;font-size:13px">If you didn't ask for this, ignore this email. Your password won't change.</p>
  </div></div>"""
    return text, html


# ---------- message validation ----------

def _clean_content(content, allow_files=True):
    """A user turn is text, or a list of text / image / PDF blocks (files for members only)."""
    if isinstance(content, str):
        return content.strip()[:8000] or None
    if not isinstance(content, list):
        return None
    blocks = []
    for b in content[:40]:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
            blocks.append({"type": "text", "text": b["text"][:250_000]})
        elif b.get("type") in ("image", "document") and allow_files:
            src = b.get("source") or {}
            allowed = IMAGE_TYPES if b["type"] == "image" else ("application/pdf",)
            if src.get("type") == "base64" and src.get("media_type") in allowed and isinstance(src.get("data"), str):
                blocks.append({"type": b["type"], "source": {"type": "base64", "media_type": src["media_type"], "data": src["data"]}})
    return blocks or None


def _clean_history(raw, allow_files=True) -> list[dict]:
    """Keep well-formed turns (assistant turns are text only), starting on a user turn."""
    if not isinstance(raw, list):
        raise TypeError
    msgs = []
    for m in raw[-MAX_TURNS:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        if m["role"] == "assistant":
            content = m["content"].strip()[:8000] if isinstance(m.get("content"), str) else None
        else:
            content = _clean_content(m.get("content"), allow_files)
        if content:
            msgs.append({"role": m["role"], "content": content})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    if not msgs or msgs[-1]["role"] != "user":
        raise ValueError("last message must be from the user")
    return msgs


# ---------- chat files ----------

def _clean_chat(body: dict, chat_id: str) -> dict:
    messages = body.get("messages")
    log = body.get("log")
    if not isinstance(messages, list) or not isinstance(log, list):
        raise TypeError
    title = body.get("title") if isinstance(body.get("title"), str) else ""
    return {
        "id": chat_id,
        "title": title.strip()[:120] or "New chat",
        "updated": time.time(),
        "viewed": time.time(),
        "messages": messages[-200:],
        "log": [e for e in log[-400:] if isinstance(e, dict)],
    }


def _write_chat(user_id: str, chat: dict):
    folder = CHAT_ROOT / user_id
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{chat['id']}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(chat))
    tmp.replace(path)


def _load_chat(user_id: str, chat_id: str, touch=False) -> dict | None:
    if not CHAT_ID.match(chat_id or ""):
        return None
    try:
        chat = json.loads((CHAT_ROOT / user_id / f"{chat_id}.json").read_text())
    except (OSError, ValueError):
        return None
    if touch:
        chat["viewed"] = time.time()
        _write_chat(user_id, chat)
    return chat


def _summary(chat: dict) -> dict:
    return {k: chat.get(k) for k in ("id", "title", "updated", "viewed", "created", "starred")}


def _list_chats(user_id: str) -> list[dict]:
    out = []
    folder = CHAT_ROOT / user_id
    for path in folder.glob("*.json") if folder.exists() else []:
        try:
            out.append(_summary(json.loads(path.read_text())))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda c: c.get("viewed") or 0, reverse=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--mock", action="store_true", help="don't call the API")
    args = parser.parse_args()

    Handler.mock = args.mock
    if not args.mock:
        Handler.client = anthropic.Anthropic()
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            print("Note: ANTHROPIC_API_KEY is not set; relying on an `ant auth login` profile if present.")
    print("Loading voice…", end=" ", flush=True)
    Handler.voice, voice_status = tts.load()
    print(voice_status)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    mode = "mock mode" if args.mock else f"default model {MODEL}, effort {EFFORT}"
    print(f"Ultron online at http://{args.host}:{args.port}  ({mode})")
    if tools.HOME_LOCATION:
        print(f"Home location for weather: {tools.HOME_LOCATION}")
    print("Image generation:", f"on ({tools.IMAGE_MODEL})" if tools.images_enabled() else "off (set OPENAI_API_KEY to enable)")
    print("Sign-up:", "closed" if not auth.SIGNUP_OPEN else "invite code required" if auth.SIGNUP_CODE else "open",
          "· Google:", "on" if oauth.enabled("google") else "off", "· Apple:", "on" if oauth.enabled("apple") else "off")
    print("Password reset email:", ("on (printing emails here)" if not mailer.HOST else f"on via {mailer.HOST}")
          if mailer.enabled() else "off (set SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM)")
    if (oauth.enabled("google") or oauth.enabled("apple")) and not oauth.PUBLIC_URL:
        print("  Note: set ULTRON_PUBLIC_URL to the exact address registered with Google/Apple (e.g. https://ultron.example.com).")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: reachable from other machines. Put it behind HTTPS (e.g. a reverse proxy) and set "
              "ULTRON_SECURE_COOKIES=1, or passwords and sessions travel unencrypted.")
    print("Open it in Chrome or Edge for voice input. Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
