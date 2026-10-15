"""Stand-in for OI: bookings, villa capabilities and staff, tickets, preferences, conversations, the UC-OPS-01
journey, the ticket email outbox and the audit log.

Stored in Postgres when DATABASE_URL is set (Neon in production), otherwise in a local SQLite file at DB_PATH.
The SQL is written once with ? placeholders and works on both."""

import atexit
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from . import config

IST = timezone(timedelta(hours=5, minutes=30))

# Placeholder SLAs per severity (the BRD leaves these as an open question).
SLA_MINUTES = {"urgent": 15, "high": 60, "medium": 180, "low": 720}

_villas = {v["villa_id"]: v for v in json.loads((config.DATA_DIR / "villas.json").read_text())["villas"]}
_seed_bookings = json.loads((config.DATA_DIR / "bookings.json").read_text())["bookings"]


def now() -> datetime:
    return datetime.now(IST).replace(microsecond=0)


class _Conn:
    """One transaction on either database: execute() takes ? placeholders, insert() returns the new row's id."""

    def __init__(self, raw, postgres: bool):
        self.raw, self.postgres = raw, postgres

    def execute(self, sql: str, params=()):
        return self.raw.execute(sql.replace("?", "%s") if self.postgres else sql, params)

    def insert(self, sql: str, params=()) -> int:
        if self.postgres:
            return self.execute(sql + " RETURNING id", params).fetchone()["id"]
        return self.execute(sql, params).lastrowid


_pool = None


def _postgres_pool():
    global _pool
    if _pool is None:
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool
        # prepare_threshold=None: Neon's pooled endpoint (PgBouncer, transaction mode) can't keep prepared
        # statements. check: Neon suspends idle computes, so test each connection before handing it out.
        _pool = ConnectionPool(config.DATABASE_URL, min_size=1, max_size=10, open=True,
                               kwargs={"row_factory": dict_row, "prepare_threshold": None},
                               check=ConnectionPool.check_connection)
        atexit.register(close)
    return _pool


