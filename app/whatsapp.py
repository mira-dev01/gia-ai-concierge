"""Thin client for the WhatsApp Business Cloud API (Meta Graph API)."""

import hashlib
import hmac
import logging

import httpx

from . import config

log = logging.getLogger("gia.whatsapp")

MAX_TEXT = 4096  # WhatsApp text message limit


def _url() -> str:
    return f"https://graph.facebook.com/{config.GRAPH_API_VERSION}/{config.WHATSAPP_PHONE_NUMBER_ID}/messages"


async def _post(payload: dict) -> dict:
    if config.DRY_RUN or not config.WHATSAPP_TOKEN:
        log.info("DRY_RUN send: %s", payload)
        return {"dry_run": True}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(_url(), json=payload,
                              headers={"Authorization": f"Bearer {config.WHATSAPP_TOKEN}"})
    if r.status_code >= 400:
        log.error("WhatsApp API error %s: %s", r.status_code, r.text)
    return r.json()


async def send_text(to: str, body: str) -> None:
    for start in range(0, len(body), MAX_TEXT):
        await _post({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {"preview_url": False, "body": body[start:start + MAX_TEXT]},
        })


async def send_template(to: str, name: str, lang: str, body_params: list[str] | None = None) -> dict:
    template: dict = {"name": name, "language": {"code": lang}}
    if body_params:
        template["components"] = [{
            "type": "body",
            "parameters": [{"type": "text", "text": p} for p in body_params],
        }]
    return await _post({"messaging_product": "whatsapp", "to": to, "type": "template", "template": template})


async def mark_read(message_id: str) -> None:
    await _post({"messaging_product": "whatsapp", "status": "read", "message_id": message_id})


def signature_ok(raw_body: bytes, header: str | None) -> bool:
    """Check Meta's X-Hub-Signature-256 header. Skipped (with a warning) when no app secret is set."""
    if not config.META_APP_SECRET:
        log.warning("META_APP_SECRET not set; skipping webhook signature check")
        return True
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(config.META_APP_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))
