"""Accounts: sign up, log in, sessions, plans, and what each plan may do.

Users and sessions are kept in JSON files under data/. Passwords are hashed
with scrypt and a per-user salt; sessions are random tokens in an HttpOnly
cookie. Everything a guest can't do is enforced by the server, not the page.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
USERS_FILE = DATA_DIR / "users.json"
SESSIONS_FILE = DATA_DIR / "sessions.json"
COOKIE = "ultron_session"
SESSION_DAYS = 30
SIGNUP_CODE = os.environ.get("ULTRON_SIGNUP_CODE", "")  # if set, sign-up requires it
SIGNUP_OPEN = os.environ.get("ULTRON_SIGNUP", "open") != "closed"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")

# Everyone gets full access -- every level, every model, no paid tier. The only thing an
# account is for is saving your chats and images across visits, since that needs somewhere to
# store them. "models" is "default" (the server's default model only), "all", or a list of ids.
#
# Image generation still has a per-account rate limit, but it's not a paywall: it's a plain
# cost-safety default, since each image is a real charge to whoever runs this server's OpenAI
# key. Raise or remove it with ULTRON_IMAGE_LIMIT (0 removes the limit entirely).
IMAGE_LIMIT = int(os.environ.get("ULTRON_IMAGE_LIMIT", "20"))
GUEST = {
    "plan": "guest", "max_effort": "max",
    "attachments": True, "images": False, "image_limit": 0, "saved_chats": False, "models": "all",
}
MEMBER = {
    "plan": "member", "max_effort": "max",
    "attachments": True, "images": True, "image_limit": IMAGE_LIMIT, "saved_chats": True, "models": "all",
}
EFFORTS = ("low", "medium", "high", "xhigh", "max")


def perms_for(user: dict | None) -> dict:
    return MEMBER if user else GUEST


def model_allowed(model: str, perms: dict, default: str) -> bool:
    allowed = perms["models"]
    return model == default or allowed == "all" or (isinstance(allowed, list) and model in allowed)


class AuthError(Exception):
    """Shown to the user as-is."""


def clamp_effort(effort: str | None, perms: dict) -> str | None:
    if effort not in EFFORTS:
        return None
    return EFFORTS[min(EFFORTS.index(effort), EFFORTS.index(perms["max_effort"]))]


class _JsonStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text())
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def save(self, data: dict):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)


_users = _JsonStore(USERS_FILE)
_sessions = _JsonStore(SESSIONS_FILE)
_failures: dict[str, list[float]] = {}  # "ip|username" -> recent failed login times
_fail_lock = threading.Lock()
MAX_FAILURES, FAIL_WINDOW = 5, 15 * 60


def _hash(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32).hex()


EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
RESET_TTL = 3600                 # a reset link works for an hour, once
RESET_PER_HOUR = 3               # reset emails per account per hour


def _clean_email(email) -> str | None:
    if not email:
        return None
    email = str(email).strip()
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise AuthError("That email address doesn't look right.")
    return email


def _email_taken(users: dict, email: str, except_id: str | None = None) -> bool:
    return any((u.get("email") or "").lower() == email.lower() and u["id"] != except_id for u in users.values())


def _check_password(password) -> str:
    if not isinstance(password, str) or len(password) < 8:
        raise AuthError("Password must be at least 8 characters.")
    if len(password) > 256:
        raise AuthError("Password is too long.")
    return password


def signup(username: str, password: str, name: str = "", code: str = "", email: str = "") -> dict:
    if not SIGNUP_OPEN:
        raise AuthError("Sign-up is closed on this server.")
    if SIGNUP_CODE and not hmac.compare_digest(str(code), SIGNUP_CODE):
        raise AuthError("That invite code isn't right.")
    if not isinstance(username, str) or not USERNAME_RE.match(username):
        raise AuthError("Username must be 3 to 32 letters, numbers, dots, dashes or underscores.")
    _check_password(password)
    email = _clean_email(email)
    key = username.lower()
    salt = secrets.token_bytes(16)
    user = {
        "id": secrets.token_hex(8),
        "username": username,
        "name": (name or username).strip()[:40] or username,
        "salt": salt.hex(),
        "hash": _hash(password, salt),
        "email": email,
        "created": time.time(),
    }
    with _users.lock:
        users = _users.load()
        if key in users:
            raise AuthError("That username is taken.")
        if email and _email_taken(users, email):
            raise AuthError("That email is already used by another account.")
        users[key] = user
        _users.save(users)
    return public(user)


def login(username: str, password: str, ip: str) -> dict:
    if not isinstance(username, str) or not isinstance(password, str):
        raise AuthError("Wrong username or password.")
    key = username.strip().lower()
    if "@" in key:                                   # logging in with an email address works too
        match = next((k for k, u in _users.load().items() if (u.get("email") or "").lower() == key), None)
        key = match or key
    throttle_key = f"{ip}|{key}"
    now = time.time()
    with _fail_lock:
        recent = [t for t in _failures.get(throttle_key, []) if now - t < FAIL_WINDOW]
        _failures[throttle_key] = recent
        if len(recent) >= MAX_FAILURES:
            raise AuthError("Too many attempts. Try again in 15 minutes.")
    user = _users.load().get(key)
    # Hash even for unknown users so response time doesn't reveal which names exist.
    has_password = bool(user and user.get("hash"))
    salt = bytes.fromhex(user["salt"]) if has_password else b"\0" * 16
    ok = hmac.compare_digest(_hash(password[:256], salt), user["hash"] if has_password else "0" * 64)
    if user and not has_password:
        via = " or ".join(p.title() for p in ("google", "apple") if user.get(f"{p}_sub"))
        raise AuthError(f"This account signs in with {via}. Use that button below.")
    if not (user and ok):
        with _fail_lock:
            _failures.setdefault(throttle_key, []).append(now)
        raise AuthError("Wrong username or password.")
    with _fail_lock:
        _failures.pop(throttle_key, None)
    return public(user)


def login_with_provider(identity: dict) -> dict:
    """Find or create the account for a verified Google/Apple identity."""
    field = f"{identity['provider']}_sub"
    with _users.lock:
        users = _users.load()
        for user in users.values():
            if user.get(field) == identity["sub"]:
                if identity.get("email") and user.get("email") != identity["email"]:
                    user["email"] = identity["email"]
                    _users.save(users)
                return public(user)
        if not SIGNUP_OPEN:
            raise AuthError("Sign-up is closed on this server.")
        if SIGNUP_CODE:
            raise AuthError("This server needs an invite code to join. Sign up with a username and password first.")
        email = identity.get("email") or ""
        base = re.sub(r"[^a-z0-9_.-]", "", (email.split("@")[0] or identity.get("name", "")).lower())[:24]
        if len(base) < 3:
            base = f"{identity['provider']}user"
        username = base
        while username.lower() in users:
            username = f"{base}{secrets.randbelow(9000) + 1000}"
        user = {
            "id": secrets.token_hex(8), "username": username,
            "name": (identity.get("name") or username).strip()[:40] or username,
            field: identity["sub"], "email": email or None, "created": time.time(),
        }
        users[username.lower()] = user
        _users.save(users)
    return public(user)


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    with _sessions.lock:
        now = time.time()
        sessions = {t: s for t, s in _sessions.load().items() if s.get("expires", 0) > now}
        sessions[token] = {"user_id": user_id, "expires": now + SESSION_DAYS * 86400}
        _sessions.save(sessions)
    return token


def end_all_sessions(user_id: str):
    with _sessions.lock:
        sessions = _sessions.load()
        kept = {t: s for t, s in sessions.items() if s.get("user_id") != user_id}
        if len(kept) != len(sessions):
            _sessions.save(kept)


def set_email(user_id: str, email: str, password: str = "") -> dict:
    """Add or change an account's email. Password accounts must confirm with their password."""
    email = _clean_email(email)
    with _users.lock:
        users = _users.load()
        user = next((u for u in users.values() if u["id"] == user_id), None)
        if not user:
            raise AuthError("Account not found.")
        if user.get("hash") and not hmac.compare_digest(_hash(str(password)[:256], bytes.fromhex(user["salt"])), user["hash"]):
            raise AuthError("Your current password isn't right.")
        if email and _email_taken(users, email, user_id):
            raise AuthError("That email is already used by another account.")
        user["email"] = email
        _users.save(users)
        return public(user)