def close() -> None:
    """Close the Postgres pool (at shutdown), so its worker threads stop cleanly."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def _db():
    """A transaction: committed when the block ends, rolled back if it raises."""
    if config.DATABASE_URL:
        with _postgres_pool().connection() as raw:
            yield _Conn(raw, postgres=True)
        return
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    raw = sqlite3.connect(config.DB_PATH)
    raw.row_factory = sqlite3.Row
    try:
        with raw:
            yield _Conn(raw, postgres=False)
    finally:
        raw.close()


def init() -> None:
    with _db() as c:
        schema = (
            """
            CREATE TABLE IF NOT EXISTS bookings (
                booking_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS conversations (
                phone TEXT PRIMARY KEY, booking_id TEXT, messages TEXT NOT NULL, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS transcript (
                id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, booking_id TEXT,
                direction TEXT, body TEXT, at TEXT);
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT, villa_id TEXT, phone TEXT,
                category TEXT, severity TEXT, summary TEXT, details TEXT, status TEXT,
                assignee TEXT, created_at TEXT, due_at TEXT, updated_at TEXT, source TEXT);
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
            CREATE TABLE IF NOT EXISTS journey_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, step TEXT NOT NULL,
                due_at TEXT, status TEXT NOT NULL, channel TEXT, template TEXT, wa_message_id TEXT,
                attempts INTEGER NOT NULL DEFAULT 0, note TEXT, sent_at TEXT, delivered_at TEXT,
                read_at TEXT, updated_at TEXT, UNIQUE (booking_id, step));
            CREATE INDEX IF NOT EXISTS journey_steps_wamid ON journey_steps (wa_message_id);
            CREATE TABLE IF NOT EXISTS villa_settings (
                villa_id TEXT, use_case TEXT, settings TEXT, updated_at TEXT, PRIMARY KEY (villa_id, use_case));
            CREATE TABLE IF NOT EXISTS staff (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, email TEXT, created_at TEXT);
            CREATE TABLE IF NOT EXISTS villa_staff (
                villa_id TEXT, role TEXT, staff_id INTEGER, PRIMARY KEY (villa_id, role));
            CREATE TABLE IF NOT EXISTS outbox_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, to_addr TEXT, cc TEXT,
                subject TEXT, body TEXT, status TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
                created_at TEXT, sent_at TEXT);
            CREATE TABLE IF NOT EXISTS takeovers (
                phone TEXT PRIMARY KEY, booking_id TEXT, at TEXT);
            CREATE TABLE IF NOT EXISTS operator_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL, ticket_ref TEXT,
                direction TEXT NOT NULL, body TEXT, at TEXT);
            """
        )
        if c.postgres:
            c.raw.execute(schema.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY"))
        else:
            c.raw.executescript(schema)
        # Columns added after the first release, for databases created before them.
        _add_column(c, "tickets", "source", "TEXT")  # UC-OPS-01
        _add_column(c, "tickets", "operator_id", "INTEGER")  # ops console: the field operator who owns it
        _add_column(c, "tickets", "resolved_at", "TEXT")
        _add_column(c, "tickets", "resolved_by", "TEXT")
        _add_column(c, "staff", "presence", "TEXT NOT NULL DEFAULT 'onsite'")
        _add_column(c, "tickets", "escalated_at", "TEXT")  # escalation is a flag, independent of the status
        _add_column(c, "tickets", "escalation_reason", "TEXT")
        _add_column(c, "tickets", "resolution_note", "TEXT")
        # Delivery of messages sent to the guest: pending, sent, delivered, read, failed, or not_sent (DRY_RUN).
        # Empty for the guest's own messages and for chats simulated in the console.
        _add_column(c, "transcript", "status", "TEXT")
        _add_column(c, "transcript", "wa_message_id", "TEXT")
        _add_column(c, "transcript", "error", "TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS transcript_booking ON transcript (booking_id)")
        c.execute("CREATE INDEX IF NOT EXISTS transcript_wamid ON transcript (wa_message_id)")
        c.execute("CREATE INDEX IF NOT EXISTS audit_booking ON audit (booking_id)")
        # Sample bookings count as confirmed the first time the service sees them. An edit to bookings.json
        # is applied on the next start; otherwise changes made by OI events are kept.
        for b in _seed_bookings:
            seed = json.dumps(b, sort_keys=True, ensure_ascii=False)
            row = c.execute("SELECT data FROM bookings WHERE booking_id = ?", (b["booking_id"],)).fetchone()
            stored = json.loads(row["data"]) if row else None
            if stored and stored.get("_seed") == seed:
                continue
            merged = {"confirmed_at": now().isoformat(), **(stored or {}), **b, "_seed": seed}
            c.execute("INSERT INTO bookings (booking_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(booking_id) "
                      "DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                      (b["booking_id"], json.dumps(merged, ensure_ascii=False), now().isoformat()))


def _add_column(c: _Conn, table: str, column: str, kind: str) -> None:
    if c.postgres:
        c.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {kind}")
    elif column not in {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}:
        c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")


def _table_exists(c: _Conn, table: str) -> bool:
    if c.postgres:
        return c.execute("SELECT to_regclass(?) IS NOT NULL AS ok", (table,)).fetchone()["ok"]
    return c.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone() is not None


# ---- bookings (written by OI booking events) and villas (read-only) ----

def all_bookings() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT data FROM bookings ORDER BY booking_id").fetchall()
    return [json.loads(r["data"]) for r in rows]


def bookings_updated_at() -> str | None:
    """When OI last changed a booking here: the freshness of every occupancy and arrival the console shows."""
    with _db() as c:
        return c.execute("SELECT MAX(updated_at) AS at FROM bookings").fetchone()["at"]


def get_booking(booking_id: str) -> dict | None:
    with _db() as c:
        row = c.execute("SELECT data FROM bookings WHERE booking_id = ?", (booking_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def upsert_booking(booking: dict) -> None:
    with _db() as c:
        c.execute(
            "INSERT INTO bookings (booking_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(booking_id) "
            "DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (booking["booking_id"], json.dumps(booking, ensure_ascii=False), now().isoformat()),
        )


def find_booking(phone: str) -> dict | None:
    """The booking a guest's message is about: in-stay first, then the next upcoming stay, then the latest."""
    mine = sorted((b for b in all_bookings() if b["guest_phone"] == phone),
                  key=lambda b: b["check_in"], reverse=True)
    if mine:
        today = now().date().isoformat()

        def rank(b: dict) -> tuple:
            if b["status"] == "in_stay":
                return (0, "")
            if b["status"] == "confirmed" and b["check_out"] >= today:
                return (1, b["check_in"])
            return (2, "")
        return min(mine, key=rank)
    if config.DEMO_BOOKING_ID:
        return get_booking(config.DEMO_BOOKING_ID)
    return None


