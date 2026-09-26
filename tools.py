"""Tools Ultron can use: timers, weather, time, the code editor, and images.

Timers and the code editor live in the browser, so those tools don't keep
state here. They read what the browser reported with the request and return
`events` that the server forwards to the browser. Generated images are saved
under data/images and served by the server.
"""

import base64
import json
import os
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

HOME_LOCATION = os.environ.get("ULTRON_LOCATION", "").strip()
MAX_TIMER_SECONDS = 24 * 3600
MAX_TIMERS = 20
EFFORTS = ("low", "medium", "high", "xhigh", "max")
CODE_LANGS = ("python", "javascript", "html")
MAX_CODE_CHARS = 200_000

DATA_DIR = Path(__file__).parent / "data"
IMAGE_DIR = DATA_DIR / "images"
IMAGE_MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2")
IMAGE_QUALITY = os.environ.get("OPENAI_IMAGE_QUALITY", "medium")  # low | medium | high
IMAGE_WINDOW_HOURS = float(os.environ.get("ULTRON_IMAGE_WINDOW_HOURS", "5"))
IMAGE_SIZES = {"square": "1024x1024", "landscape": "1536x1024", "portrait": "1024x1536"}

TOOLS = [
    {
        "name": "set_timer",
        "description": (
            "Start a countdown timer in the user's browser. When it finishes, an alarm "
            "sounds and you announce it. Use for 'set a timer', 'remind me in N minutes'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "seconds": {"type": "integer", "description": "Duration in seconds (1 to 86400)."},
                "label": {"type": "string", "description": "Short name, e.g. 'pasta'. Optional."},
            },
            "required": ["seconds"],
        },
    },
    {
        "name": "list_timers",
        "description": "List the timers that are currently running, with time remaining.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "cancel_timer",
        "description": (
            "Cancel running timers. Pass the id from list_timers or set_timer, or all=true "
            "to cancel every timer. Call list_timers first if unsure which one the user means."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Timer id to cancel."},
                "all": {"type": "boolean", "description": "Cancel all timers."},
            },
        },
    },
    {
        "name": "get_weather",
        "description": (
            "Current conditions and a three-day forecast for a place. Leave location empty "
            "for the user's home location"
            + (f" ({HOME_LOCATION})." if HOME_LOCATION else "; if none is configured you'll get an error, so ask the user where they are.")
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City, optionally with region or country, e.g. 'Paris, France'."},
                "units": {"type": "string", "enum": ["metric", "imperial"], "description": "Defaults to the user's locale."},
            },
        },
    },
    {
        "name": "get_current_time",
        "description": "The user's current local date, time and time zone.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "write_code",
        "description": (
            "Put code into the user's code editor panel (it opens automatically), where they can "
            "read, edit and run it. Use this whenever the user asks you to write, fix, change or "
            "explain-by-example some code. Always send the complete program, not a fragment or diff. "
            "Python runs in the browser (Pyodide: standard library plus numpy, pandas, matplotlib and "
            "similar; no input(), no network). JavaScript runs in a worker with no DOM. HTML is shown "
            "as a live preview page."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "language": {"type": "string", "enum": list(CODE_LANGS)},
                "code": {"type": "string", "description": "The full source code."},
            },
            "required": ["language", "code"],
        },
    },
    {
        "name": "read_code_editor",
        "description": (
            "Read what's currently in the user's code editor, plus the output or error from their "
            "last run. Use it when the user refers to 'my code', asks why something fails, or asks "
            "you to improve what they wrote."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "create_animation",
        "description": (
            "Make an animation and play it for the user in the animation player, where they can replay it, "
            "go fullscreen, download it as HTML, record it as a video, or edit it. Its code also goes into "
            "the code editor, so to change an existing animation call read_code_editor first, then send the "
            "full updated page. Write ONE self-contained HTML file: no external files, libraries, fonts or "
            "network. Draw everything on a single <canvas> that fills the window and resizes with it, "
            "animated with requestAnimationFrame (this is what gets recorded as video). Loop seamlessly "
            "unless told otherwise. Dark background unless asked. Use for animations, motion graphics, "
            "animated scenes and cartoons, loaders, and animated data visualizations."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short name, e.g. 'Orbiting planets'."},
                "html": {"type": "string", "description": "The complete HTML document."},
                "seconds": {"type": "integer", "description": "Good video length in seconds (1-60). Defaults to 8."},
            },
            "required": ["title", "html"],
        },
    },
    {
        "name": "get_market_trends",
        "description": "Get today's top 3 trending cryptocurrencies and top 3 trending US stocks. Use it if the user asks what's trending, what's moving, or about the market in general.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "generate_image",
        "description": (
            f"Create an image from a text description and show it to the user. Each user has a small "
            f"allowance per {IMAGE_WINDOW_HOURS:g} hours, so only use it when the user asks for an image, "
            "and never generate more than one per request unless asked. Write a detailed prompt: "
            "subject, style, composition, lighting, colors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Detailed description of the image."},
                "shape": {"type": "string", "enum": list(IMAGE_SIZES), "description": "Defaults to square."},
            },
            "required": ["prompt"],
        },
    },
]
APP_ACTIONS = {
    "new_chat": "start a fresh chat",
    "show_home": "go to the home dashboard",
    "show_chat": "show the current conversation",
    "show_images": "open the image gallery",
    "open_code": "open the code editor",
    "close_code": "close the code editor",
    "run_code": "run (or preview) what's in the code editor",
    "stop_code": "stop running code",
    "open_chats": "open saved chats; value = optional search text",
    "open_chat": "open the saved chat whose title best matches value, or the latest if value is empty",
    "set_level": "set the thinking level; value = 1 to 5",
    "set_model": "switch model; value = opus-5, opus-5.5 or sonnet-5",
    "open_settings": "open settings",
    "log_in": "show the log-in screen",
    "sign_up": "show the sign-up screen",
    "log_out": "log the user out",
    "open_premium": "show the Premium plans",
    "wake_word": "value = on or off",
    "clap": "clap to wake; value = off, single or double",
    "follow_up": "listen for a reply after speaking without the wake word; value = on or off",
    "voice_output": "speak replies aloud; value = on or off",
    "close": "close whatever popup, drawer or panel is open",
    "show_voice_commands": "show the list of voice commands",
    "project": "open the hand-controlled 3D hologram viewer; value = a shape (cube, sphere, torus, "
               "cone, pyramid, cylinder, diamond, core), 'image' for the last generated image, or ANY "
               "other description (a car, a plane, a building, an interior, literally anything) -- that "
               "generates a picture of it and projects it as a depth card. Say plainly that a described "
               "object is a single realistic view you can turn slightly, not a full walk-around 3D model "
               "(there's no engine for that here). The user grows/shrinks it by spreading or pinching "
               "their hands and rotates it by moving their hand, in front of their camera.",
    "close_hologram": "close the hologram viewer",
}
TOOLS.append({
    "name": "control_app",
    "description": (
        "Operate the Ultron app on the user's screen. Use it whenever the user asks you to open, show, "
        "switch, change or turn something on or off in the app. Actions: "
        + "; ".join(f"{k}: {v}" for k, v in APP_ACTIONS.items())
        + ". Confirm in a few spoken words afterwards. Locked features (a level or model above the user's "
        "plan) show an upgrade screen instead; just say so."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(APP_ACTIONS)},
            "value": {"type": "string", "description": "Only for actions that take one."},
        },
        "required": ["action"],
    },
})
for _tool in TOOLS:
    _tool["eager_input_streaming"] = True  # inputs are validated in each handler


