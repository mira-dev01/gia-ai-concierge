"""UC-OPS-01: Initiate concierge chat — the welcome, T-7 and T-1 pre-arrival messages.

There's no real OI event stream in this demo, so run_once() stands in for it: call it
periodically (main.py does, in the background) and it figures out from each booking's
check-in date and the concierge_schedule table which message, if any, is due.
"""

import logging
from datetime import date, datetime

from . import agent, config, store, whatsapp

log = logging.getLogger("gia.scheduler")

T7_DIRECTIVE = ("Trigger: T-7, seven days before check-in. Open the pre-arrival conversation: ask about "
                "arrival plans, confirm interest in services, and surface preferences.")
T7_MERGED_DIRECTIVE = ("Trigger: T-7, merged into the welcome because the booking was made less than 7 days "
                       "before arrival. After introducing yourself, also open the pre-arrival conversation: "
                       "ask about arrival plans, confirm interest in services, and surface preferences.")
T1_DIRECTIVE = ("Trigger: T-1, the day before check-in. Confirm the guest's arrival time, handle any final "
               "requests, and share the villa's directions and the host's contact (call get_villa_info first).")
T7_REMINDER_DIRECTIVE = ("Trigger: T-7 follow-up. The guest has not replied to your pre-arrival message sent "
                         "a day ago. Send one brief, warm reminder asking about arrival plans and preferences.")


async def run_once() -> None:
    """Check every confirmed booking for a due UC-OPS-01 trigger and send it. Safe to call repeatedly."""
    for booking in store.all_bookings():
        if booking["status"] != "confirmed":
            continue  # welcome/T-7/T-1 are pre-arrival only; in_stay guests are past this use case
        try:
            await _check_booking(booking)
        except Exception:
            log.exception("UC-OPS-01 check failed for %s", booking["booking_id"])


async def _check_booking(booking: dict) -> None:
    days_left = (date.fromisoformat(booking["check_in"]) - store.now().date()).days
    if days_left < 0:
        return  # stale sample data; nothing sensible to trigger
    booking_id, phone = booking["booking_id"], booking["guest_phone"]
    sched = store.get_schedule(booking_id)

    if not sched["welcome_at"]:
        await send_welcome(booking)
        if days_left <= 1:
            await send_t1(booking)
        elif days_left <= 7:
            await send_t7(booking, merged=True)
        return  # one trigger per booking per run keeps this easy to reason about and to test

    if not sched["t7_at"] and 1 < days_left <= 7:
        await send_t7(booking, merged=False)
        return

    if sched["t7_at"] and not sched["t7_reminder_at"] and not sched["t1_at"] \
            and _hours_since(sched["t7_at"]) >= 24 and not store.guest_replied_since(phone, sched["t7_at"]):
        await send_t7_reminder(booking)
        return

    if not sched["t1_at"] and days_left <= 1:
        if sched["t7_at"] and not store.guest_replied_since(phone, sched["t7_at"]):
            flag_host(booking)
        await send_t1(booking)
        return


def _hours_since(iso: str) -> float:
    return (store.now() - datetime.fromisoformat(iso)).total_seconds() / 3600


async def send_welcome(booking: dict) -> None:
    """UC-OPS-01 step 1: open the conversation with an approved template (needed outside the 24h window)."""
    params = None if config.WELCOME_TEMPLATE == "hello_world" else [booking["guest_name"].split()[0]]
    result = await whatsapp.send_template(booking["guest_phone"], config.WELCOME_TEMPLATE,
                                          config.WELCOME_TEMPLATE_LANG, params)
    store.audit(booking["booking_id"], "welcome_template", "tier0",
               {"template": config.WELCOME_TEMPLATE, "result": result})
    store.log_message(booking["guest_phone"], booking["booking_id"], "out", f"[template: {config.WELCOME_TEMPLATE}]")
    store.add_note(booking["guest_phone"], f"Gia sent the booking welcome template '{config.WELCOME_TEMPLATE}'")
    store.mark_schedule(booking["booking_id"], welcome_at=store.now().isoformat())


async def send_t7(booking: dict, merged: bool) -> None:
    await _send_proactive(booking, T7_MERGED_DIRECTIVE if merged else T7_DIRECTIVE)
    store.mark_schedule(booking["booking_id"], t7_at=store.now().isoformat())


async def send_t1(booking: dict) -> None:
    await _send_proactive(booking, T1_DIRECTIVE)
    store.mark_schedule(booking["booking_id"], t1_at=store.now().isoformat())


async def send_t7_reminder(booking: dict) -> None:
    await _send_proactive(booking, T7_REMINDER_DIRECTIVE)
    store.mark_schedule(booking["booking_id"], t7_reminder_at=store.now().isoformat())


def flag_host(booking: dict) -> None:
    """Exception: no reply by T-1 is flagged to the villa host."""
    villa = store.get_villa(booking["villa_id"])
    store.audit(booking["booking_id"], "t1_no_reply_flagged_to_host", "tier0",
               {"villa_host": villa["host"] if villa else None, "reason": "No reply since the T-7 message"})
    store.mark_schedule(booking["booking_id"], t1_host_flag_at=store.now().isoformat())


async def _send_proactive(booking: dict, directive: str) -> None:
    text = await agent.initiate(booking["guest_phone"], directive)
    store.log_message(booking["guest_phone"], booking["booking_id"], "out", text)
    await whatsapp.send_text(booking["guest_phone"], text)