def get_villa(villa_id: str) -> dict | None:
    return _villas.get(villa_id)


def all_villas() -> list[dict]:
    return list(_villas.values())


# ---- dedupe of Meta webhook retries ----

def first_time_seen(message_id: str) -> bool:
    with _db() as c:
        return c.execute("INSERT INTO seen_messages (id) VALUES (?) ON CONFLICT (id) DO NOTHING", (message_id,)).rowcount == 1


# ---- conversation state (Groq message history, append-only) ----

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


def log_message(phone: str, booking_id: str | None, direction: str, body: str, status: str | None = None,
                wa_message_id: str | None = None) -> int:
    with _db() as c:
        return c.insert(
            "INSERT INTO transcript (phone, booking_id, direction, body, at, status, wa_message_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (phone, booking_id, direction, body, now().isoformat(), status, wa_message_id),
        )


def set_message_status(message_id: int, status: str, wa_message_id: str | None = None,
                       error: str | None = None) -> None:
    with _db() as c:
        c.execute("UPDATE transcript SET status = ?, wa_message_id = COALESCE(?, wa_message_id), error = ? "
                  "WHERE id = ?", (status, wa_message_id, error, message_id))


def message_receipt(wa_message_id: str, status: str, error: str | None = None) -> None:
    """A WhatsApp delivery receipt for a logged message. Receipts only move a message forward
    (sent -> delivered -> read); a failure overrides whatever came before."""
    if not wa_message_id:
        return
    earlier = {"delivered": ("pending", "sent"), "read": ("pending", "sent", "delivered")}.get(status)
    with _db() as c:
        if status == "failed":
            c.execute("UPDATE transcript SET status = 'failed', error = ? WHERE wa_message_id = ?",
                      (error, wa_message_id))
        elif earlier:
            c.execute(f"UPDATE transcript SET status = ? WHERE wa_message_id = ? AND status IN "
                      f"({', '.join('?' * len(earlier))})", (status, wa_message_id, *earlier))


def messages_for_booking(booking_id: str, limit: int) -> tuple[list[dict], int]:
    """The booking's latest messages (oldest first) and how many it has in all."""
    with _db() as c:
        rows = c.execute("SELECT * FROM transcript WHERE booking_id = ? ORDER BY id DESC LIMIT ?",
                         (booking_id, limit)).fetchall()
        total = c.execute("SELECT COUNT(*) AS n FROM transcript WHERE booking_id = ?", (booking_id,)).fetchone()["n"]
    return [dict(r) for r in reversed(rows)], total


