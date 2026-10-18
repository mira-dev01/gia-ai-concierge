"""UC-OPS-01 Initiate concierge chat: a welcome when the booking is confirmed, then T-7 and T-1 before check-in.

Each confirmed booking gets one journey_steps row per step, planned when OI confirms the booking
(on_booking_event) or, for the sample bookings, on the first run. run_once() sends whatever is due inside
the villa's send window. Step status: scheduled -> sent -> delivered -> read, or failed / skipped / cancelled.

WhatsApp allows free text only within 24 hours of the guest's last message, so each step opens with an
approved template (wa_templates.py) unless that window is open, in which case Gia writes the message herself.
Once the guest replies, Gia carries the conversation on in free text.
"""

import logging
from datetime import date, datetime, time, timedelta

from . import agent, store, tickets, wa_templates, whatsapp

log = logging.getLogger("gia.uc_ops_01")

USE_CASE = "UC-OPS-01"

# Per-villa settings; the console's Villas page edits them for one villa or a group.
DEFAULTS = {
    "enabled": True,
    "t7_days": 7,
    "t1_days": 1,
    "window_start": "10:00",
    "window_end": "19:00",
    "reminder_enabled": True,
    "reminder_hours": 24,
    "flag_no_reply": True,
    "flag_missing_ids": True,
}
STEPS = ("welcome", "t7", "t7_reminder", "t1")
STEP_LABELS = {"welcome": "Welcome", "t7": "T-7", "t7_reminder": "T-7 reminder", "t1": "T-1"}
MAX_ATTEMPTS = 2
RETRY_MINUTES = 15
SERVICE_WINDOW_HOURS = 23.5  # a little inside WhatsApp's 24 hours
MERGED_PREFIX = "Merged into the welcome"
LEGACY_COLUMNS = {"welcome": "welcome_at", "t7": "t7_at", "t7_reminder": "t7_reminder_at", "t1": "t1_at"}

BOOKING_REQUIRED = ("booking_id", "guest_name", "guest_phone", "villa_id", "check_in", "check_out")
BOOKING_DEFAULTS = {"language": "en", "adults": 2, "children": 0, "pets": 0, "occasion": None, "vip": False,
                    "pre_booked_services": []}

# What Gia is asked to write when the 24-hour window is open and she can use free text instead of a template.
_T7_ASK = ("ask about arrival plans and services, and collect everyone's name, ID document status (UC-OPS-02; "
          "note Form C for foreign nationals), dietary needs or allergies, and any children or pets")
DIRECTIVES = {
    "welcome": ("Trigger: booking confirmed. Introduce yourself as Lohono's AI concierge, confirm the villa and "
                "dates, and say they can message any time or ask for a person."),
    "welcome_merged": ("Trigger: booking confirmed less than a week before arrival, so the pre-arrival message is "
                       f"merged into the welcome. Introduce yourself as Lohono's AI concierge, then {_T7_ASK}."),
    "t7": f"Trigger: T-7, the pre-arrival message. Open the pre-arrival conversation: {_T7_ASK}.",
    "t7_reminder": ("Trigger: T-7 follow-up. The guest has not replied to your pre-arrival message. Send one brief, "
                    "warm reminder asking about arrival plans and anything to arrange."),
    "t1": ("Trigger: T-1, the day before check-in. Confirm the guest's arrival time, handle any final requests, "
           "and share the villa's directions, map link and the on-ground contact (call get_villa_info first). "
           "If ID document status or any guest names are still missing from Guest context, ask for them once more; "
           "if the guest can't share them now, say the team will collect it at check-in."),
}


def settings(villa_id: str) -> dict:
    return {**DEFAULTS, **store.villa_settings(villa_id, USE_CASE)}


# ---------------- planning ----------------

def plan(booking: dict) -> None:
    """Create the booking's steps (only the ones it doesn't have yet)."""
    s = settings(booking["villa_id"])
    bid = booking["booking_id"]
    confirmed = _parse_dt(booking.get("confirmed_at")) or store.now()
    check_in = date.fromisoformat(booking["check_in"])
    days_out = (check_in - confirmed.date()).days

    # Messages the pre-upgrade scheduler already sent count as sent, so nobody gets them twice.
    legacy = store.legacy_schedule(bid)
    for name, column in LEGACY_COLUMNS.items():
        if legacy.get(column):
            store.add_step(bid, name, legacy[column], status="sent", sent_at=legacy[column],
                           note="Sent before the UC-OPS-01 upgrade")

    store.add_step(bid, "welcome", confirmed.isoformat())
    if days_out < s["t7_days"]:
        store.add_step(bid, "t7", confirmed.isoformat(), status="skipped",
                       note=f"{MERGED_PREFIX}: booked less than {s['t7_days']} days before arrival")
    else:
        store.add_step(bid, "t7", _due(check_in, s["t7_days"], s))
    store.add_step(bid, "t1", _due(check_in, s["t1_days"], s))


