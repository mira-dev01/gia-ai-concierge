"""Email through Resend's API, used to deliver mock-OI tickets to the ops inbox."""

import logging

import httpx

from . import config

log = logging.getLogger("gia.mailer")

RESEND_URL = "https://api.resend.com/emails"


class MailError(Exception):
    pass


def addresses(value: str) -> list[str]:
    """Split a comma-separated list of addresses, e.g. TICKET_EMAIL_TO."""
    return [a.strip() for a in value.split(",") if a.strip()]


async def send(to: str, cc: list[str], subject: str, body: str, idempotency_key: str | None = None) -> str:
    """Send one plain-text email to `to` (one address or a comma-separated list).

    Returns 'sent', or 'logged' when RESEND_API_KEY isn't set (or DRY_RUN); raises MailError on failure.

    The idempotency key makes Resend drop a repeat of the same email, e.g. a retry after a timeout
    on a request that actually went through.
    """
    if config.DRY_RUN or not config.RESEND_API_KEY:
        log.info("Email not sent (no RESEND_API_KEY, or DRY_RUN): to=%s cc=%s subject=%s", to, cc, subject)
        return "logged"
    if not config.RESEND_FROM:
        raise MailError("RESEND_FROM is not set")
    to_list = addresses(to)
    if not to_list:
        raise MailError("No recipient: set TICKET_EMAIL_TO")
    cc = [a for a in dict.fromkeys(cc) if a not in to_list]  # Resend rejects an address in both to and cc
    payload = {"from": config.RESEND_FROM, "to": to_list, "subject": subject, "text": body}
    if cc:
        payload["cc"] = cc
    headers = {"Authorization": f"Bearer {config.RESEND_API_KEY}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(RESEND_URL, json=payload, headers=headers)
    if r.status_code >= 400:
        raise MailError(f"Resend {r.status_code}: {r.text[:300]}")
    log.info("Email sent via Resend (id %s): %s", r.json().get("id"), subject)
    return "sent"