def message_counts(booking_ids: list[str]) -> dict[str, dict]:
    """{booking_id: {"count", "last_at"}} for the bookings that have messages."""
    if not booking_ids:
        return {}
    with _db() as c:
        rows = c.execute(f"SELECT booking_id, COUNT(*) AS n, MAX(at) AS last_at FROM transcript WHERE booking_id IN "
                         f"({', '.join('?' * len(booking_ids))}) GROUP BY booking_id", tuple(booking_ids)).fetchall()
    return {r["booking_id"]: {"count": r["n"], "last_at": r["last_at"]} for r in rows}


def last_inbound_by_booking() -> dict[str, str]:
    with _db() as c:
        rows = c.execute("SELECT booking_id, MAX(at) AS at FROM transcript WHERE direction = 'in' "
                         "AND booking_id IS NOT NULL GROUP BY booking_id").fetchall()
    return {r["booking_id"]: r["at"] for r in rows}


def last_outbound_status_by_booking() -> dict[str, str | None]:
    """Delivery status of the latest message sent to each booking's guest (by Gia or by ops)."""
    with _db() as c:
        rows = c.execute("SELECT booking_id, status FROM transcript WHERE id IN (SELECT MAX(id) FROM transcript "
                         "WHERE direction IN ('out', 'ops') AND booking_id IS NOT NULL GROUP BY booking_id)").fetchall()
    return {r["booking_id"]: r["status"] for r in rows}


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


def audit_for_bookings(booking_ids: list[str], limit: int = 100) -> list[dict]:
    """Audit entries for these bookings, newest first."""
    if not booking_ids:
        return []
    with _db() as c:
        rows = c.execute(f"SELECT * FROM audit WHERE booking_id IN ({', '.join('?' * len(booking_ids))}) "
                         "ORDER BY id DESC LIMIT ?", (*booking_ids, limit)).fetchall()
    return [dict(r) for r in rows]


# ---- tickets (UC-OPS-05/06) ----

ASSIGNEE_BY_CATEGORY = {
    "service": "Ops agent / service provider",
    "reservation": "Ops agent / service provider",
    "housekeeping": "Villa housekeeping team",
    "maintenance": "Villa maintenance team",
    "complaint": "Villa manager",
}


def create_ticket(booking: dict, phone: str, category: str, severity: str, summary: str, details: str,
                  source: str = "guest", assignee: str | None = None, operator_id: int | None = None) -> dict:
    """source 'guest' is a guest's own request (status changes are messaged to them); anything else is internal."""
    created = now()
    due = created + timedelta(minutes=SLA_MINUTES.get(severity, 180))
    with _db() as c:
        ticket_id = c.insert(
            "INSERT INTO tickets (booking_id, villa_id, phone, category, severity, summary, details, status, "
            "assignee, created_at, due_at, updated_at, source, operator_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)",
            (booking["booking_id"], booking["villa_id"], phone, category, severity, summary, details,
             assignee or ASSIGNEE_BY_CATEGORY.get(category, "Ops agent"), created.isoformat(), due.isoformat(),
             created.isoformat(), source, operator_id),
        )
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


def set_ticket_status(ticket_id: int, status: str, by: str | None = None, note: str | None = None) -> dict | None:
    """Closing records when, by whom and how it was resolved (the resolve time is created_at to resolved_at);
    reopening clears all three. Closing also ends an escalation."""
    at = now().isoformat()
    with _db() as c:
        if status == "closed":
            c.execute("UPDATE tickets SET status = ?, updated_at = ?, resolved_at = COALESCE(resolved_at, ?), "
                      "resolved_by = COALESCE(resolved_by, ?), resolution_note = COALESCE(?, resolution_note), "
                      "escalated_at = NULL WHERE id = ?", (status, at, at, by, note, ticket_id))
        else:
            c.execute("UPDATE tickets SET status = ?, updated_at = ?, resolved_at = NULL, resolved_by = NULL, "
                      "resolution_note = NULL WHERE id = ?", (status, at, ticket_id))
    return get_ticket(ticket_id)


