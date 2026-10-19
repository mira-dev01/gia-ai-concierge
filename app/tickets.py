"""Mock OI ticketing: every ticket and human handoff is saved locally and emailed to the ops inbox.

When OI's ticket endpoint is ready, raise_ticket() and raise_handoff() are the two functions to point at it.
Emails go through an outbox table and Resend, so a failed send is retried by the background loop and nothing
is lost.
"""

import asyncio
import logging

from . import config, mailer, operators, store, wa_templates, whatsapp

log = logging.getLogger("gia.tickets")

MAX_EMAIL_ATTEMPTS = 5

# What the guest is told when ops (or the field operator) moves their request on (UC-OPS-05 step 5).
STATUS_MESSAGES = {
    "acknowledged": "The team has picked up your request {ref} ({summary}). Expected by {due}.",
    "in_progress": "Your request {ref} ({summary}) is in progress now.",
    "delayed": "Sorry, your request {ref} ({summary}) is running late. We've escalated it and will update you shortly.",
    "closed": "Your request {ref} ({summary}) is done. Is everything as you wanted? Just reply here if not.",
}
_flush_lock = asyncio.Lock()
_background: set[asyncio.Task] = set()  # keeps fire-and-forget flushes referenced until they finish


def raise_ticket(booking: dict, phone: str, category: str, severity: str, summary: str, details: str,
                 source: str = "guest", assignee: str | None = None) -> dict:
    """Create a ticket, give it to the villa's field operator for that kind of work (an onsite one first),
    tell the operator on WhatsApp, and email it to the ops inbox, copying the villa's caretaker and manager."""
    op = operators.pick(booking["villa_id"], category)
    if op and assignee is None:
        assignee = operators.label(op)
    t = store.create_ticket(booking, phone, category, severity, summary, details, source=source, assignee=assignee,
                            operator_id=op["id"] if op else None)
    store.audit(booking["booking_id"], "ticket_raised", "tier0",
                {"ticket": t["ref"], "source": source, "category": category, "severity": severity,
                 "operator": op["name"] if op else None})
    if op and source == "guest":  # internal flags already alert the villa team themselves (alert_staff)
        _spawn(lambda: operators.notify_assignment(t, booking))
    staff = store.staff_for_villa(booking["villa_id"])
    body = (f"Ticket {t['ref']} (mock OI)\n"
            f"Category: {category}    Severity: {severity}    Status: {t['status']}\n"
            f"Raised by: Gia ({source})    Assigned to: {t['assignee']}\n"
            f"Expected by: {t['due_at'][:16].replace('T', ' ')} IST\n\n"
            f"Summary: {summary}\n\nDetails:\n{details}\n\n"
            + _context(booking, phone))
    store.enqueue_email("ticket", t["ref"], config.TICKET_EMAIL_TO, [s["email"] for s in staff.values() if s["email"]],
                        f"[{t['ref']}] {severity.upper()} {category}: {summary}", body)
    _kick()
    return t


async def set_status(ticket_id: int, status: str, by: str = "ops", note: str | None = None) -> dict:
    """Move a ticket on. For a guest's own request, Gia tells the guest on WhatsApp (UC-OPS-05 step 5).
    Closing records the time to resolve; `by` says who closed it (ops, or the operator and how) and `note` how."""
    if status not in STATUS_MESSAGES:
        raise ValueError("Unknown status")
    t = store.set_ticket_status(ticket_id, status, by=by, note=note)
    if not t:
        raise LookupError("No such ticket")
    store.audit(t["booking_id"], f"ticket_status:{status}", "tier0",
                {"ticket": t["ref"], "by": by, **({"note": note} if note else {})})
    if t["source"] in (None, "guest"):  # internal tickets (no-reply flags, delivery failures) aren't the guest's
        msg = STATUS_MESSAGES[status].format(ref=t["ref"], summary=t["summary"], due=t["due_at"][11:16] + " IST")
        store.add_note(t["phone"], f"ticket {t['ref']} was set to '{status}' by {by} and Gia sent the guest: \"{msg}\"")
        await whatsapp.send_logged(t["phone"], t["booking_id"], msg)
    return t


def set_escalation(ticket_id: int, on: bool, reason: str = "", by: str = "ops") -> dict:
    """Flag a ticket as escalated (or clear the flag). Escalation sits beside the status: an in-progress ticket
    can be escalated and overdue at once. It puts the ticket at the top of every attention list; it doesn't
    message the guest, and closing the ticket clears it."""
    t = store.get_ticket(ticket_id)
    if not t:
        raise LookupError("No such ticket")
    if on and t["status"] == "closed":
        raise ValueError(f"{t['ref']} is resolved; reopen it before escalating")
    if on and not reason.strip():
        raise ValueError("Say why it's escalated")
    t = store.set_ticket_escalation(ticket_id, on, reason.strip() or None)
    store.audit(t["booking_id"], "ticket_escalated" if on else "ticket_deescalated", "tier0",
                {"ticket": t["ref"], "by": by, **({"reason": reason.strip()} if on else {})})
    return t