def replan(booking: dict) -> None:
    """After a booking or villa settings change: move or close the steps that haven't gone out yet."""
    steps = store.steps_for_booking(booking["booking_id"])
    if booking["status"] != "confirmed":
        status = "cancelled" if booking["status"] == "cancelled" else "skipped"
        for st in steps.values():
            if st["status"] == "scheduled":
                store.update_step(st["id"], status=status, note=f"Booking is {booking['status']}")
        return
    s = settings(booking["villa_id"])
    check_in = date.fromisoformat(booking["check_in"])
    for name, days in (("t7", s["t7_days"]), ("t1", s["t1_days"])):
        st = steps.get(name)
        if st and st["status"] == "scheduled":
            store.update_step(st["id"], due_at=_due(check_in, days, s))
    plan(booking)


def on_booking_event(event: str, data: dict) -> dict:
    """OI booking event (mocked for now): confirmed, modified or cancelled. Returns the stored booking."""
    data = {k: v for k, v in data.items() if v not in (None, "")}
    if "guest_phone" in data:
        data["guest_phone"] = "".join(ch for ch in str(data["guest_phone"]) if ch.isdigit())
    bid = str(data.get("booking_id", "")).strip()
    existing = store.get_booking(bid) if bid else None

    if event == "confirmed":
        missing = [f for f in BOOKING_REQUIRED if not data.get(f) and not (existing or {}).get(f)]
        if missing:
            raise ValueError(f"Missing booking fields: {', '.join(missing)}")
        booking = {**BOOKING_DEFAULTS, **(existing or {}), **data, "status": "confirmed",
                   "confirmed_at": data.get("confirmed_at") or (existing or {}).get("confirmed_at")
                   or store.now().isoformat()}
    elif event in ("modified", "cancelled"):
        if not existing:
            raise LookupError(f"No booking {bid or '(no booking_id)'}")
        booking = {**existing, **data}
        if event == "cancelled":
            booking["status"] = "cancelled"
    else:
        raise ValueError(f"Unknown booking event '{event}'")

    _validate_booking(booking)
    store.upsert_booking(booking)
    if event == "confirmed":
        store.delete_steps(bid, "cancelled")  # confirmed again after a cancellation: plan those steps afresh
        plan(booking)
    else:
        replan(booking)
    store.audit(bid, f"oi_booking_{event}", "tier0", {"fields": sorted(data)})
    return booking


def parse_settings(raw: dict) -> dict:
    """Read the console's settings form. Blank fields (and 'keep') leave the villa's value unchanged."""
    changes: dict = {}
    for key in ("enabled", "reminder_enabled", "flag_no_reply", "flag_missing_ids"):
        if raw.get(key) in ("on", "off"):
            changes[key] = raw[key] == "on"
    for key, lo, hi in (("t7_days", 2, 30), ("t1_days", 1, 3), ("reminder_hours", 1, 72)):
        value = (raw.get(key) or "").strip()
        if value:
            if not value.isdigit() or not lo <= int(value) <= hi:
                raise ValueError(f"{key} must be a whole number from {lo} to {hi}")
            changes[key] = int(value)
    for key in ("window_start", "window_end"):
        value = (raw.get(key) or "").strip()
        if value:
            _hm(value)
            changes[key] = value[:5]
    return changes


def apply_settings(villa_ids: list[str], changes: dict) -> None:
    """Save settings for a group of villas, then move the scheduled steps of their confirmed bookings."""
    for villa_id in villa_ids:
        s = {**settings(villa_id), **changes}
        if s["t1_days"] >= s["t7_days"]:
            raise ValueError(f"{villa_id}: T-1 must be fewer days before check-in than T-7")
        if _hm(s["window_start"]) >= _hm(s["window_end"]):
            raise ValueError(f"{villa_id}: the send window must start before it ends")
    store.update_villa_settings(villa_ids, USE_CASE, changes)
    for b in store.all_bookings():
        if b["villa_id"] in villa_ids:
            replan(b)


# ---------------- sending ----------------