def set_ticket_escalation(ticket_id: int, on: bool, reason: str | None) -> dict | None:
    at = now().isoformat()
    with _db() as c:
        c.execute("UPDATE tickets SET escalated_at = ?, escalation_reason = ?, updated_at = ? WHERE id = ?",
                  (at if on else None, reason if on else None, at, ticket_id))
    return get_ticket(ticket_id)


def assign_ticket(ticket_id: int, operator_id: int | None, assignee: str) -> dict | None:
    with _db() as c:
        c.execute("UPDATE tickets SET operator_id = ?, assignee = ?, updated_at = ? WHERE id = ?",
                  (operator_id, assignee, now().isoformat(), ticket_id))
    return get_ticket(ticket_id)


def tickets_for_operator(staff_id: int) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM tickets WHERE operator_id = ? ORDER BY id", (staff_id,)).fetchall()
    return [_ticket_view(r) for r in rows]


def open_tickets_for_operator(staff_id: int) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM tickets WHERE operator_id = ? AND status != 'closed' ORDER BY id",
                         (staff_id,)).fetchall()
    return [_ticket_view(r) for r in rows]


def ticket_by_ref(ref: str) -> dict | None:
    digits = "".join(ch for ch in ref if ch.isdigit())
    return get_ticket(int(digits)) if digits else None


def _ticket_view(row) -> dict:
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
        return c.insert(
            "INSERT INTO handoffs (booking_id, phone, reason, urgency, status, at) VALUES (?, ?, ?, ?, 'waiting', ?)",
            (booking_id, phone, reason, urgency, now().isoformat()),
        )


def all_handoffs() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM handoffs ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


def set_handoff_status(handoff_id: int, status: str) -> dict | None:
    with _db() as c:
        c.execute("UPDATE handoffs SET status = ? WHERE id = ?", (status, handoff_id))
        row = c.execute("SELECT * FROM handoffs WHERE id = ?", (handoff_id,)).fetchone()
    return dict(row) if row else None


# ---- ops takeover: a person is replying to the guest, so Gia stays quiet until they hand back ----

def set_takeover(phone: str, booking_id: str | None, on: bool) -> None:
    with _db() as c:
        if on:
            c.execute("INSERT INTO takeovers (phone, booking_id, at) VALUES (?, ?, ?) ON CONFLICT(phone) DO NOTHING",
                      (phone, booking_id, now().isoformat()))
        else:
            c.execute("DELETE FROM takeovers WHERE phone = ?", (phone,))


def takeover_active(phone: str) -> bool:
    with _db() as c:
        return c.execute("SELECT 1 FROM takeovers WHERE phone = ?", (phone,)).fetchone() is not None


def takeover_phones() -> set[str]:
    with _db() as c:
        return {r["phone"] for r in c.execute("SELECT phone FROM takeovers").fetchall()}


# ---- notes for Gia about things that happened outside the chat (sent with the guest's next message) ----

def add_note(phone: str, note: str) -> None:
    with _db() as c:
        c.execute("INSERT INTO pending_notes (phone, note) VALUES (?, ?)", (phone, note))


def pop_notes(phone: str) -> list[str]:
    with _db() as c:
        rows = c.execute("SELECT id, note FROM pending_notes WHERE phone = ? ORDER BY id", (phone,)).fetchall()
        c.execute("DELETE FROM pending_notes WHERE phone = ?", (phone,))
    return [r["note"] for r in rows]


# ---- per-guest transcript lookups (ticket context, no-reply rules, WhatsApp's 24-hour window) ----

def transcript_for(phone: str, limit: int = 20) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM transcript WHERE phone = ? ORDER BY id DESC LIMIT ?",
                         (phone, limit)).fetchall()
    return [dict(r) for r in reversed(rows)]


