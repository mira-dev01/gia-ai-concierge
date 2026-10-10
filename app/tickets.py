"""Mock OI ticketing: every ticket and human handoff is saved locally and emailed to the ops inbox.

When OI's ticket endpoint is ready, raise_ticket() and raise_handoff() are the two functions to point at it.
Emails go through an outbox table and Resend, so a failed send is retried by the background loop and nothing
is lost.
"""

import asyncio
import logging

from . import config, mailer, store, wa_templates, whatsapp

log = logging.getLogger("gia.tickets")

MAX_EMAIL_ATTEMPTS = 5
_flush_lock = asyncio.Lock()
_background: set[asyncio.Task] = set()  # keeps fire-and-forget flushes referenced until they finish


def raise_ticket(booking: dict, phone: str, category: str, severity: str, summary: str, details: str,
                 source: str = "guest", assignee: str | None = None) -> dict:
    """Create a ticket and email it to the ops inbox, copying the villa's caretaker and manager."""
    t = store.create_ticket(booking, phone, category, severity, summary, details, source=source, assignee=assignee)
    store.audit(booking["booking_id"], "ticket_raised", "tier0",
                {"ticket": t["ref"], "source": source, "category": category, "severity": severity})
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


def raise_handoff(booking: dict | None, phone: str, reason: str, urgency: str) -> int:
    """Hand the guest to the ops control tower and email the handoff with the conversation so far."""
    handoff_id = store.create_handoff(booking["booking_id"] if booking else None, phone, reason, urgency)
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
            result, _, sent_as = await wa_templates.send(person["phone"], wa_templates.STAFF_ALERT, values)
            whatsapp.message_id(result)
            messaged.append(f"{person['name']} ({role})")
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
    try:
        task = asyncio.get_running_loop().create_task(flush_outbox())
    except RuntimeError:
        return  # no event loop here; the background loop sends it
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
    else:
        lines.append(f"Guest: +{phone} (no booking matches this number)")
    convo = store.transcript_for(phone)
    if convo:
        lines.append("\nRecent conversation:")
        lines += [f"{m['at'][5:16].replace('T', ' ')} {'guest' if m['direction'] == 'in' else 'Gia'}: {m['body']}"
                  for m in convo]
    return "\n".join(lines)