async def run_once() -> None:
    """Plan any confirmed booking without steps, then send every step that's due. Safe to call repeatedly."""
    for b in store.all_bookings():
        if b["status"] == "confirmed" and not store.steps_for_booking(b["booking_id"]):
            plan(b)
    now = store.now()
    for step in store.scheduled_steps():
        if _parse_dt(step["due_at"]) > now:
            continue
        try:
            await _process(step)
        except Exception:
            log.exception("UC-OPS-01 %s failed for %s", step["step"], step["booking_id"])


async def send_now(booking_id: str, name: str = "welcome") -> None:
    """Console override: send a scheduled step now, even outside the send window."""
    booking = store.get_booking(booking_id)
    if booking and booking["status"] == "confirmed":
        plan(booking)
    st = store.steps_for_booking(booking_id).get(name)
    if st and st["status"] == "scheduled":
        store.update_step(st["id"], due_at=store.now().isoformat())
        await _process(st, force=True)


async def _process(step: dict, force: bool = False) -> None:
    name, bid = step["step"], step["booking_id"]
    booking = store.get_booking(bid)
    if not booking or booking["status"] != "confirmed":
        status = booking["status"] if booking else "missing"
        store.update_step(step["id"], status="cancelled" if status in ("cancelled", "missing") else "skipped",
                          note=f"Booking is {status}")
        return
    s = settings(booking["villa_id"])
    now = store.now()
    if not s["enabled"]:
        return _skip(step, "UC-OPS-01 is switched off for this villa")
    if not force and not _hm(s["window_start"]) <= now.time() < _hm(s["window_end"]):
        return  # wait for the villa's send window
    steps = store.steps_for_booking(bid)
    if name != "welcome" and steps.get("welcome", {}).get("status") == "scheduled":
        return  # the welcome always goes first

    phone = booking["guest_phone"]
    if not force and store.takeover_active(phone):
        return  # a person from ops is handling this guest; send once they hand back to Gia
    days_left = (date.fromisoformat(booking["check_in"]) - now.date()).days
    pre_arrival_at = _pre_arrival_sent_at(steps)
    if days_left < 0:
        return _skip(step, "Check-in date has passed")
    if name == "t7" and days_left <= s["t1_days"]:
        return _skip(step, "Overdue, and T-1 is due now")
    if name == "t7_reminder":
        if pre_arrival_at and store.guest_replied_since(phone, pre_arrival_at):
            return _skip(step, "Guest replied")
        if steps.get("t1", {}).get("status") != "scheduled" or days_left <= s["t1_days"]:
            return _skip(step, "T-1 is due instead")

    if not store.claim_step(step["id"]):
        return  # another run got there first
    attempts = step["attempts"] + 1

    # "No reply" needs the guest to have had a fair chance to answer: at least the villa's reminder delay.
    if name == "t1" and attempts == 1 and s["flag_no_reply"] and pre_arrival_at \
            and now - _parse_dt(pre_arrival_at) >= timedelta(hours=s["reminder_hours"]) \
            and not store.guest_replied_since(phone, pre_arrival_at):
        await _flag_no_reply(booking, pre_arrival_at)

    # UC-OPS-02 exception: ID documents still missing at T-1 go to the villa team to collect at check-in.
    if name == "t1" and attempts == 1 and s["flag_missing_ids"] \
            and not (store.guest_details(bid).get("id_documents") or "").strip():
        await _flag_missing_ids(booking)

    merged = name == "welcome" and _is_merged(steps)
    try:
        wa_message_id, channel, sent_as = await _send(booking, name, merged)
    except Exception as e:
        log.exception("UC-OPS-01 %s send failed for %s", name, bid)
        await _failed(step["id"], attempts, booking, name, str(e))
        return
    store.update_step(step["id"], wa_message_id=wa_message_id, channel=channel, template=sent_as, note=None)

    if (name == "t7" or merged) and s["reminder_enabled"]:
        store.add_step(bid, "t7_reminder", (now + timedelta(hours=s["reminder_hours"])).isoformat())