def booking_record(booking_id: str) -> dict:
    """Everything logged against one booking: messages, tickets, handoffs, preferences and the audit trail."""
    with _db() as c:
        q = lambda sql: [dict(r) for r in c.execute(sql, (booking_id,)).fetchall()]  # noqa: E731
        return {
            "messages": q("SELECT * FROM transcript WHERE booking_id = ? ORDER BY id"),
            "tickets": [_ticket_view(r) for r in c.execute(
                "SELECT * FROM tickets WHERE booking_id = ? ORDER BY id", (booking_id,)).fetchall()],
            "handoffs": q("SELECT * FROM handoffs WHERE booking_id = ? ORDER BY id"),
            "preferences": q("SELECT * FROM preferences WHERE booking_id = ? ORDER BY id"),
            "audit": q("SELECT * FROM audit WHERE booking_id = ? ORDER BY id DESC"),
        }


def guest_replied_since(phone: str, since_iso: str) -> bool:
    with _db() as c:
        row = c.execute(
            "SELECT 1 FROM transcript WHERE phone = ? AND direction = 'in' AND at > ? LIMIT 1",
            (phone, since_iso),
        ).fetchone()
    return row is not None


def last_inbound_at(phone: str) -> str | None:
    with _db() as c:
        row = c.execute("SELECT MAX(at) AS at FROM transcript WHERE phone = ? AND direction = 'in'",
                        (phone,)).fetchone()
    return row["at"]


# ---- UC-OPS-01 journey: one row per booking per step ----
# status: scheduled -> sent -> delivered -> read, or failed / skipped / cancelled

SENT_STATUSES = ("sent", "delivered", "read")
_STEP_FIELDS = ("due_at", "status", "channel", "template", "wa_message_id", "note", "sent_at",
                "delivered_at", "read_at")


def add_step(booking_id: str, step: str, due_at: str, status: str = "scheduled", note: str | None = None,
             sent_at: str | None = None) -> None:
    """Create a step unless the booking already has it."""
    with _db() as c:
        c.execute(
            "INSERT INTO journey_steps (booking_id, step, due_at, status, note, sent_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (booking_id, step) DO NOTHING",
            (booking_id, step, due_at, status, note, sent_at, now().isoformat()),
        )


def delete_steps(booking_id: str, status: str) -> None:
    """Drop a booking's steps in one status, e.g. the cancelled ones when the booking is confirmed again."""
    with _db() as c:
        c.execute("DELETE FROM journey_steps WHERE booking_id = ? AND status = ?", (booking_id, status))


def legacy_schedule(booking_id: str) -> dict:
    """What the pre-upgrade concierge_schedule table recorded as sent, so an existing database isn't re-sent."""
    with _db() as c:
        if not _table_exists(c, "concierge_schedule"):
            return {}  # a database created after the upgrade has no such table
        row = c.execute("SELECT * FROM concierge_schedule WHERE booking_id = ?", (booking_id,)).fetchone()
    return dict(row) if row else {}


