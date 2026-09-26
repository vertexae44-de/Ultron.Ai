"""Premium subscriptions with Stripe.

Flow: the browser asks for a Checkout link, the user pays on Stripe's hosted
page, and Stripe tells us about it two ways: the user comes back to
/?billing=success&session_id=... (we look the session up right away), and a
signed webhook arrives (renewals, cancellations and failed payments keep
flowing in this way). Card details never touch this server.

Set STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET for webhooks). Create the
product and prices once with: python setup_stripe.py
"""

import os
import threading
import time

import auth

SECRET = os.environ.get("STRIPE_SECRET_KEY", "")
WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
PUBLIC_URL = os.environ.get("ULTRON_PUBLIC_URL", "").rstrip("/")
LOOKUP_KEYS = {"monthly": "ultron_premium_monthly", "yearly": "ultron_premium_yearly"}
PRICE_IDS = {"monthly": os.environ.get("STRIPE_PRICE_MONTHLY", ""), "yearly": os.environ.get("STRIPE_PRICE_YEARLY", "")}
PRICE_CACHE_SECONDS = 3600
REFRESH_SECONDS = 3600  # at most one "is this subscription still active?" check per user per hour


class BillingError(Exception):
    """Shown to the user as-is."""


_client = None
_prices = {"at": 0.0, "data": {}}
_prices_lock = threading.Lock()


def enabled() -> bool:
    return bool(SECRET)


def client():
    global _client
    if _client is None:
        from stripe import StripeClient
        _client = StripeClient(SECRET, max_network_retries=2)
    return _client


def _stripe():
    import stripe
    return stripe


# ---------- prices ----------

def prices() -> dict:
    """{"monthly": {...}, "yearly": {...}} from Stripe, cached for an hour."""
    with _prices_lock:
        if time.time() - _prices["at"] < PRICE_CACHE_SECONDS and _prices["data"]:
            return _prices["data"]
        found = {}
        try:
            for plan, pid in PRICE_IDS.items():
                if pid:
                    found[plan] = client().v1.prices.retrieve(pid).to_dict()
            missing = [p for p in LOOKUP_KEYS if p not in found]
            if missing:
                listed = client().v1.prices.list(params={"lookup_keys": [LOOKUP_KEYS[p] for p in missing], "active": True})
                for price in listed.data:
                    price = price.to_dict()
                    for plan in missing:
                        if price.get("lookup_key") == LOOKUP_KEYS[plan]:
                            found[plan] = price
        except _stripe().StripeError as e:
            print(f"Stripe: couldn't load prices ({e.user_message or e}). Run setup_stripe.py?")
            return _prices["data"]
        _prices.update(at=time.time(), data=found)
        return found


def _money(amount: int, currency: str) -> str:
    symbol = {"usd": "$", "eur": "€", "gbp": "£", "inr": "₹", "jpy": "¥"}.get(currency.lower(), "")
    value = amount if currency.lower() in ("jpy", "krw") else amount / 100
    text = f"{value:,.0f}" if float(value).is_integer() and currency.lower() in ("jpy", "krw") else f"{value:,.2f}"
    return f"{symbol}{text}" if symbol else f"{text} {currency.upper()}"


def plans_for_page() -> list[dict]:
    p = prices()
    out = []
    for plan in ("monthly", "yearly"):
        price = p.get(plan)
        if not price:
            continue
        item = {"id": plan, "price": _money(price["unit_amount"], price["currency"]),
                "interval": (price.get("recurring") or {}).get("interval", "month")}
        if plan == "yearly" and p.get("monthly"):
            full = p["monthly"]["unit_amount"] * 12
            if full > price["unit_amount"]:
                item["save"] = f"Save {round(100 * (full - price['unit_amount']) / full)}%"
        out.append(item)
    return out


# ---------- checkout and portal ----------

def _customer_for(user: dict) -> str:
    if user.get("stripe_customer"):
        return user["stripe_customer"]
    customer = client().v1.customers.create(params={
        "name": user["name"], "metadata": {"ultron_user_id": user["id"], "username": user["username"]},
    })
    auth.update_user(user["id"], stripe_customer=customer.id)
    return customer.id


