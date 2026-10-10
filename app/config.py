"""Settings, read from the environment (.env in the project root)."""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _get(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


# Meta / WhatsApp Business Cloud API
WHATSAPP_TOKEN = _get("WHATSAPP_TOKEN")
WHATSAPP_PHONE_NUMBER_ID = _get("WHATSAPP_PHONE_NUMBER_ID")
WHATSAPP_VERIFY_TOKEN = _get("WHATSAPP_VERIFY_TOKEN")
META_APP_SECRET = _get("META_APP_SECRET")
GRAPH_API_VERSION = _get("GRAPH_API_VERSION", "v23.0")
# false: every template goes out as Meta's hello_world (test numbers) until yours are approved
WA_TEMPLATES_LIVE = _get("WA_TEMPLATES_LIVE", "false").lower() == "true"
# languages your templates are approved in; other guests get English templates
TEMPLATE_LANGS = {code.strip() for code in _get("TEMPLATE_LANGS", "en").split(",") if code.strip()}

# Groq (the SDK reads GROQ_API_KEY itself)
GIA_MODEL = _get("GIA_MODEL", "llama-3.3-70b-versatile")

# Demo behaviour
DEMO_BOOKING_ID = _get("DEMO_BOOKING_ID")  # attach unknown numbers to this booking
ADMIN_PASSWORD = _get("ADMIN_PASSWORD")
DRY_RUN = _get("DRY_RUN", "false").lower() == "true"  # log outbound WhatsApp instead of sending

# Mock OI ticketing: every ticket and handoff is emailed here (comma-separated for several), through Resend
TICKET_EMAIL_TO = _get("TICKET_EMAIL_TO", "hello@hostwithmira.com")
RESEND_API_KEY = _get("RESEND_API_KEY")  # empty: emails are logged instead of sent
RESEND_FROM = _get("RESEND_FROM")        # e.g. "Gia <gia@yourdomain.com>", on a domain verified in Resend

# Shared secret OI sends in the X-OI-Secret header on booking events
OI_WEBHOOK_SECRET = _get("OI_WEBHOOK_SECRET")

DB_PATH = Path(_get("DB_PATH", str(ROOT / "gia.db")))
DATA_DIR = ROOT / "app" / "data"
