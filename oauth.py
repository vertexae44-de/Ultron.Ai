"""Sign in with Google and Sign in with Apple (OpenID Connect, authorization code flow).

    /auth/google  ->  Google  ->  /auth/google/callback  (GET)
    /auth/apple   ->  Apple   ->  /auth/apple/callback   (POST form, Apple's "form_post")

Each flow carries a random state (tied to this browser by a short-lived cookie),
a nonce, and a PKCE verifier (Google). The ID token is fetched server-to-server
with our client secret and its signature is checked against the provider's
published keys, along with issuer, audience, expiry and nonce.

Google: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
Apple:  APPLE_CLIENT_ID (the Services ID), APPLE_TEAM_ID, APPLE_KEY_ID, and the
        .p8 key in APPLE_PRIVATE_KEY_FILE (or its text in APPLE_PRIVATE_KEY).
Both need the site's public address in ULTRON_PUBLIC_URL (Apple requires https).
"""

import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt

PUBLIC_URL = os.environ.get("ULTRON_PUBLIC_URL", "").rstrip("/")
STATE_COOKIE = "ultron_oauth"
STATE_TTL = 600  # seconds to finish signing in

PROVIDERS = {
    "google": {
        "client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
        "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
        "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "jwks": "https://www.googleapis.com/oauth2/v3/certs",
        "issuers": ("https://accounts.google.com", "accounts.google.com"),
        "scope": "openid email profile",
    },
    "apple": {
        "client_id": os.environ.get("APPLE_CLIENT_ID", ""),
        "team_id": os.environ.get("APPLE_TEAM_ID", ""),
        "key_id": os.environ.get("APPLE_KEY_ID", ""),
        "private_key": os.environ.get("APPLE_PRIVATE_KEY", ""),
        "private_key_file": os.environ.get("APPLE_PRIVATE_KEY_FILE", ""),
        "authorize": "https://appleid.apple.com/auth/authorize",
        "token": "https://appleid.apple.com/auth/token",
        "jwks": "https://appleid.apple.com/auth/keys",
        "issuers": ("https://appleid.apple.com",),
        "scope": "name email",
    },
}


class OAuthError(Exception):
    """Shown to the user as-is."""


def enabled(provider: str) -> bool:
    p = PROVIDERS.get(provider) or {}
    if provider == "google":
        return bool(p["client_id"] and p["client_secret"])
    if provider == "apple":
        return bool(p["client_id"] and p["team_id"] and p["key_id"] and (p["private_key"] or p["private_key_file"]))
    return False


def available() -> dict:
    return {name: enabled(name) for name in PROVIDERS}


# ---------- pending sign-ins ----------

_pending: dict[str, dict] = {}   # state -> {provider, nonce, verifier, browser, expires}
_lock = threading.Lock()


def _redirect_uri(provider: str, base_url: str) -> str:
    return f"{PUBLIC_URL or base_url}/auth/{provider}/callback"


def start(provider: str, base_url: str) -> tuple[str, str]:
    """Returns (URL to send the browser to, value for the state cookie)."""
    if not enabled(provider):
        raise OAuthError(f"Sign in with {provider.title()} isn't set up on this server.")
    p = PROVIDERS[provider]
    state, nonce, browser = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    with _lock:
        now = time.time()
        for s in [s for s, v in _pending.items() if v["expires"] < now]:
            del _pending[s]
        _pending[state] = {"provider": provider, "nonce": nonce, "verifier": verifier, "browser": browser, "expires": now + STATE_TTL}
    params = {
        "client_id": p["client_id"], "redirect_uri": _redirect_uri(provider, base_url), "response_type": "code",
        "scope": p["scope"], "state": state, "nonce": nonce,
    }
    if provider == "google":
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params.update(code_challenge=challenge, code_challenge_method="S256", prompt="select_account")
    else:
        params["response_mode"] = "form_post"   # Apple requires this when asking for name/email
    return f"{p['authorize']}?{urllib.parse.urlencode(params)}", browser