def raise_handoff(booking: dict | None, phone: str, reason: str, urgency: str) -> int:
    """Hand the guest to the ops control tower and email the handoff with the conversation so far."""
    handoff_id = store.create_handoff(booking["booking_id"] if booking else None, phone, reason, urgency)
    store.audit(booking["booking_id"] if booking else None, "handoff_raised", "tier0",
                {"handoff": handoff_id, "reason": reason, "urgency": urgency, "phone": phone})
    staff = store.staff_for_villa(booking["villa_id"]) if booking else {}
    who = booking["guest_name"] if booking else phone
    body = (f"Handoff HO-{handoff_id} to the control tower ({urgency})\n\nReason: {reason}\n\n"
            + _context(booking, phone))
    store.enqueue_email("handoff", f"HO-{handoff_id}", config.TICKET_EMAIL_TO,
                        [s["email"] for s in staff.values() if s["email"]] if urgency == "urgent" else [],
                        f"[HO-{handoff_id}]{' URGENT' if urgency == 'urgent' else ''} {who}: {reason[:80]}", body)
    _kick()
    return handoff_id


async def alert_staff(booking: dict, ticket: dict, what_happened: str) -> list[str]:
    """WhatsApp the villa's caretaker and manager about a ticket (the villa host on record if neither is
    assigned). Returns who was messaged."""
    villa = store.get_villa(booking["villa_id"]) or {}
    recipients = [(role, p) for role, p in store.staff_for_villa(booking["villa_id"]).items() if p["phone"]]
    if not recipients:
        host = villa.get("host") or {}
        digits = "".join(ch for ch in host.get("phone", "") if ch.isdigit())
        if len(digits) >= 11:  # the sample villas' hosts have placeholder numbers, which this skips
            recipients = [("host", {"name": host.get("name", "Villa host"), "phone": digits})]
    if not recipients:
        store.audit(booking["booking_id"], "staff_alert_skipped", "tier0",
                    {"ticket": ticket["ref"], "reason": "No caretaker, manager or host phone to message"})
    messaged = []
    for role, person in recipients:
        values = [what_happened, villa.get("name", booking["villa_id"]), booking["guest_name"],
                  booking["booking_id"], booking["check_in"], ticket["ref"]]
        try:
            result, text, sent_as = await wa_templates.send(person["phone"], wa_templates.STAFF_ALERT, values)
            whatsapp.message_id(result)
            messaged.append(f"{person['name']} ({role})")
            if person.get("id"):  # the villa host on record isn't an operator
                store.log_operator_message(person["id"], ticket["ref"], "out", text)
            store.audit(booking["booking_id"], "staff_alert", "tier0",
                        {"ticket": ticket["ref"], "to": person["name"], "role": role, "template": sent_as})
        except Exception as e:  # the ticket email still reaches ops; record the miss
            log.exception("Staff alert to %s failed", person["name"])
            store.audit(booking["booking_id"], "staff_alert_failed", "tier0",
                        {"ticket": ticket["ref"], "to": person["name"], "error": str(e)})
    return messaged


async def flush_outbox() -> None:
    """Send pending ticket emails. Called by the background loop and right after a ticket is raised."""
    if _flush_lock.locked():
        return  # a flush is already running; the next loop picks up anything it misses
    async with _flush_lock:
        for m in store.pending_emails():
            try:
                outcome = await mailer.send(m["to_addr"], m["cc"], m["subject"], m["body"],
                                            # created_at too: ids restart if the database is reset
                                            idempotency_key=f"gia-outbox-{m['id']}-{m['created_at']}")
                store.mark_email(m["id"], outcome)
            except Exception as e:
                log.exception("Ticket email %s failed", m["ref"])
                status = "failed" if m["attempts"] + 1 >= MAX_EMAIL_ATTEMPTS else "pending"
                store.mark_email(m["id"], status, str(e))


def _kick() -> None:
    _spawn(flush_outbox)  # without an event loop, the background loop sends it


def _spawn(make) -> None:
    """Run make() as a background task when there's an event loop (raise_ticket is called from sync code)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(make())
    _background.add(task)
    task.add_done_callback(_background.discard)


def _context(booking: dict | None, phone: str) -> str:
    lines = []
    if booking:
        villa = store.get_villa(booking["villa_id"]) or {}
        staff = store.staff_for_villa(booking["villa_id"])
        lines += [f"Booking: {booking['booking_id']} ({booking['status']}), {booking['guest_name']}, +{phone}",
                  f"Villa: {villa.get('name', booking['villa_id'])}, {villa.get('location', '')}",
                  f"Stay: {booking['check_in']} to {booking['check_out']}"]
        on_ground = ", ".join(f"{p['name']} ({role}, {p['phone'] or 'no phone'})" for role, p in staff.items())
        host = villa.get("host") or {}
        lines.append(f"Villa team: {on_ground or 'no caretaker or manager assigned'}; "
                     f"host on record {host.get('name', '-')} ({host.get('phone', '-')})")
        prefs = store.preferences_for_guest(store.guest_id_for(booking))  # UC-OPS-09, from every stay
        if prefs:
            lines.append("Guest profile: " + "; ".join(
                f"{p['kind'] or 'like'}: {p['preference']}" for p in prefs))
    else:
        lines.append(f"Guest: +{phone} (no booking matches this number)")
    convo = store.transcript_for(phone)
    if convo:
        lines.append("\nRecent conversation:")
        lines += [f"{m['at'][5:16].replace('T', ' ')} {({'in': 'guest', 'ops': 'ops team'}).get(m['direction'], 'Gia')}: "
                  f"{m['body']}"
                  for m in convo]
    return "\n".join(lines)