class ToolError(Exception):
    """A problem worth telling the model about (sent back with is_error)."""


class Context:
    """Per-request state reported by the browser, plus who is asking and events to send back."""

    def __init__(self, raw: dict | None, user: dict | None = None, perms: dict | None = None):
        raw = raw if isinstance(raw, dict) else {}
        self.user = user
        self.perms = perms or {"images": False}
        self.timezone = _valid_tz(raw.get("timezone"))
        try:  # minutes east of UTC; used if the zone name is unknown here
            self.utc_offset = max(-900, min(900, int(raw.get("utc_offset_minutes", 0))))
        except (TypeError, ValueError):
            self.utc_offset = 0
        self.locale = str(raw.get("locale") or "en-US")[:20]
        self.timers = _clean_timers(raw.get("timers"))
        self.effort = raw.get("effort") if raw.get("effort") in EFFORTS else None
        self.code = _clean_code(raw.get("code"))
        self.events: list[dict] = []

    @property
    def default_units(self) -> str:
        return "imperial" if self.locale in ("en-US", "en-LR", "my-MM") else "metric"


def run_tool(name: str, args, ctx: Context) -> str:
    """Run a tool and return a JSON string for the tool_result. Raises ToolError."""
    if not isinstance(args, dict):
        raise ToolError("Tool input must be an object.")
    handler = HANDLERS.get(name)
    if handler is None:
        raise ToolError(f"Unknown tool {name!r}.")
    return json.dumps(handler(args, ctx))