def finish(provider: str, params: dict, browser_cookie: str | None, base_url: str) -> dict:
    """Validate the provider's answer and return the verified identity:
    {"provider", "sub", "email", "email_verified", "name"}."""
    if params.get("error"):
        raise OAuthError("Sign-in was cancelled." if params["error"] in ("access_denied", "user_cancelled_authorize")
                         else f"{provider.title()} reported an error: {params['error']}")
    with _lock:
        pending = _pending.pop(params.get("state") or "", None)
    if not pending or pending["provider"] != provider or pending["expires"] < time.time():
        raise OAuthError("That sign-in link expired. Please try again.")
    if not browser_cookie or not secrets.compare_digest(browser_cookie, pending["browser"]):
        raise OAuthError("Sign-in was started in a different browser. Please try again.")
    code = params.get("code")
    if not code:
        raise OAuthError("No authorization code came back. Please try again.")

    p = PROVIDERS[provider]
    form = {"grant_type": "authorization_code", "code": code, "redirect_uri": _redirect_uri(provider, base_url), "client_id": p["client_id"]}
    if provider == "google":
        form.update(client_secret=p["client_secret"], code_verifier=pending["verifier"])
    else:
        form["client_secret"] = apple_client_secret()
    tokens = _post_form(p["token"], form)
    claims = verify_id_token(provider, tokens.get("id_token"), pending["nonce"])

    name = claims.get("name") or ""
    if provider == "apple" and params.get("user"):   # Apple sends the name once, on first sign-in only
        try:
            n = json.loads(params["user"]).get("name") or {}
            name = " ".join(x for x in (n.get("firstName"), n.get("lastName")) if x)
        except (ValueError, AttributeError):
            pass
    verified = claims.get("email_verified") in (True, "true")
    return {"provider": provider, "sub": claims["sub"], "email": claims.get("email") if verified else None,
            "email_verified": verified, "name": name}


# ---------- tokens ----------

_jwks_clients: dict[str, jwt.PyJWKClient] = {}


def verify_id_token(provider: str, id_token: str | None, nonce: str) -> dict:
    if not id_token:
        raise OAuthError(f"{provider.title()} didn't return an identity token.")
    p = PROVIDERS[provider]
    try:
        client = _jwks_clients.setdefault(provider, jwt.PyJWKClient(p["jwks"], cache_keys=True))
        key = client.get_signing_key_from_jwt(id_token).key
        claims = jwt.decode(id_token, key, algorithms=["RS256", "ES256"], audience=p["client_id"],
                            options={"require": ["iss", "sub", "aud", "exp", "iat"]}, leeway=60)
    except jwt.PyJWTError as e:
        raise OAuthError(f"Couldn't verify the {provider.title()} sign-in ({type(e).__name__}).") from e
    if claims.get("iss") not in p["issuers"]:
        raise OAuthError("The identity token came from an unexpected issuer.")
    if not claims.get("nonce") or not secrets.compare_digest(str(claims["nonce"]), nonce):
        raise OAuthError("The sign-in response didn't match this request. Please try again.")
    return claims


def apple_client_secret() -> str:
    """Apple wants a short-lived JWT signed with your .p8 key instead of a fixed secret."""
    p = PROVIDERS["apple"]
    key = p["private_key"]
    if not key:
        with open(p["private_key_file"], encoding="utf-8") as f:
            key = f.read()
    now = int(time.time())
    return jwt.encode({"iss": p["team_id"], "iat": now, "exp": now + 300, "aud": "https://appleid.apple.com", "sub": p["client_id"]},
                      key, algorithm="ES256", headers={"kid": p["key_id"]})


def _post_form(url: str, form: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.load(e).get("error", "")
        except ValueError:
            pass
        raise OAuthError(f"The sign-in provider rejected the request ({detail or e.code}). Check the client settings.") from e
    except (OSError, ValueError) as e:
        raise OAuthError("Couldn't reach the sign-in provider. Please try again.") from e
