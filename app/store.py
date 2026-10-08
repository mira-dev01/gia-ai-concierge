"""SQLite stand-in for OI: bookings, villa capabilities, tickets, preferences, conversations, audit log."""

import json
import sqlite3
from datetime import datetime, timedelta, timezone

from . import config

IST = timezone(timedelta(hours=5, minutes=30))

# Placeholder SLAs per severity (the BRD leaves these as an open question).
SLA_MINUTES = {"urgent": 15, "high": 60, "medium": 180, "low": 720}

_villas = {v["villa_id"]: v for v in json.loads((config.DATA_DIR / "villas.json").read_text())["villas"]}
_bookings = json.loads((config.DATA_DIR / "bookings.json").read_text())["bookings"]


def now() -> datetime:
    return datetime.now(IST)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                phone TEXT PRIMARY KEY, booking_id TEXT, messages TEXT NOT NULL, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS transcript (
                id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, booking_id TEXT,
                direction TEXT, body TEXT, at TEXT);
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT, villa_id TEXT, phone TEXT,
                category TEXT, severity TEXT, summary TEXT, details TEXT, status TEXT,
                assignee TEXT, created_at TEXT, due_at TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS preferences (
                id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT, guest_name TEXT,
                category TEXT, preference TEXT, source_quote TEXT, at TEXT);
            CREATE TABLE IF NOT EXISTS guest_details (
                booking_id TEXT PRIMARY KEY, details TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS handoffs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT, phone TEXT,
                reason TEXT, urgency TEXT, status TEXT, at TEXT);
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, booking_id TEXT,
                action TEXT, tier TEXT, data TEXT);
            CREATE TABLE IF NOT EXISTS seen_messages (id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS pending_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, note TEXT);
            """
        )


# ---- bookings and villas (read-only) ----

def find_booking(phone: str) -> dict | None:
    for b in _bookings:
        if b["guest_phone"] == phone:
            return b
    if config.DEMO_BOOKING_ID:
        return get_booking(config.DEMO_BOOKING_ID)
    return None


def get_booking(booking_id: str) -> dict | None:
    return next((b for b in _bookings if b["booking_id"] == booking_id), None)


def all_bookings() -> list[dict]:
    return _bookings


def get_villa(villa_id: str) -> dict | None:
    return _villas.get(villa_id)


# ---- dedupe of Meta webhook retries ----

def first_time_seen(message_id: str) -> bool:
    with _db() as c:
        try:
            c.execute("INSERT INTO seen_messages (id) VALUES (?)", (message_id,))
            return True
        except sqlite3.IntegrityError:
            return False


# ---- conversation state (Claude message history, append-only) ----

def load_history(phone: str) -> list:
    with _db() as c:
        row = c.execute("SELECT messages FROM conversations WHERE phone = ?", (phone,)).fetchone()
    return json.loads(row["messages"]) if row else []


def save_history(phone: str, booking_id: str | None, messages: list) -> None:
    with _db() as c:
        c.execute(
            "INSERT INTO conversations (phone, booking_id, messages, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(phone) DO UPDATE SET booking_id = excluded.booking_id, "
            "messages = excluded.messages, updated_at = excluded.updated_at",
            (phone, booking_id, json.dumps(messages), now().isoformat()),
        )


def reset_history(phone: str) -> None:
    with _db() as c:
        c.execute("DELETE FROM conversations WHERE phone = ?", (phone,))


def log_message(phone: str, booking_id: str | None, direction: str, body: str) -> None:
    with _db() as c:
        c.execute(
            "INSERT INTO transcript (phone, booking_id, direction, body, at) VALUES (?, ?, ?, ?, ?)",
            (phone, booking_id, direction, body, now().isoformat()),
        )


def transcript(limit: int = 200) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM transcript ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in reversed(rows)]


# ---- audit (NFR-04) ----

def audit(booking_id: str | None, action: str, tier: str, data: dict) -> None:
    with _db() as c:
        c.execute(
            "INSERT INTO audit (at, booking_id, action, tier, data) VALUES (?, ?, ?, ?, ?)",
            (now().isoformat(), booking_id, action, tier, json.dumps(data, ensure_ascii=False)),
        )


def audit_log(limit: int = 100) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---- tickets (UC-OPS-05/06) ----

ASSIGNEE_BY_CATEGORY = {
    "service": "Ops agent / service provider",
    "reservation": "Ops agent / service provider",
    "housekeeping": "Villa housekeeping team",
    "maintenance": "Villa maintenance team",
    "complaint": "Villa manager",
}


def create_ticket(booking: dict, phone: str, category: str, severity: str, summary: str, details: str) -> dict:
    created = now()
    due = created + timedelta(minutes=SLA_MINUTES.get(severity, 180))
    with _db() as c:
        cur = c.execute(
            "INSERT INTO tickets (booking_id, villa_id, phone, category, severity, summary, details, status, "
            "assignee, created_at, due_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
            (booking["booking_id"], booking["villa_id"], phone, category, severity, summary, details,
             ASSIGNEE_BY_CATEGORY.get(category, "Ops agent"), created.isoformat(), due.isoformat(),
             created.isoformat()),
        )
        ticket_id = cur.lastrowid
    return get_ticket(ticket_id)


def get_ticket(ticket_id: int) -> dict | None:
    with _db() as c:
        row = c.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
    return _ticket_view(row) if row else None


def tickets_for_booking(booking_id: str) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM tickets WHERE booking_id = ? ORDER BY id", (booking_id,)).fetchall()
    return [_ticket_view(r) for r in rows]


def all_tickets() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM tickets ORDER BY id DESC").fetchall()
    return [_ticket_view(r) for r in rows]


def set_ticket_status(ticket_id: int, status: str) -> dict | None:
    with _db() as c:
        c.execute("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?",
                  (status, now().isoformat(), ticket_id))
    return get_ticket(ticket_id)


def _ticket_view(row: sqlite3.Row) -> dict:
    t = dict(row)
    t["ref"] = f"OI-{t['id']:05d}"
    return t


# ---- guest profile: preferences (UC-OPS-09) and arrival details (UC-OPS-02) ----

def add_preference(booking: dict, category: str, preference: str, source_quote: str) -> None:
    with _db() as c:
        c.execute(
            "INSERT INTO preferences (booking_id, guest_name, category, preference, source_quote, at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (booking["booking_id"], booking["guest_name"], category, preference, source_quote, now().isoformat()),
        )


def all_preferences() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM preferences ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


def update_guest_details(booking_id: str, fields: dict) -> dict:
    with _db() as c:
        row = c.execute("SELECT details FROM guest_details WHERE booking_id = ?", (booking_id,)).fetchone()
        merged = json.loads(row["details"]) if row else {}
        merged.update({k: v for k, v in fields.items() if v not in (None, "", [])})
        c.execute(
            "INSERT INTO guest_details (booking_id, details, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(booking_id) DO UPDATE SET details = excluded.details, updated_at = excluded.updated_at",
            (booking_id, json.dumps(merged, ensure_ascii=False), now().isoformat()),
        )
    return merged


def guest_details(booking_id: str) -> dict:
    with _db() as c:
        row = c.execute("SELECT details FROM guest_details WHERE booking_id = ?", (booking_id,)).fetchone()
    return json.loads(row["details"]) if row else {}


# ---- human handoff (UC-OPS-10) ----

def create_handoff(booking_id: str | None, phone: str, reason: str, urgency: str) -> int:
    with _db() as c:
        cur = c.execute(
            "INSERT INTO handoffs (booking_id, phone, reason, urgency, status, at) VALUES (?, ?, ?, ?, 'waiting', ?)",
            (booking_id, phone, reason, urgency, now().isoformat()),
        )
        return cur.lastrowid


def all_handoffs() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM handoffs ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


# ---- notes for Gia about things that happened outside the chat (sent with the guest's next message) ----

def add_note(phone: str, note: str) -> None:
    with _db() as c:
        c.execute("INSERT INTO pending_notes (phone, note) VALUES (?, ?)", (phone, note))


def pop_notes(phone: str) -> list[str]:
    with _db() as c:
        rows = c.execute("SELECT id, note FROM pending_notes WHERE phone = ? ORDER BY id", (phone,)).fetchall()
        c.execute("DELETE FROM pending_notes WHERE phone = ?", (phone,))
    return [r["note"] for r in rows]
