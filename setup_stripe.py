"""Create Ultron's Premium product and prices in your Stripe account (run once).

    STRIPE_SECRET_KEY=sk_test_... python setup_stripe.py
    STRIPE_SECRET_KEY=sk_test_... python setup_stripe.py --monthly 5 --yearly 45 --currency usd

Prices get lookup keys, so the server finds them without any price IDs in its
config. Running it again is safe: existing prices are left alone. Use a test
key (sk_test_...) first; switch to your live key when you're ready to charge.
"""

import argparse
import sys

import billing


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--monthly", type=float, default=5.00, help="monthly price (default 5.00)")
    parser.add_argument("--yearly", type=float, default=45.00, help="yearly price (default 45.00)")
    parser.add_argument("--currency", default="usd", help="three-letter currency code (default usd)")
    args = parser.parse_args()
    if not billing.enabled():
        sys.exit("Set STRIPE_SECRET_KEY first (from dashboard.stripe.com > Developers > API keys).")
    mode = "LIVE" if billing.SECRET.startswith(("sk_live", "rk_live")) else "test"
    print(f"Stripe {mode} mode")

    client = billing.client()
    listed = client.v1.prices.list(params={"lookup_keys": list(billing.LOOKUP_KEYS.values()), "active": True}).data
    existing = {p.lookup_key: p for p in listed if p.lookup_key in billing.LOOKUP_KEYS.values()}
    todo = {plan: key for plan, key in billing.LOOKUP_KEYS.items() if key not in existing}
    for key, price in existing.items():
        print(f"  {key}: already exists ({price.id}, {price.unit_amount / 100:.2f} {price.currency.upper()})")
    if todo:
        product = client.v1.products.create(params={
            "name": "Ultron AI Premium",
            "description": "More images, Genius and Max levels, and the newest models.",
            "metadata": {"app": "ultron"},
        })
        amounts = {"monthly": (args.monthly, "month"), "yearly": (args.yearly, "year")}
        for plan, key in todo.items():
            amount, interval = amounts[plan]
            price = client.v1.prices.create(params={
                "product": product.id,
                "currency": args.currency.lower(),
                "unit_amount": round(amount * 100),
                "recurring": {"interval": interval},
                "lookup_key": key,
                "transfer_lookup_key": True,
                "nickname": f"Premium ({plan})",
            })
            print(f"  {key}: created {price.id} ({amount:.2f} {args.currency.upper()} per {interval})")

    print("""
Next steps:
  1. Customer portal (lets people cancel or switch plans): in the Stripe dashboard open
     Settings > Billing > Customer portal and press Save once.
  2. Webhooks keep Premium in sync with renewals and cancellations.
     Local testing:  stripe listen --forward-to localhost:8765/api/stripe/webhook
                     (it prints a whsec_... secret)
     Production:     add an endpoint https://YOUR-DOMAIN/api/stripe/webhook in the dashboard
                     with the events checkout.session.completed and customer.subscription.*
  3. Start Ultron with STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET set.""")


if __name__ == "__main__":
    main()