# ---------- timers ----------

def _set_timer(args, ctx):
    seconds = args.get("seconds")
    if isinstance(seconds, float) and seconds.is_integer():
        seconds = int(seconds)
    if not isinstance(seconds, int) or isinstance(seconds, bool) or not 1 <= seconds <= MAX_TIMER_SECONDS:
        raise ToolError("seconds must be a whole number from 1 to 86400.")
    if len(ctx.timers) >= MAX_TIMERS:
        raise ToolError(f"Too many timers running (max {MAX_TIMERS}). Cancel one first.")
    label = str(args.get("label") or "").strip()[:40]
    timer = {"id": "t" + uuid.uuid4().hex[:6], "label": label, "remaining_seconds": seconds}
    ctx.timers.append(timer)
    ctx.events.append({"type": "timer_set", "id": timer["id"], "label": label, "seconds": seconds})
    return {"started": timer, "duration": _say_duration(seconds)}


def _list_timers(args, ctx):
    return {
        "timers": [dict(t, remaining=_say_duration(t["remaining_seconds"])) for t in ctx.timers],
        "count": len(ctx.timers),
    }


def _cancel_timer(args, ctx):
    if args.get("all") is True:
        ids = [t["id"] for t in ctx.timers]
    else:
        tid = args.get("id")
        if not isinstance(tid, str) or not any(t["id"] == tid for t in ctx.timers):
            raise ToolError(f"No running timer with id {tid!r}. Running: {[t['id'] for t in ctx.timers]}")
        ids = [tid]
    ctx.timers = [t for t in ctx.timers if t["id"] not in ids]
    if ids:
        ctx.events.append({"type": "timer_cancel", "ids": ids})
    return {"cancelled": ids, "still_running": len(ctx.timers)}


def _clean_timers(raw) -> list[dict]:
    out = []
    for t in raw if isinstance(raw, list) else []:
        if not isinstance(t, dict) or not isinstance(t.get("id"), str):
            continue
        try:
            remaining = max(0, int(t.get("remaining_seconds", 0)))
        except (TypeError, ValueError):
            continue
        out.append({"id": t["id"][:12], "label": str(t.get("label") or "")[:40], "remaining_seconds": remaining})
    return out[:MAX_TIMERS]


def _say_duration(seconds: int) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    parts = [f"{n} {unit}{'s' if n != 1 else ''}" for n, unit in ((h, "hour"), (m, "minute"), (s, "second")) if n]
    return " ".join(parts) or "0 seconds"


# ---------- markets (CoinGecko + Yahoo Finance's public trending endpoints: no key needed) ----------