def start_reset(login_name: str) -> tuple[dict, str] | None:
    """If an account with an email matches, returns (account, one-time token). Otherwise None.
    Only a hash of the token is stored, so a leaked users file can't be used to reset passwords."""
    q = str(login_name or "").strip().lower()
    if not q:
        return None
    with _users.lock:
        users = _users.load()
        user = users.get(q) or next((u for u in users.values() if (u.get("email") or "").lower() == q), None)
        if not user or not user.get("email"):
            return None
        now = time.time()
        recent = [t for t in user.get("reset_sent", []) if now - t < 3600]
        if len(recent) >= RESET_PER_HOUR:
            return None
        token = secrets.token_urlsafe(32)
        user.update(reset_hash=hashlib.sha256(token.encode()).hexdigest(), reset_expires=now + RESET_TTL, reset_sent=recent + [now])
        _users.save(users)
        return dict(user), token


def finish_reset(token: str, password: str) -> dict:
    """Set a new password from a reset link. Signs the account out everywhere else."""
    _check_password(password)
    digest = hashlib.sha256(str(token or "").encode()).hexdigest()
    with _users.lock:
        users = _users.load()
        user = next((u for u in users.values() if u.get("reset_hash") and hmac.compare_digest(u["reset_hash"], digest)), None)
        if not user or user.get("reset_expires", 0) < time.time():
            raise AuthError("This reset link has expired or was already used. Ask for a new one.")
        salt = secrets.token_bytes(16)
        user.update(salt=salt.hex(), hash=_hash(password, salt))
        for k in ("reset_hash", "reset_expires"):
            user.pop(k, None)
        _users.save(users)
    end_all_sessions(user["id"])
    with _fail_lock:                                  # a successful reset clears any lockout
        for k in [k for k in _failures if k.endswith("|" + user["username"].lower())]:
            _failures.pop(k, None)
    return public(user)