def checkout_url(user_id: str, plan: str, base_url: str) -> str:
    user = auth.get_record(user_id)
    if not user:
        raise BillingError("Log in first.")
    if auth.plan_of(user) == "premium":
        raise BillingError("You're already Premium. Use “Manage subscription” to change plans.")
    price = prices().get(plan)
    if not price:
        raise BillingError("That plan isn't available right now.")
    base = PUBLIC_URL or base_url
    try:
        session = client().v1.checkout.sessions.create(params={
            "mode": "subscription",
            "customer": _customer_for(user),
            "client_reference_id": user["id"],
            "line_items": [{"price": price["id"], "quantity": 1}],
            "subscription_data": {"metadata": {"ultron_user_id": user["id"]}},
            "allow_promotion_codes": True,
            "success_url": f"{base}/?billing=success&session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{base}/?billing=cancel",
        })
    except _stripe().StripeError as e:
        raise BillingError(f"Stripe couldn't start checkout: {e.user_message or 'please try again'}") from e
    return session.url


def portal_url(user_id: str, base_url: str) -> str:
    user = auth.get_record(user_id)
    if not user or not user.get("stripe_customer"):
        raise BillingError("There's no subscription on this account yet.")
    try:
        session = client().v1.billing_portal.sessions.create(params={
            "customer": user["stripe_customer"], "return_url": f"{PUBLIC_URL or base_url}/",
        })
    except _stripe().StripeError as e:
        raise BillingError(f"Stripe couldn't open the billing page: {e.user_message or 'please try again'}") from e
    return session.url


# ---------- keeping the plan in sync ----------

def apply_subscription(sub: dict, user_id: str | None = None) -> str | None:
    """Store a subscription's state on its user. Returns the user id, if found."""
    user_id = user_id or (sub.get("metadata") or {}).get("ultron_user_id")
    customer = sub.get("customer")
    customer = customer.get("id") if isinstance(customer, dict) else customer
    user = auth.get_record(user_id) if user_id else auth.find_record(stripe_customer=customer)
    if not user:
        return None
    items = (sub.get("items") or {}).get("data") or [{}]
    item = items[0]
    auth.update_user(
        user["id"],
        stripe_customer=customer or user.get("stripe_customer"),
        sub_id=sub.get("id"),
        sub_status=sub.get("status"),
        sub_period_end=item.get("current_period_end") or sub.get("current_period_end"),
        sub_cancel_at_period_end=bool(sub.get("cancel_at_period_end") or sub.get("cancel_at")),
        sub_interval=((item.get("price") or {}).get("recurring") or {}).get("interval"),
        sub_checked=time.time(),
    )
    return user["id"]


def sync_checkout(user_id: str, session_id: str) -> str:
    """Called when the browser returns from Checkout, so Premium starts immediately."""
    if not isinstance(session_id, str) or not session_id.startswith("cs_"):
        raise BillingError("Unknown checkout session.")
    try:
        session = client().v1.checkout.sessions.retrieve(session_id, params={"expand": ["subscription"]}).to_dict()
    except _stripe().StripeError as e:
        raise BillingError("Couldn't confirm the payment with Stripe yet. It will update shortly.") from e
    if session.get("client_reference_id") != user_id:
        raise BillingError("That checkout belongs to a different account.")
    sub = session.get("subscription")
    if session.get("status") == "complete" and isinstance(sub, dict):
        apply_subscription(sub, user_id)
    return auth.plan_of(auth.get_record(user_id))


def handle_webhook(payload: bytes, signature: str | None) -> str:
    """Verify and apply a Stripe event. Raises ValueError / SignatureVerificationError if forged."""
    if not WEBHOOK_SECRET:
        raise BillingError("STRIPE_WEBHOOK_SECRET isn't set.")
    event = client().construct_event(payload, signature, WEBHOOK_SECRET).to_dict()
    kind, obj = event["type"], event["data"]["object"]
    if kind == "checkout.session.completed" and obj.get("mode") == "subscription" and obj.get("subscription"):
        sub = client().v1.subscriptions.retrieve(obj["subscription"]).to_dict()
        apply_subscription(sub, obj.get("client_reference_id"))
    elif kind.startswith("customer.subscription."):
        apply_subscription(obj)
    return kind


def refresh_if_stale(user_id: str):
    """If a paid period has ended without word from a webhook, ask Stripe directly."""
    if not enabled():
        return
    user = auth.get_record(user_id)
    if not user or not user.get("sub_id"):
        return
    now = time.time()
    if (user.get("sub_period_end") or 0) > now or now - (user.get("sub_checked") or 0) < REFRESH_SECONDS:
        return
    try:
        apply_subscription(client().v1.subscriptions.retrieve(user["sub_id"]).to_dict(), user["id"])
    except _stripe().StripeError:
        auth.update_user(user["id"], sub_checked=now)