def steps_for_booking(booking_id: str) -> dict[str, dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM journey_steps WHERE booking_id = ?", (booking_id,)).fetchall()
    return {r["step"]: dict(r) for r in rows}


def all_steps() -> dict[str, dict[str, dict]]:
    with _db() as c:
        rows = c.execute("SELECT * FROM journey_steps").fetchall()
    out: dict[str, dict[str, dict]] = {}
    for r in rows:
        out.setdefault(r["booking_id"], {})[r["step"]] = dict(r)
    return out


def scheduled_steps() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM journey_steps WHERE status = 'scheduled' ORDER BY due_at, id").fetchall()
    return [dict(r) for r in rows]


def claim_step(step_id: int) -> bool:
    """Mark a scheduled step as sent before sending it, so two runs can never both send it."""
    with _db() as c:
        return c.execute(
            "UPDATE journey_steps SET status = 'sent', sent_at = ?, attempts = attempts + 1, updated_at = ? "
            "WHERE id = ? AND status = 'scheduled'",
            (now().isoformat(), now().isoformat(), step_id),
        ).rowcount == 1


def update_step(step_id: int, **fields) -> None:
    unknown = set(fields) - set(_STEP_FIELDS)
    if unknown:
        raise ValueError(f"Unknown journey step fields: {unknown}")
    sets = ", ".join(f"{k} = ?" for k in fields)
    with _db() as c:
        c.execute(f"UPDATE journey_steps SET {sets}, updated_at = ? WHERE id = ?",
                  (*fields.values(), now().isoformat(), step_id))


def step_by_message_id(wa_message_id: str) -> dict | None:
    with _db() as c:
        row = c.execute("SELECT * FROM journey_steps WHERE wa_message_id = ?", (wa_message_id,)).fetchone()
    return dict(row) if row else None


# ---- per-villa settings for each use case (only the villa's overrides are stored) ----

def villa_settings(villa_id: str, use_case: str) -> dict:
    with _db() as c:
        row = c.execute("SELECT settings FROM villa_settings WHERE villa_id = ? AND use_case = ?",
                        (villa_id, use_case)).fetchone()
    return json.loads(row["settings"]) if row else {}


def update_villa_settings(villa_ids: list[str], use_case: str, changes: dict) -> None:
    for villa_id in villa_ids:
        merged = {**villa_settings(villa_id, use_case), **changes}
        with _db() as c:
            c.execute(
                "INSERT INTO villa_settings (villa_id, use_case, settings, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(villa_id, use_case) DO UPDATE SET settings = excluded.settings, "
                "updated_at = excluded.updated_at",
                (villa_id, use_case, json.dumps(merged), now().isoformat()),
            )


# ---- villa staff: caretakers and managers (UC-OPS-01), plus the field operators tickets go to ----

STAFF_ROLES = ("caretaker", "manager")
OPERATOR_ROLES = ("caretaker", "maintenance", "housekeeping", "manager")
PRESENCE = ("onsite", "offsite")


def add_staff(name: str, phone: str, email: str, presence: str = "onsite") -> int:
    with _db() as c:
        return c.insert("INSERT INTO staff (name, phone, email, created_at, presence) VALUES (?, ?, ?, ?, ?)",
                        (name, phone, email, now().isoformat(), presence))


def get_staff(staff_id: int | None) -> dict | None:
    if staff_id is None:
        return None
    with _db() as c:
        row = c.execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
    return dict(row) if row else None


def staff_by_phone(phone: str) -> dict | None:
    with _db() as c:
        row = c.execute("SELECT * FROM staff WHERE phone = ? ORDER BY id LIMIT 1", (phone,)).fetchone()
    return dict(row) if row else None


def set_presence(staff_id: int, presence: str) -> None:
    with _db() as c:
        c.execute("UPDATE staff SET presence = ? WHERE id = ?", (presence, staff_id))


def operator_roles() -> dict[int, list[dict]]:
    """Every operator's villas and roles: {staff_id: [{villa_id, role}]}."""
    out: dict[int, list[dict]] = {}
    with _db() as c:
        for r in c.execute("SELECT staff_id, villa_id, role FROM villa_staff ORDER BY villa_id").fetchall():
            out.setdefault(r["staff_id"], []).append({"villa_id": r["villa_id"], "role": r["role"]})
    return out


def operators_for_villa(villa_id: str) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT vs.role, s.id, s.name, s.phone, s.email, s.presence FROM villa_staff vs "
                         "JOIN staff s ON s.id = vs.staff_id WHERE vs.villa_id = ?", (villa_id,)).fetchall()
    return [dict(r) for r in rows]


def log_operator_message(staff_id: int, ticket_ref: str | None, direction: str, body: str) -> None:
    """direction: in (from the operator), out (Gia to the operator), ops (a person in ops), note (system)."""
    with _db() as c:
        c.execute("INSERT INTO operator_messages (staff_id, ticket_ref, direction, body, at) VALUES (?, ?, ?, ?, ?)",
                  (staff_id, ticket_ref, direction, body, now().isoformat()))