def end_session(token: str | None):
    if not token:
        return
    with _sessions.lock:
        sessions = _sessions.load()
        if sessions.pop(token, None) is not None:
            _sessions.save(sessions)


def user_for_token(token: str | None) -> dict | None:
    if not token:
        return None
    session = _sessions.load().get(token)
    if not session or session.get("expires", 0) < time.time():
        return None
    for user in _users.load().values():
        if user["id"] == session["user_id"]:
            return public(user)
    return None


def public(user: dict) -> dict:
    return {
        "id": user["id"], "username": user["username"], "name": user["name"],
        "email": user.get("email"), "has_password": bool(user.get("hash")),
        "via": "google" if user.get("google_sub") else "apple" if user.get("apple_sub") else "password",
    }


def get_record(user_id: str) -> dict | None:
    for user in _users.load().values():
        if user["id"] == user_id:
            return user
    return None


def find_record(**match) -> dict | None:
    for user in _users.load().values():
        if all(v and user.get(k) == v for k, v in match.items()):
            return user
    return None


def update_user(user_id: str, **fields):
    with _users.lock:
        users = _users.load()
        for user in users.values():
            if user["id"] == user_id:
                user.update(fields)
                _users.save(users)
                return


def cookie_header(token: str, secure: bool) -> str:
    return (f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS * 86400}"
            + ("; Secure" if secure else ""))


def clear_cookie_header(secure: bool) -> str:
    return f"{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + ("; Secure" if secure else "")
