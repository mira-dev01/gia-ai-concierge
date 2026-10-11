"""Field operators: the caretakers, maintenance and housekeeping staff and managers who do the work on tickets.

A new ticket goes to the villa's operator for that kind of work (an onsite one first) and Gia sends them the task
on WhatsApp. Operators reply on WhatsApp: DONE closes their task (DONE OI-00012 when they have several), ONSITE and
OFFSITE set where they are, and anything else is shown to ops in the console's operator chat.
"""

import logging
import re
from datetime import datetime, timedelta

from . import store, wa_templates, whatsapp

log = logging.getLogger("gia.operators")

# Which operator role handles each ticket category, most suitable first. Categories not listed (system
# failures) stay with the ops control tower.
ROUTING = {
    "maintenance": ("maintenance", "caretaker", "manager"),
    "housekeeping": ("housekeeping", "caretaker", "manager"),
    "service": ("caretaker", "manager"),
    "reservation": ("caretaker", "manager"),
    "complaint": ("manager", "caretaker"),
    "pre_arrival": ("caretaker", "manager"),
}
SERVICE_WINDOW = timedelta(hours=24)  # WhatsApp allows free text only this long after their last message
# The whole message must be the command, so "done with part one, still need parts" isn't taken as DONE.
COMMAND = re.compile(r"^\s*(DONE|ONSITE|OFFSITE)(?:[\s:.-]*(?:OI[\s-]*)?(\d+))?\s*[.!]*\s*$", re.IGNORECASE)


def pick(villa_id: str, category: str) -> dict | None:
    """The villa's operator for this kind of work: by role order, an onsite operator before an offsite one."""
    roles = ROUTING.get(category)
    if not roles:
        return None
    ops = store.operators_for_villa(villa_id)
    ranked = [o for role in roles for o in ops if o["role"] == role]
    return next((o for o in ranked if o["presence"] == "onsite"), ranked[0] if ranked else None)


def label(op: dict) -> str:
    return f"{op['name']} · {op['role'].capitalize()}" if op.get("role") else op["name"]


def role_for(staff_id: int, villa_id: str) -> str | None:
    return next((o["role"] for o in store.operators_for_villa(villa_id) if o["id"] == staff_id), None)


def window_open(staff_id: int) -> bool:
    last = store.operator_last_inbound(staff_id)
    return bool(last) and store.now() - datetime.fromisoformat(last) < SERVICE_WINDOW


def minutes_to_resolve(t: dict) -> int | None:
    if not t.get("resolved_at"):
        return None
    return round((datetime.fromisoformat(t["resolved_at"]) - datetime.fromisoformat(t["created_at"])).total_seconds() / 60)


def duration(minutes: int | None) -> str:
    if minutes is None:
        return ""
    if minutes < 1:
        return "<1 min"
    if minutes < 60:
        return f"{minutes} min"
    hours, mins = divmod(minutes, 60)
    if hours < 24:
        return f"{hours} h {mins:02d} min"
    days, hours = divmod(hours, 24)
    return f"{days} d {hours} h"


def _task_text(t: dict, booking: dict) -> str:
    villa = (store.get_villa(t["villa_id"]) or {}).get("name", t["villa_id"])
    return (f"New task {t['ref']} · {t['category'].replace('_', ' ')} ({t['severity']})\n"
            f"{villa} · guest {booking['guest_name']} ({booking['booking_id']})\n\n"
            f"{t['summary']}\n{t['details']}\n\n"
            f"Expected by {t['due_at'][11:16]} IST. Reply DONE when it's finished.")


async def send(staff: dict, ticket_ref: str | None, text: str, direction: str = "out") -> None:
    """Free-text WhatsApp to an operator, logged in their chat. Raises WhatsAppError if Meta refuses it."""
    whatsapp.message_id(await whatsapp.send_text(staff["phone"], text))
    store.log_operator_message(staff["id"], ticket_ref, direction, text)