def operator_messages(staff_id: int, limit: int = 100) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM operator_messages WHERE staff_id = ? ORDER BY id DESC LIMIT ?",
                         (staff_id, limit)).fetchall()
    return [dict(r) for r in reversed(rows)]


def operator_last_inbound(staff_id: int) -> str | None:
    with _db() as c:
        row = c.execute("SELECT MAX(at) AS at FROM operator_messages WHERE staff_id = ? AND direction = 'in'",
                        (staff_id,)).fetchone()
    return row["at"]


def all_staff() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM staff ORDER BY name").fetchall()
    return [dict(r) for r in rows]


def assign_staff(villa_ids: list[str], role: str, staff_id: int | None) -> None:
    """Make one person the caretaker (or manager) of each villa; staff_id None clears the role."""
    with _db() as c:
        for villa_id in villa_ids:
            if staff_id is None:
                c.execute("DELETE FROM villa_staff WHERE villa_id = ? AND role = ?", (villa_id, role))
            else:
                c.execute("INSERT INTO villa_staff (villa_id, role, staff_id) VALUES (?, ?, ?) "
                          "ON CONFLICT(villa_id, role) DO UPDATE SET staff_id = excluded.staff_id",
                          (villa_id, role, staff_id))


def villa_managers() -> dict[str, dict]:
    """{villa_id: {id, name}} for every villa with a manager assigned."""
    with _db() as c:
        rows = c.execute("SELECT vs.villa_id, s.id, s.name FROM villa_staff vs JOIN staff s ON s.id = vs.staff_id "
                         "WHERE vs.role = 'manager'").fetchall()
    return {r["villa_id"]: {"id": r["id"], "name": r["name"]} for r in rows}


def staff_for_villa(villa_id: str) -> dict[str, dict]:
    """The villa's caretaker and manager (the UC-OPS-01 contacts), not its other operators."""
    with _db() as c:
        rows = c.execute("SELECT vs.role, s.id, s.name, s.phone, s.email FROM villa_staff vs "
                         "JOIN staff s ON s.id = vs.staff_id WHERE vs.villa_id = ? AND vs.role IN (?, ?)",
                         (villa_id, *STAFF_ROLES)).fetchall()
    return {r["role"]: dict(r) for r in rows}


def on_ground_contact(villa_id: str) -> dict:
    """Who the guest should call at the villa: the caretaker, else the manager, else the host on the villa record."""
    staff = staff_for_villa(villa_id)
    for role in STAFF_ROLES:
        if role in staff:
            return {"name": staff[role]["name"], "phone": staff[role]["phone"], "role": role}
    villa = get_villa(villa_id) or {}
    return {**villa.get("host", {}), "role": "host"}


# ---- ticket email outbox (mock OI: every ticket and handoff is emailed to the ops inbox) ----

def enqueue_email(kind: str, ref: str, to: str, cc: list[str], subject: str, body: str) -> int:
    with _db() as c:
        return c.insert(
            "INSERT INTO outbox_emails (kind, ref, to_addr, cc, subject, body, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
            (kind, ref, to, json.dumps(cc), subject, body, now().isoformat()),
        )


def pending_emails() -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT * FROM outbox_emails WHERE status = 'pending' ORDER BY id").fetchall()
    return [dict(r, cc=json.loads(r["cc"] or "[]")) for r in rows]


def mark_email(email_id: int, status: str, error: str | None = None) -> None:
    sent_at = now().isoformat() if status in ("sent", "logged") else None
    with _db() as c:
        c.execute("UPDATE outbox_emails SET status = ?, error = ?, attempts = attempts + 1, sent_at = ? "
                  "WHERE id = ?", (status, error, sent_at, email_id))


def outbox(limit: int = 50) -> list[dict]:
    with _db() as c:
        rows = c.execute("SELECT id, created_at, kind, ref, to_addr, subject, status, attempts, error, sent_at "
                         "FROM outbox_emails ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