MARKETS_CACHE_SECONDS = 90
_markets_cache: dict = {"at": 0.0, "data": None}
_markets_lock = threading.Lock()


def _market_json(url: str, params: dict | None = None) -> dict:
    """Like _http_json, but with a browser user agent (Yahoo's endpoints reject the default one)
    and a plain error, since this isn't the weather service."""
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(full, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.load(resp)


def _fetch_trending_crypto() -> list[dict]:
    data = _market_json("https://api.coingecko.com/api/v3/search/trending")
    out = []
    for item in (data.get("coins") or [])[:3]:
        c = item.get("item") or {}
        price = ((c.get("data") or {}).get("price") or 0)
        change = ((c.get("data") or {}).get("price_change_percentage_24h") or {}).get("usd")
        out.append({
            "symbol": str(c.get("symbol") or "").upper(), "name": str(c.get("name") or ""),
            "price": round(float(price), 6) if price else None,
            "change_pct": round(float(change), 2) if change is not None else None,
        })
    return out


def _fetch_trending_stocks() -> list[dict]:
    trending = _market_json("https://query1.finance.yahoo.com/v1/finance/trending/US")
    symbols = [q["symbol"] for q in ((trending.get("finance") or {}).get("result") or [{}])[0].get("quotes", [])[:3]]
    if not symbols:
        return []
    quotes = _market_json("https://query1.finance.yahoo.com/v7/finance/quote", {"symbols": ",".join(symbols)})
    out = []
    for q in (quotes.get("quoteResponse") or {}).get("result", [])[:3]:
        out.append({
            "symbol": q.get("symbol", ""), "name": str(q.get("shortName") or q.get("symbol") or ""),
            "price": round(float(q["regularMarketPrice"]), 2) if q.get("regularMarketPrice") is not None else None,
            "change_pct": round(float(q["regularMarketChangePercent"]), 2) if q.get("regularMarketChangePercent") is not None else None,
        })
    return out


def market_trends() -> dict:
    """Top 3 trending crypto and top 3 trending US stocks, cached briefly so a burst of page
    loads doesn't hammer either API. Each half fails independently."""
    with _markets_lock:
        if _markets_cache["data"] is not None and time.time() - _markets_cache["at"] < MARKETS_CACHE_SECONDS:
            return _markets_cache["data"]
    out = {"crypto": [], "stocks": [], "errors": []}
    for key, fetch in (("crypto", _fetch_trending_crypto), ("stocks", _fetch_trending_stocks)):
        try:
            out[key] = fetch()
        except Exception as e:
            out["errors"].append(f"{key}: {e}")
    with _markets_lock:
        _markets_cache["at"], _markets_cache["data"] = time.time(), out
    return out


def _get_market_trends(args, ctx):
    return market_trends()


# ---------- time ----------

def _valid_tz(name) -> str | None:
    try:
        ZoneInfo(str(name))
        return str(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _get_current_time(args, ctx):
    if ctx.timezone:
        now, tz_name = datetime.now(ZoneInfo(ctx.timezone)), ctx.timezone
    else:
        now = datetime.now(timezone(timedelta(minutes=ctx.utc_offset)))
        tz_name = "UTC" + now.strftime("%z")
    return {"local_time": now.strftime("%A %d %B %Y, %H:%M"), "timezone": tz_name, "iso": now.isoformat(timespec="seconds")}


# ---------- weather (Open-Meteo: free, no API key) ----------

WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm with hail",
}


def _http_json(url: str, params: dict) -> dict:
    req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers={"User-Agent": "ultron-assistant"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.load(resp)
    except OSError as e:
        raise ToolError(f"Weather service unreachable: {e}") from e


def geocode(location: str) -> dict:
    """Resolve 'City' or 'City, Region/Country' to the best Open-Meteo match."""
    name, _, hint = (p.strip() for p in location.partition(","))
    if not name:
        raise ToolError("Empty location.")
    results = _http_json(
        "https://geocoding-api.open-meteo.com/v1/search", {"name": name, "count": 10, "language": "en"}
    ).get("results") or []
    if not results:
        raise ToolError(f"Couldn't find a place called {location!r}.")
    if hint:
        h = hint.lower()
        for r in results:
            if any(h in str(r.get(k, "")).lower() for k in ("country", "country_code", "admin1", "admin2")):
                return r
    return results[0]  # sorted by population/relevance


def _get_weather(args, ctx):
    location = str(args.get("location") or "").strip() or HOME_LOCATION
    if not location:
        raise ToolError("No location given and no home location configured (ULTRON_LOCATION). Ask the user where they are.")
    units = args.get("units") if args.get("units") in ("metric", "imperial") else ctx.default_units
    place = geocode(location[:100])
    imperial = units == "imperial"
    data = _http_json("https://api.open-meteo.com/v1/forecast", {
        "latitude": place["latitude"], "longitude": place["longitude"], "timezone": "auto", "forecast_days": 3,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh",
    })
    cur, daily = data.get("current") or {}, data.get("daily") or {}
    t_unit, w_unit = ("°F", "mph") if imperial else ("°C", "km/h")
    days = [
        {
            "date": d,
            "conditions": WEATHER_CODES.get(code, "unknown"),
            "high": f"{hi:.0f}{t_unit}", "low": f"{lo:.0f}{t_unit}",
            "chance_of_rain": f"{p}%" if p is not None else "unknown",
        }
        for d, code, hi, lo, p in zip(
            daily.get("time", []), daily.get("weather_code", []), daily.get("temperature_2m_max", []),
            daily.get("temperature_2m_min", []), daily.get("precipitation_probability_max", []),
        )
    ]
    return {
        "place": ", ".join(str(place[k]) for k in ("name", "admin1", "country") if place.get(k)),
        "now": {
            "conditions": WEATHER_CODES.get(cur.get("weather_code"), "unknown"),
            "temperature": f"{cur.get('temperature_2m', 0):.0f}{t_unit}",
            "feels_like": f"{cur.get('apparent_temperature', 0):.0f}{t_unit}",
            "humidity": f"{cur.get('relative_humidity_2m')}%",
            "wind": f"{cur.get('wind_speed_10m', 0):.0f} {w_unit}",
        },
        "forecast": days,
    }


# ---------- code editor ----------

def _clean_code(raw) -> dict | None:
    if not isinstance(raw, dict) or raw.get("language") not in CODE_LANGS or not isinstance(raw.get("code"), str):
        return None
    output = raw.get("output") if isinstance(raw.get("output"), str) else ""
    return {"language": raw["language"], "code": raw["code"][:MAX_CODE_CHARS], "output": output[-20_000:]}


def _write_code(args, ctx):
    lang, code = args.get("language"), args.get("code")
    if lang not in CODE_LANGS:
        raise ToolError(f"language must be one of {list(CODE_LANGS)}.")
    if not isinstance(code, str) or not code.strip():
        raise ToolError("code must be a non-empty string.")
    if len(code) > MAX_CODE_CHARS:
        raise ToolError(f"code is too long (max {MAX_CODE_CHARS} characters).")
    ctx.code = {"language": lang, "code": code, "output": ""}
    ctx.events.append({"type": "code", "language": lang, "code": code})
    return {"placed_in_editor": True, "language": lang, "lines": code.count("\n") + 1}


def _create_animation(args, ctx):
    title, html, seconds = args.get("title"), args.get("html"), args.get("seconds", 8)
    if not isinstance(html, str) or "<" not in html:
        raise ToolError("html must be a complete HTML document.")
    if len(html) > MAX_CODE_CHARS:
        raise ToolError(f"html is too long (max {MAX_CODE_CHARS} characters).")
    if not isinstance(seconds, int) or isinstance(seconds, bool) or not 1 <= seconds <= 60:
        seconds = 8
    title = str(title or "Animation").strip()[:80]
    ctx.code = {"language": "html", "code": html, "output": ""}
    ctx.events.append({"type": "animation", "title": title, "html": html, "seconds": seconds})
    return {"playing_for_user": True, "title": title, "also_in_code_editor": True}


def _read_code_editor(args, ctx):
    if not ctx.code or not ctx.code["code"].strip():
        return {"empty": True, "note": "The code editor is empty."}
    return {
        "language": ctx.code["language"],
        "code": ctx.code["code"],
        "last_run_output": ctx.code["output"] or "(not run yet, or no output)",
    }


# ---------- images (OpenAI) ----------

class ImageQuota:
    """At most `limit` images per rolling `window` seconds, persisted across restarts.
    The limit comes from the user's plan, so upgrading takes effect immediately."""

    def __init__(self, path: Path, window_s: float):
        self.path, self.window = path, window_s
        self.lock = threading.Lock()

    def _load(self, now: float) -> list[float]:
        try:
            stamps = [float(t) for t in json.loads(self.path.read_text())]
        except (OSError, ValueError, TypeError):
            stamps = []
        return sorted(t for t in stamps if 0 <= now - t < self.window)

    def _save(self, stamps: list[float]):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(stamps))
        tmp.replace(self.path)

    def reserve(self, limit: int, upgrade_hint: str = "") -> float:
        """Claim a slot or raise ToolError saying when the next one frees up."""
        with self.lock:
            now = time.time()
            stamps = self._load(now)
            if len(stamps) >= limit:
                wait = stamps[len(stamps) - limit] + self.window - now
                raise ToolError(
                    f"Image limit reached: {limit} per {self.window / 3600:g} hours. "
                    f"The next image is available in {_say_wait(wait)}. Tell the user.{upgrade_hint}"
                )
            self._save(stamps + [now])
            return now

    def release(self, stamp: float):
        """Give a slot back (the generation failed)."""
        with self.lock:
            now = time.time()
            self._save([t for t in self._load(now) if t != stamp])

    def remaining(self, limit: int) -> int:
        with self.lock:
            return max(0, limit - len(self._load(time.time())))


_quotas: dict[str, ImageQuota] = {}
_quotas_lock = threading.Lock()


def quota_for(user_id: str) -> ImageQuota:
    """Each account gets its own allowance."""
    with _quotas_lock:
        if user_id not in _quotas:
            _quotas[user_id] = ImageQuota(DATA_DIR / "quota" / f"{user_id}.json", IMAGE_WINDOW_HOURS * 3600)
        return _quotas[user_id]


def image_path(user_id: str, image_id: str) -> Path:
    return IMAGE_DIR / user_id / f"{image_id}.png"


def list_images(user_id: str) -> list[dict]:
    """A user's generated images, newest first."""
    out = []
    for png in (IMAGE_DIR / user_id).glob("*.png") if (IMAGE_DIR / user_id).exists() else []:
        try:
            meta = json.loads(png.with_suffix(".json").read_text())
        except (OSError, ValueError):
            meta = {"prompt": "", "created": png.stat().st_mtime}
        out.append({"url": f"/generated/{png.stem}.png", "prompt": meta.get("prompt", ""), "created": meta.get("created", 0)})
    return sorted(out, key=lambda i: i["created"], reverse=True)[:200]


_openai_client = None


def images_enabled() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


def _openai():
    global _openai_client
    if not images_enabled():
        raise ToolError("Image generation isn't set up: the server needs OPENAI_API_KEY. Tell the user.")
    if _openai_client is None:
        try:
            import openai
        except ImportError as e:
            raise ToolError("The openai package isn't installed (pip install -r requirements.txt).") from e
        _openai_client = openai.OpenAI(timeout=180, max_retries=1)
    return _openai_client


def create_image(prompt: str, shape: str, ctx) -> dict:
    """The actual OpenAI call, quota and file handling. Shared by the generate_image tool and
    the direct /api/hologram/project endpoint (projecting a described object doesn't go through
    a chat turn, so it needs a plain function to call, not just a tool)."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise ToolError("prompt must be a non-empty string.")
    if shape not in IMAGE_SIZES:
        raise ToolError(f"shape must be one of {list(IMAGE_SIZES)}.")
    if not ctx.perms.get("images") or not ctx.user:
        raise ToolError("Image generation needs an account. Tell the user they can sign up or log in "
                        "(top right) to create images.")
    client = _openai()
    import openai

    quota, limit = quota_for(ctx.user["id"]), ctx.perms.get("image_limit", 0)
    hint = " Mention that Premium raises the limit." if ctx.perms.get("plan") == "free" else ""
    stamp = quota.reserve(limit, hint)
    try:
        resp = client.images.generate(
            model=IMAGE_MODEL, prompt=prompt.strip()[:4000], size=IMAGE_SIZES[shape], quality=IMAGE_QUALITY, n=1
        )
        b64 = resp.data[0].b64_json if resp.data else None
        if not b64:
            raise ToolError("The image service returned no image.")
    except ToolError:
        quota.release(stamp)
        raise
    except openai.BadRequestError as e:
        quota.release(stamp)
        if "moderation" in str(e).lower() or "safety" in str(e).lower():
            raise ToolError("The image service declined this prompt under its content policy.") from e
        raise ToolError(f"The image request was rejected: {e.message}") from e
    except openai.AuthenticationError as e:
        quota.release(stamp)
        raise ToolError("The OpenAI API key was rejected. Tell the user to check OPENAI_API_KEY.") from e
    except openai.RateLimitError as e:
        quota.release(stamp)
        raise ToolError("OpenAI is rate limiting or the account is out of credit. Try again later.") from e
    except openai.OpenAIError as e:
        quota.release(stamp)
        raise ToolError(f"Image generation failed: {e}") from e

    image_id = uuid.uuid4().hex[:12]
    path = image_path(ctx.user["id"], image_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(b64))
    path.with_suffix(".json").write_text(json.dumps({"prompt": prompt.strip()[:500], "created": time.time()}))
    return {"image_id": image_id, "url": f"/generated/{image_id}.png", "images_left": quota.remaining(limit)}


def _generate_image(args, ctx):
    prompt, shape = args.get("prompt"), args.get("shape") or "square"
    result = create_image(prompt, shape, ctx)
    ctx.events.append({"type": "image", "url": result["url"], "prompt": prompt.strip()[:300], "left": result["images_left"]})
    return {
        "image_id": result["image_id"],
        "shown_to_user": True,
        "images_left": result["images_left"],
        "limit": f"{ctx.perms.get('image_limit', 0)} per {IMAGE_WINDOW_HOURS:g} hours",
    }


def _say_wait(seconds: float) -> str:
    seconds = max(60, int(seconds))
    return _say_duration(seconds - seconds % 60 if seconds >= 3600 else seconds - seconds % 60 or 60)


def _control_app(args, ctx):
    action = args.get("action")
    if action not in APP_ACTIONS:
        raise ToolError(f"Unknown action. Use one of: {', '.join(APP_ACTIONS)}.")
    value = str(args.get("value") or "").strip()[:200]
    ctx.events.append({"type": "app", "action": action, "value": value})
    return {"done": True, "action": action, "value": value}


HANDLERS = {
    "control_app": _control_app,
    "get_market_trends": _get_market_trends,
    "set_timer": _set_timer,
    "list_timers": _list_timers,
    "cancel_timer": _cancel_timer,
    "get_weather": _get_weather,
    "get_current_time": _get_current_time,
    "write_code": _write_code,
    "create_animation": _create_animation,
    "read_code_editor": _read_code_editor,
    "generate_image": _generate_image,
}
