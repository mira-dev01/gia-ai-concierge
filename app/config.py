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
WELCOME_TEMPLATE = _get("WELCOME_TEMPLATE", "hello_world")
WELCOME_TEMPLATE_LANG = _get("WELCOME_TEMPLATE_LANG", "en_US")

# Claude (the SDK reads ANTHROPIC_API_KEY itself)
GIA_MODEL = _get("GIA_MODEL", "claude-opus-5-5")
GIA_EFFORT = _get("GIA_EFFORT", "low")

# Demo behaviour
DEMO_BOOKING_ID = _get("DEMO_BOOKING_ID")  # attach unknown numbers to this booking
ADMIN_PASSWORD = _get("ADMIN_PASSWORD")
DRY_RUN = _get("DRY_RUN", "false").lower() == "true"  # log outbound WhatsApp instead of sending

DB_PATH = Path(_get("DB_PATH", str(ROOT / "gia.db")))
DATA_DIR = ROOT / "app" / "data"
