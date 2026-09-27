"""Ultron's free, on-device brain: a model served by Ollama (https://ollama.com) on this PC.

Nothing leaves the machine except the web searches the model chooses to run. Set:
  ULTRON_BRAIN=local        use this instead of Claude (the default when no ANTHROPIC_API_KEY is set)
  OLLAMA_MODEL=qwen3:8b     which downloaded model to use by default
  OLLAMA_URL=http://127.0.0.1:11434
  OLLAMA_NUM_CTX=8192       context window; larger remembers more but needs more memory
"""

import json
import os
import urllib.error
import urllib.request

URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:8b")
NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "8192"))
MAX_TURNS = int(os.environ.get("OLLAMA_MAX_TURNS", "16"))  # a small context fits fewer messages

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # always talk to Ollama directly


class LocalBrainError(Exception):
    """Shown (and spoken) to the user as-is."""


def _open(path: str, body: dict | None = None, timeout: float = 10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, headers={"Content-Type": "application/json"})
    return _opener.open(req, timeout=timeout)


def installed_models() -> list[str]:
    try:
        with _open("/api/tags", timeout=3) as r:
            return sorted(m["name"] for m in json.load(r).get("models", []))
    except Exception:
        return []


_caps: dict[str, set] = {}


def capabilities(model: str) -> set:
    """e.g. {"completion", "tools", "vision", "thinking"}; empty if this Ollama is too old to say."""
    if model not in _caps:
        try:
            with _open("/api/show", {"model": model}, timeout=5) as r:
                _caps[model] = set(json.load(r).get("capabilities") or [])
        except Exception:
            return set()
    return _caps[model]


def status() -> str:
    """One line for the startup banner."""
    models = installed_models()
    if not models and not _reachable():
        return f"off (Ollama isn't running at {URL}; install it from ollama.com to add a free brain)"
    if MODEL not in models and f"{MODEL}:latest" not in models:
        have = f"; installed: {', '.join(models)}" if models else ""
        return f"on, but {MODEL} isn't downloaded (run: ollama pull {MODEL}{have})"
    return f"on via Ollama ({MODEL}), free, nothing sent to the cloud"


def _reachable() -> bool:
    try:
        with _open("/api/version", timeout=3):
            return True
    except Exception:
        return False


def tool_specs(anthropic_tools: list[dict]) -> list[dict]:
    return [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                              "parameters": t["input_schema"]}} for t in anthropic_tools]


def to_messages(history: list[dict], system: str, vision: bool) -> list[dict]:
    """Claude-style history -> Ollama chat messages. Attachments only reach models that can see."""
    out = [{"role": "system", "content": system}]
    for m in history[-MAX_TURNS:]:
        if isinstance(m["content"], str):
            out.append({"role": m["role"], "content": m["content"]})
            continue
        texts, images, skipped = [], [], 0
        for b in m["content"]:
            if b["type"] == "text":
                texts.append(b["text"])
            elif b["type"] == "image" and vision:
                images.append(b["source"]["data"])
            else:
                skipped += 1
        if skipped:
            texts.append(f"(The user attached {skipped} file{'s' if skipped != 1 else ''} that this on-device "
                         "model can't open. Say so if it matters.)")
        msg = {"role": m["role"], "content": "\n".join(texts)}
        if images:
            msg["images"] = images
        out.append(msg)
    return out


def _error_text(e: urllib.error.HTTPError, model: str) -> str:
    try:
        detail = json.loads(e.read().decode("utf-8", "replace")).get("error", "")
    except Exception:
        detail = ""
    if e.code == 404 or "not found" in detail:
        return f"The model {model} isn't downloaded. In PowerShell, run: ollama pull {model}"
    return f"The local model failed: {detail or e.reason}"


def stream_chat(model: str, messages: list[dict], specs: list[dict] | None):
    """Yield ("text", str) pieces as they arrive, then ("tool_calls", [...]) if the model called any."""
    body = {"model": model, "messages": messages, "stream": True, "options": {"num_ctx": NUM_CTX}}
    if specs:
        body["tools"] = specs
    if "thinking" in capabilities(model):
        body["think"] = False  # spoken replies should start right away
    try:
        resp = _open("/api/chat", body, timeout=300)  # the first call also loads the model into memory
    except urllib.error.HTTPError as e:
        text = _error_text(e, model)
        if specs and "does not support tools" in text:
            yield from stream_chat(model, messages, None)  # still chat, just without tools
            return
        raise LocalBrainError(text) from None
    except (urllib.error.URLError, OSError):
        raise LocalBrainError("I can't reach Ollama on this PC. Open the Ollama app, then try again.") from None

    calls, buf, past_think, started = [], "", False, False
    with resp:
        for line in resp:
            if not line.strip():
                continue
            chunk = json.loads(line)
            if chunk.get("error"):
                raise LocalBrainError(f"The local model failed: {chunk['error']}")
            msg = chunk.get("message") or {}
            calls.extend(msg.get("tool_calls") or [])
            piece = msg.get("content") or ""
            if piece and not past_think:
                # Older Ollama versions inline a thinking model's reasoning as <think>...</think>.
                buf += piece
                lead = buf.lstrip()
                if lead.startswith("<think>"):
                    end = lead.find("</think>")
                    if end < 0:
                        continue
                    piece, past_think = lead[end + len("</think>"):].lstrip(), True
                elif "<think>".startswith(lead):
                    continue  # could still become the tag
                else:
                    piece, past_think = buf, True
            if not started:
                piece = piece.lstrip()  # the reply opens with its mood tag, not a blank line
            if piece:
                started = True
                yield "text", piece
            if chunk.get("done"):
                break
    if not past_think and buf.strip() and not buf.lstrip().startswith("<think>"):
        yield "text", buf.lstrip()
    if calls:
        yield "tool_calls", calls
