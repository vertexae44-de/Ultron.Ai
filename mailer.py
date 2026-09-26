"""Sending email (password resets) over SMTP.

Works with any SMTP service: Gmail or Outlook (with an app password), SendGrid,
Mailgun, Amazon SES, Resend, Postmark, or a local test inbox like Mailpit.

    SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD,
    SMTP_FROM ("Ultron AI <no-reply@example.com>"),
    SMTP_SECURITY: starttls (default) | ssl (usually port 465) | none (local test servers only)

With ULTRON_MAIL_TO_CONSOLE=1 and no SMTP_HOST, emails are printed to the
terminal instead, which is handy while developing.
"""

import os
import smtplib
import ssl
import threading
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, parseaddr

HOST = os.environ.get("SMTP_HOST", "")
PORT = int(os.environ.get("SMTP_PORT", "0") or 0)
USER = os.environ.get("SMTP_USER", "")
PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SECURITY = os.environ.get("SMTP_SECURITY", "starttls").lower()
FROM = os.environ.get("SMTP_FROM", "") or (f"Ultron AI <{USER}>" if "@" in USER else "")
TO_CONSOLE = os.environ.get("ULTRON_MAIL_TO_CONSOLE") == "1"


def enabled() -> bool:
    return bool(HOST and FROM) or TO_CONSOLE


def send(to: str, subject: str, text: str, html: str | None = None):
    msg = EmailMessage()
    name, addr = parseaddr(FROM or "Ultron AI <ultron@localhost>")
    msg["From"] = formataddr((name or "Ultron AI", addr))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=addr.split("@")[-1] or "localhost")
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    if not HOST:
        print(f"\n----- email to {to} -----\nSubject: {subject}\n\n{text}\n-----------------------\n", flush=True)
        return
    port = PORT or (465 if SECURITY == "ssl" else 587 if SECURITY == "starttls" else 25)
    context = ssl.create_default_context()
    if SECURITY == "ssl":
        server = smtplib.SMTP_SSL(HOST, port, context=context, timeout=20)
    else:
        server = smtplib.SMTP(HOST, port, timeout=20)
    with server:
        if SECURITY == "starttls":
            server.starttls(context=context)
        if USER:
            server.login(USER, PASSWORD)
        server.send_message(msg)


def send_later(to: str, subject: str, text: str, html: str | None = None):
    """Send in the background, so a response never takes longer when an account exists."""
    def run():
        try:
            send(to, subject, text, html)
        except Exception as e:  # never crash the server over email; say what went wrong
            print(f"Email to {to} failed: {type(e).__name__}: {e}", flush=True)
    threading.Thread(target=run, daemon=True).start()