async def _send(booking: dict, name: str, merged: bool) -> tuple[str | None, str, str | None]:
    """Send one step: free text from Gia if the 24-hour window is open, else the approved template."""
    phone, bid = booking["guest_phone"], booking["booking_id"]
    last_in = _parse_dt(store.last_inbound_at(phone))
    if last_in and store.now() - last_in < timedelta(hours=SERVICE_WINDOW_HOURS):
        try:
            text = await agent.initiate(phone, DIRECTIVES["welcome_merged" if merged else name])
        except Exception:
            log.exception("Gia couldn't write the %s message for %s; sending the template instead", name, bid)
            text = None
        if text:
            try:
                wa_message_id = whatsapp.message_id(await whatsapp.send_text(phone, text))
                _log_sent(booking, name, text, "free_text", None, merged, wa_message_id)
                return wa_message_id, "free_text", None
            except whatsapp.WhatsAppError as e:
                if e.code != whatsapp.OUTSIDE_SERVICE_WINDOW:
                    raise
                log.info("Service window closed for %s; sending the %s template instead", bid, name)

    template, values = _template_for(booking, name, merged)
    result, text, sent_as = await wa_templates.send(phone, template, values, booking.get("language") or "en")
    wa_message_id = whatsapp.message_id(result)
    agent.record_outbound(phone, bid, text)
    _log_sent(booking, name, text, "template", sent_as, merged, wa_message_id)
    return wa_message_id, "template", sent_as


def _template_for(booking: dict, name: str, merged: bool) -> tuple[wa_templates.Template, list]:
    villa = store.get_villa(booking["villa_id"]) or {}
    first = booking["guest_name"].split()[0]
    villa_name = villa.get("name", booking["villa_id"])
    check_in, check_out = _nice_date(booking["check_in"]), _nice_date(booking["check_out"])
    if name == "welcome":
        return (wa_templates.WELCOME_PRE_ARRIVAL if merged else wa_templates.WELCOME), \
            [first, villa_name, check_in, check_out]
    if name == "t7":
        return wa_templates.PRE_ARRIVAL, [first, villa_name, check_in]
    if name == "t7_reminder":
        return wa_templates.PRE_ARRIVAL_REMINDER, [first, villa_name, check_in]
    contact = store.on_ground_contact(booking["villa_id"])
    return wa_templates.ARRIVAL, [first, villa_name, check_in, villa.get("check_in_time"), villa.get("directions"),
                                  villa.get("maps_url"), contact.get("name"), contact.get("phone")]


def _log_sent(booking: dict, name: str, text: str, channel: str, template: str | None, merged: bool,
              wa_message_id: str | None) -> None:
    """Every UC-OPS-01 message is logged against the booking, as the guest saw it, with its delivery state."""
    store.log_message(booking["guest_phone"], booking["booking_id"], "out", text,
                      status="sent" if wa_message_id else "not_sent", wa_message_id=wa_message_id)
    store.audit(booking["booking_id"], f"uc_ops_01:{name}", "tier0",
                {"channel": channel, "template": template, "merged_t7": merged})


async def _flag_no_reply(booking: dict, pre_arrival_at: str) -> None:
    """Exception: no reply by T-1 goes to the control tower and the villa's caretaker and manager
    (the villa host on record when neither is assigned)."""
    staff = store.staff_for_villa(booking["villa_id"])
    host = (store.get_villa(booking["villa_id"]) or {}).get("host") or {}
    on_ground = [f"{p['name']} ({role})" for role, p in staff.items()] or [f"{host.get('name', 'Villa')} (villa host)"]
    assignee = ", ".join(on_ground + ["Ops control tower"])
    first = booking["guest_name"].split()[0]
    t = tickets.raise_ticket(
        booking, booking["guest_phone"], "pre_arrival", "high",
        f"No reply from {first} before arrival on {booking['check_in']}",
        (f"Gia's pre-arrival message went out at {pre_arrival_at[:16].replace('T', ' ')} IST and the guest has "
         "not replied. Arrival time, transport and preferences are unconfirmed. Gia is sending the T-1 message "
         "now; please call the guest to confirm their arrival."),
        source="uc-ops-01", assignee=assignee)
    messaged = await tickets.alert_staff(booking, t, f"no reply from guest {first} before arrival")
    store.audit(booking["booking_id"], "t1_no_reply_flagged", "tier0",
                {"ticket": t["ref"], "assigned_to": assignee, "whatsapp_alerts": messaged})