async def notify_assignment(t: dict, booking: dict) -> None:
    """Tell the operator about their new task: free text inside the 24-hour window, otherwise the staff-alert
    template. A failure is recorded in their chat and the audit log so ops can follow up another way."""
    op = store.get_staff(t["operator_id"])
    if not op:
        return
    if not op["phone"]:
        store.log_operator_message(op["id"], t["ref"], "note", f"{t['ref']} assigned, but there's no WhatsApp number to send it to.")
        store.audit(t["booking_id"], "operator_notify_failed", "tier0", {"ticket": t["ref"], "to": op["name"], "error": "No phone number"})
        return
    try:
        if window_open(op["id"]):
            await send(op, t["ref"], _task_text(t, booking))
            sent_as = None
        else:
            villa = (store.get_villa(t["villa_id"]) or {}).get("name", t["villa_id"])
            result, text, sent_as = await wa_templates.send(
                op["phone"], wa_templates.STAFF_ALERT,
                [f"new {t['category'].replace('_', ' ')} task: {t['summary']}", villa, booking["guest_name"],
                 booking["booking_id"], booking["check_in"], t["ref"]])
            whatsapp.message_id(result)
            store.log_operator_message(op["id"], t["ref"], "out", text)
        store.audit(t["booking_id"], "operator_notified", "tier0", {"ticket": t["ref"], "to": op["name"], "template": sent_as})
    except Exception as e:
        log.exception("Telling operator %s about %s failed", op["name"], t["ref"])
        store.log_operator_message(op["id"], t["ref"], "note", f"Couldn't send {t['ref']} on WhatsApp: {e}")
        store.audit(t["booking_id"], "operator_notify_failed", "tier0", {"ticket": t["ref"], "to": op["name"], "error": str(e)})


async def mark_done(t: dict, staff: dict, via: str) -> dict:
    """The operator finished the task: close it (the guest is told) and note the time it took."""
    from . import tickets  # tickets imports this module
    closed = await tickets.set_status(t["id"], "closed", by=f"{staff['name']} ({via})")
    took = duration(minutes_to_resolve(closed))
    store.log_operator_message(staff["id"], t["ref"], "note", f"{t['ref']} marked done via {via} · resolved in {took}")
    return closed


async def handle_message(staff: dict, text: str) -> None:
    """A WhatsApp message from an operator."""
    store.log_operator_message(staff["id"], None, "in", text)
    m = COMMAND.match(text)
    if not m:
        open_now = store.open_tickets_for_operator(staff["id"])
        store.audit(open_now[0]["booking_id"] if len(open_now) == 1 else None, "operator_message", "tier0",
                    {"from": staff["name"], "staff_id": staff["id"], "text": text})
        return  # ops reads it in the console and replies from there
    word, number = m.group(1).upper(), m.group(2)

    if word in ("ONSITE", "OFFSITE"):
        store.set_presence(staff["id"], word.lower())
        store.audit(None, "operator_presence", "tier0", {"staff_id": staff["id"], "name": staff["name"], "presence": word.lower()})
        await _reply(staff, None, f"Thanks {staff['name'].split()[0]}, you're marked {word.lower()}.")
        return

    open_now = store.open_tickets_for_operator(staff["id"])
    if number:
        t = next((x for x in open_now if x["id"] == int(number)), None)
        if not t:
            await _reply(staff, None, f"OI-{int(number):05d} isn't one of your open tasks. " + _task_list(open_now))
            return
    elif len(open_now) == 1:
        t = open_now[0]
    else:
        await _reply(staff, None, "You have no open tasks." if not open_now else
                     _task_list(open_now) + " Reply DONE with the number of the one you finished, e.g. DONE " + open_now[0]["ref"])
        return
    closed = await mark_done(t, staff, "WhatsApp")
    told = " The guest has been told." if closed["source"] in (None, "guest") else ""
    await _reply(staff, t["ref"], f"Thanks, {t['ref']} is marked done (resolved in {duration(minutes_to_resolve(closed))}).{told}")


def _task_list(open_now: list[dict]) -> str:
    if not open_now:
        return "You have no open tasks."
    return "Your open tasks: " + "; ".join(f"{t['ref']} {t['summary']}" for t in open_now) + "."


async def _reply(staff: dict, ticket_ref: str | None, text: str) -> None:
    try:
        await send(staff, ticket_ref, text)
    except Exception as e:  # they just wrote, so this is rare; keep the reply visible to ops anyway
        log.exception("Reply to operator %s failed", staff["name"])
        store.log_operator_message(staff["id"], ticket_ref, "note", f"Reply not delivered ({e}): {text}")