async def _flag_missing_ids(booking: dict) -> None:
    """UC-OPS-02 exception: ID documents still missing at T-1 are flagged to the villa host to collect
    at check-in (Form C, for a foreign national, is completed from the physical document on arrival)."""
    staff = store.staff_for_villa(booking["villa_id"])
    host = (store.get_villa(booking["villa_id"]) or {}).get("host") or {}
    assignee = ", ".join(f"{p['name']} ({role})" for role, p in staff.items()) \
        or host.get("name", "Villa host")
    first = booking["guest_name"].split()[0]
    t = tickets.raise_ticket(
        booking, booking["guest_phone"], "pre_arrival", "medium",
        f"Collect ID documents from {first} at check-in",
        ("Gia has not received ID document status from the guest before T-1. Please collect and verify ID "
         "documents at check-in (Form C registration from the passport, for a foreign national)."),
        source="uc-ops-02", assignee=assignee)
    messaged = await tickets.alert_staff(booking, t, f"ID documents still outstanding for {first}, collect at check-in")
    store.audit(booking["booking_id"], "uc_ops_02_ids_missing_flagged", "tier0",
                {"ticket": t["ref"], "assigned_to": assignee, "whatsapp_alerts": messaged})


async def _failed(step_id: int, attempts: int, booking: dict | None, name: str, error: str) -> None:
    """Retry once after a short wait; after that mark the step failed and raise a ticket so no guest is missed."""
    if attempts < MAX_ATTEMPTS:
        store.update_step(step_id, status="scheduled", sent_at=None,
                          due_at=(store.now() + timedelta(minutes=RETRY_MINUTES)).isoformat(),
                          note=f"Attempt {attempts} failed, retrying: {error}")
        return
    store.update_step(step_id, status="failed", note=error)
    if booking:
        label = STEP_LABELS[name]
        tickets.raise_ticket(
            booking, booking["guest_phone"], "system", "high",
            f"{label} message not delivered to {booking['guest_name']}",
            (f"UC-OPS-01 could not deliver the {label} message after {attempts} attempts.\nLast error: {error}\n\n"
             "Please reach the guest another way and check their WhatsApp number in OI."),
            source="system", assignee="Ops control tower")


async def on_delivery_status(status: dict) -> None:
    """WhatsApp delivery receipt (sent / delivered / read / failed) for a message Gia sent."""
    step = store.step_by_message_id(status.get("id") or "")
    if not step:
        return  # not a UC-OPS-01 message
    now = store.now().isoformat()
    kind = status.get("status")
    if kind == "delivered" and step["status"] == "sent":
        store.update_step(step["id"], status="delivered", delivered_at=now)
    elif kind == "read" and step["status"] in ("sent", "delivered"):
        store.update_step(step["id"], status="read", read_at=now, delivered_at=step["delivered_at"] or now)
    elif kind == "failed" and step["status"] in store.SENT_STATUSES:
        err = (status.get("errors") or [{}])[0]
        detail = (err.get("error_data") or {}).get("details") or err.get("title") or err.get("message") or ""
        await _failed(step["id"], step["attempts"], store.get_booking(step["booking_id"]), step["step"],
                      f"{err.get('code')}: {detail}")


# ---------------- helpers ----------------

def _skip(step: dict, reason: str) -> None:
    store.update_step(step["id"], status="skipped", note=reason)


def _is_merged(steps: dict) -> bool:
    t7 = steps.get("t7")
    return bool(t7 and t7["status"] == "skipped" and (t7["note"] or "").startswith(MERGED_PREFIX))


def _pre_arrival_sent_at(steps: dict) -> str | None:
    """When the guest was first asked for their arrival plans: the T-7 message, or a welcome that merged it."""
    t7, welcome = steps.get("t7") or {}, steps.get("welcome") or {}
    if t7.get("status") in store.SENT_STATUSES:
        return t7["sent_at"]
    if _is_merged(steps) and welcome.get("status") in store.SENT_STATUSES:
        return welcome["sent_at"]
    return None


def _due(check_in: date, days_before: int, s: dict) -> str:
    return datetime.combine(check_in - timedelta(days=days_before), _hm(s["window_start"]),
                            tzinfo=store.IST).isoformat()


def _hm(value: str) -> time:
    try:
        return time.fromisoformat(value.strip()[:5])
    except ValueError:
        raise ValueError(f"'{value}' is not a time like 10:00") from None


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    return dt.astimezone(store.IST) if dt.tzinfo else dt.replace(tzinfo=store.IST)


def _nice_date(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%a %d %b")


def _validate_booking(b: dict) -> None:
    if not store.get_villa(b["villa_id"]):
        raise ValueError(f"Unknown villa {b['villa_id']}")
    try:
        if date.fromisoformat(b["check_out"]) <= date.fromisoformat(b["check_in"]):
            raise ValueError("check_out must be after check_in")
    except (TypeError, ValueError) as e:
        raise ValueError(f"Bad dates: {e}") from None
    _parse_dt(b.get("confirmed_at"))
