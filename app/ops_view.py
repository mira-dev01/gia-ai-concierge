"""Live data for the ops console (/), shaped for its screens. Read-only; the console's actions are routes in
main.py.

snapshot() is what the console polls: a portfolio-wide summary (bookings, tickets, handoffs, operators, what needs
attention and the activity that matters), deliberately without any conversation or chat history so it stays small
however many villas there are. A booking's conversation, a ticket's history and an operator's WhatsApp thread are
loaded on their own when someone opens them."""

import json
from datetime import datetime, timedelta

from . import operators, portfolio, preferences, scheduler, store

MESSAGES_PER_BOOKING = 150
MESSAGES_PER_OPERATOR = 100
EVENTS_LENGTH = 30
IN_CONVERSATION = timedelta(minutes=15)  # a guest who wrote this recently is "in conversation"
SERVICE_WINDOW = timedelta(hours=24)     # WhatsApp allows free text only this long after the guest's last message
EXCERPT_LENGTH = 3                       # guest messages shown with a ticket: what they wrote just before it
EXCERPT_WINDOW = timedelta(minutes=30)   # was raised (the last message alone if none falls in this window)
# Audit actions that read as notes inside a guest's chat.
CHAT_NOTES = {"ops_takeover": "Ops took over this chat · Gia paused", "ops_handback": "Handed back to Gia"}


def snapshot(ticket_statuses: list[str]) -> dict:
    base = portfolio.load()
    now, today, villas, names = base["now"], base["today"], base["villas"], base["names"]
    taken_over = store.takeover_phones()
    last_in = store.last_inbound_by_booking()
    tickets = base["tickets"]
    by_ref = {t["ref"]: t for t in tickets}

    bookings = []
    for b in base["bookings"]:
        villa = villas.get(b["villa_id"], {})
        inbound = last_in.get(b["booking_id"])
        bookings.append({
            "id": b["booking_id"], "name": b["guest_name"], "villa_id": b["villa_id"],
            "villa": villa.get("name", b["villa_id"]), "location": villa.get("location", ""),
            "check_in": b["check_in"], "check_out": b["check_out"],
            "status": b["status"], "status_label": portfolio.booking_label(b),
            "state": portfolio.booking_state(b), "stage": portfolio.stage(b, today),
            "takeover": b["guest_phone"] in taken_over,
            "last_inbound_at": inbound,
            "in_conversation": bool(inbound and now - datetime.fromisoformat(inbound) < IN_CONVERSATION),
        })

    events = []
    for e in store.audit_log(EVENTS_LENGTH * 6):
        ev = _event(e, names, by_ref, villas)
        if ev:
            events.append(ev)

    return {
        "now": now.isoformat(),
        "bookings_updated_at": store.bookings_updated_at(),
        "ticket_statuses": ticket_statuses,
        "villas": [{"id": v["villa_id"], "name": v["name"], "location": v.get("location", "")} for v in villas.values()],
        "bookings": bookings,
        "tickets": tickets,
        "handoffs": base["handoffs"],
        "operators": _operators(base),
        "operator_roles": list(store.OPERATOR_ROLES),
        "attention": portfolio.attention(base),
        "events": events[:EVENTS_LENGTH],
    }


def _operators(base: dict) -> list[dict]:
    roles = store.operator_roles()
    mine: dict[int, list[dict]] = {}
    for t in base["tickets"]:
        mine.setdefault(t["operator_id"], []).append(t)
    return [_operator_summary(p, mine.get(p["id"], []), roles.get(p["id"], []), base["villas"])
            for p in base["staff"].values()]


def _operator_summary(p: dict, mine: list[dict], roles: list[dict], villas: dict) -> dict:
    """An operator as the console lists them: villas and roles, open and resolved work, and the 24-hour window."""
    resolved = [t["resolve_minutes"] for t in mine if t["resolve_minutes"] is not None]
    return {
        "id": p["id"], "name": p["name"], "phone": p["phone"], "presence": p.get("presence") or "onsite",
        "roles": [{"villa_id": r["villa_id"], "villa": villas.get(r["villa_id"], {}).get("name", r["villa_id"]),
                   "role": r["role"]} for r in roles],
        "open": sum(t["status"] != "closed" for t in mine),
        "resolved": len(resolved),
        "avg_resolve_minutes": round(sum(resolved) / len(resolved)) if resolved else None,
        "window_open": operators.window_open(p["id"]),
    }


# ---------------- loaded when someone opens them ----------------

def conversation(booking_id: str) -> dict | None:
    """One booking's WhatsApp conversation with Gia and everything ops needs beside it: who's handling it, the
    pre-arrival messages, waiting handoffs, the guest's details, their guest profile (preferences from every stay,
    each linked to the message it came from) and their requests."""
    b = store.get_booking(booking_id)
    if not b:
        return None
    now = store.now()
    today = now.date()
    villa = store.get_villa(b["villa_id"]) or {}
    names = {booking_id: b["guest_name"]}
    messages, total = store.messages_for_booking(booking_id, MESSAGES_PER_BOOKING)
    rec = store.booking_record(booking_id)
    steps = store.steps_for_booking(booking_id)
    inbound = store.last_inbound_at(b["guest_phone"])
    staff = {p["id"]: p for p in store.all_staff()}
    tickets = [portfolio.ticket_view(t, {b["villa_id"]: villa}, names, staff, now) for t in rec["tickets"]]
    profile = preferences.profile(b)
    return {
        "booking": {**portfolio.booking_summary(b, today, villa), "phone": b["guest_phone"],
                    "language": b.get("language"), "villa_id": b["villa_id"], "villa": villa.get("name", b["villa_id"]),
                    "pre_booked_services": b.get("pre_booked_services") or []},
        "messages": [{k: m.get(k) for k in ("id", "direction", "body", "at", "status", "error")} for m in messages],
        "total_messages": total,
        "takeover": store.takeover_active(b["guest_phone"]),
        "last_inbound_at": inbound,
        "window_open": bool(inbound and now - datetime.fromisoformat(inbound) < SERVICE_WINDOW),
        "journey": [{"step": scheduler.STEP_LABELS[name], **{k: steps[name][k] for k in
                     ("status", "due_at", "sent_at", "delivered_at", "read_at", "channel", "note")}}
                    for name in scheduler.STEPS if name in steps],
        "handoffs": [{k: h[k] for k in ("id", "reason", "urgency", "status", "at")} for h in rec["handoffs"]],
        "details": store.guest_details(booking_id),
        "profile": {k: profile[k] for k in ("guest_id", "since", "stays")},
        "preferences": profile["preferences"],
        "tickets": tickets,
        # Takeovers and ticket changes, shown as notes and chips in the chat (oldest first).
        "events": [_activity(e, names) for e in reversed(rec["audit"])
                   if e["action"] in CHAT_NOTES or e["action"] in ("handoff_raised", "ticket_escalated")
                   or e["action"].startswith("ticket_status:")],
    }


def ticket(ticket_id: int) -> dict | None:
    """One ticket with its history and the guest's words that led to it."""
    t = store.get_ticket(ticket_id)
    if not t:
        return None
    now = store.now()
    b = store.get_booking(t["booking_id"]) or {}
    villa = store.get_villa(t["villa_id"]) or {}
    names = {t["booking_id"]: b.get("guest_name", "")}
    staff = {p["id"]: p for p in store.all_staff()}
    view = portfolio.ticket_view(t, {t["villa_id"]: villa}, names, staff, now)
    history = [_activity(e, names) for e in reversed(store.audit_for_bookings([t["booking_id"]], 500))
               if _data(e).get("ticket") == t["ref"]]
    messages, _ = store.messages_for_booking(t["booking_id"], 200)
    before = [m for m in messages if m["direction"] == "in" and m["at"] <= t["created_at"]]
    since = (datetime.fromisoformat(t["created_at"]) - EXCERPT_WINDOW).isoformat()
    asked = [m for m in before if m["at"] >= since][-EXCERPT_LENGTH:] or before[-1:]
    return {
        **view, "history": history,
        "excerpt": [{k: m[k] for k in ("body", "at")} for m in asked] if view["notifies_guest"] else [],
        "booking": portfolio.booking_summary(b, now.date(), villa) if b else None,
        "villa_location": villa.get("location", ""),
    }


def operator(staff_id: int) -> dict | None:
    """A field operator's WhatsApp thread and open tasks (the Team tab and the ticket's "Message operator")."""
    p = store.get_staff(staff_id)
    if not p:
        return None
    now = store.now()
    villas = {v["villa_id"]: v for v in store.all_villas()}
    rows = store.tickets_for_operator(staff_id)
    names = {b: (store.get_booking(b) or {}).get("guest_name", "") for b in {t["booking_id"] for t in rows}}
    mine = [portfolio.ticket_view(t, villas, names, {staff_id: p}, now) for t in rows]
    return {
        **_operator_summary(p, mine, store.operator_roles().get(staff_id, []), villas),
        "messages": [{k: m[k] for k in ("direction", "body", "at", "ticket_ref")}
                     for m in store.operator_messages(staff_id, MESSAGES_PER_OPERATOR)],
        "tasks": [t for t in mine if t["status"] != "closed"],
    }


def _data(entry: dict) -> dict:
    try:
        return json.loads(entry["data"] or "{}")
    except (TypeError, ValueError):
        return {}


STATUS_WORDS = {"closed": "resolved", "in_progress": "in progress"}


def _activity(entry: dict, names: dict) -> dict:
    """One audit entry as a line a person can read: who acted (ai, human, system) and what happened."""
    action, d = entry["action"], _data(entry)
    guest = names.get(entry["booking_id"]) or entry["booking_id"] or "a guest"
    first = guest.split()[0]
    who, title, text = "system", action.replace("_", " ").capitalize(), ""

    if action == "handoff_to_human":
        who, title, text = "ai", ("Urgent handoff" if d.get("urgency") == "urgent" else "Handed to a person"), \
            f"Gia passed {guest} to the control tower: {d.get('reason', '')}"
    elif action == "create_ticket":
        who, title, text = "ai", "Ticket requested", f"{d.get('category', '').capitalize()} · {d.get('summary', '')}"
    elif action == "ticket_raised":
        who = "ai" if d.get("source") == "guest" else "system"
        title = f"{d.get('ticket')} created"
        text = f"{d.get('category', '').replace('_', ' ').capitalize()} · {d.get('severity', '')} · for {guest}"
    elif action.startswith("ticket_status:"):
        status = STATUS_WORDS.get(action.split(":", 1)[1], action.split(":", 1)[1].replace("_", " "))
        who, title = "human", f"{d.get('ticket')} → {status}"
        text = f"By {d.get('by') or 'ops'}" + (f" · “{d['note']}”" if d.get("note") else "")
    elif action == "ticket_escalated":
        who, title, text = "human", f"{d.get('ticket')} escalated", d.get("reason", "")
    elif action == "ticket_deescalated":
        who, title, text = "human", f"{d.get('ticket')} no longer escalated", f"By {d.get('by') or 'ops'}"
    elif action == "message_failed":
        title, text = "Message not delivered", f"WhatsApp didn’t take a message to {guest}: {d.get('error', '')}"
    elif action == "save_arrival_details":
        fields = ", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in d.items() if v not in (None, "", []))
        who, title, text = "ai", "Arrival details saved", fields
    elif action in ("log_preference", "preference_saved"):  # log_preference: entries from before guest profiles
        who, title, text = "ai", "Preference saved", f"{d.get('preference', '')} (“{d.get('source_quote', '')}”)"
    elif action == "preference_removed":
        who, title, text = "ai", "Preference removed", f"{d.get('preference', '')} (“{d.get('source_quote', '')}”)"
    elif action == "get_villa_info":
        who, title, text = "ai", "Checked villa details", f"Gia looked up the villa for {first}"
    elif action == "get_my_tickets":
        who, title, text = "ai", "Checked tickets", f"Gia looked up {first}'s requests"
    elif action.startswith("uc_ops_01:"):
        step = scheduler.STEP_LABELS.get(action.split(":", 1)[1], action)
        who, title = "ai", f"{step} message sent"
        text = f"To {guest} by {'template ' + d['template'] if d.get('template') else 'free text'}"
    elif action == "t1_no_reply_flagged":
        title, text = "No reply before arrival", f"{d.get('ticket')} raised for {d.get('assigned_to', 'the villa team')}"
    elif action.startswith("oi_booking_"):
        title, text = f"OI booking {action.removeprefix('oi_booking_')}", f"{entry['booking_id']} · {guest}"
    elif action == "staff_alert":
        title, text = "Villa team alerted", f"{d.get('to')} ({d.get('role')}) on WhatsApp about {d.get('ticket')}"
    elif action in ("staff_alert_skipped", "staff_alert_failed"):
        title, text = "Villa team not alerted", f"{d.get('ticket')}: {d.get('reason') or d.get('error', '')}"
    elif action == "ops_takeover":
        who, title, text = "human", "Ops took over the chat", f"Gia paused for {guest}"
    elif action == "ops_handback":
        who, title, text = "human", "Handed back to Gia", f"Gia resumed for {guest}"
    elif action == "ops_reply":
        who, title, text = "human", "Ops replied on WhatsApp", d.get("text", "")
    elif action == "handoff_raised":
        title, text = f"HO-{d.get('handoff')} opened", f"{d.get('urgency', 'normal').capitalize()} · control tower notified"
    elif action == "handoff_resolved":
        who, title, text = "human", f"HO-{d.get('handoff')} resolved", f"Handoff for {guest} closed by ops"
    elif action == "operator_notified":
        title, text = "Operator told", f"{d.get('to')} got {d.get('ticket')} on WhatsApp"
    elif action == "operator_notify_failed":
        title, text = "Operator not reached", f"{d.get('ticket')} to {d.get('to')}: {d.get('error', '')}"
    elif action == "ticket_assigned":
        who, title, text = "human", f"{d.get('ticket')} reassigned", f"To {d.get('to')}"
    elif action == "operator_message":
        who, title, text = "human", f"{d.get('from')} (operator) wrote", d.get("text", "")
    elif action in ("villa_staff_assigned", "uc_ops_01_settings"):
        who = "human"
        title = "Villa staff assigned" if action == "villa_staff_assigned" else "Pre-arrival settings changed"
        text = ", ".join(d.get("villas") or [])

    return {"at": entry["at"], "booking_id": entry["booking_id"], "action": action, "who": who, "title": title,
            "text": text, "tier": entry["tier"], "ticket": d.get("ticket")}


# Toast-worthy events pop up on screen as they happen; the rest only appear in the Live activity list.
# Takeovers, ops replies, lookups and settings changes are left out on purpose: they aren't news to ops.
def _event(entry: dict, names: dict, by_ref: dict, villas: dict) -> dict | None:
    action, d = entry["action"], _data(entry)
    guest = names.get(entry["booking_id"]) or "A guest"
    t = by_ref.get(d.get("ticket")) if d.get("ticket") else None
    villa = t["villa"] if t else ""
    ev = {"id": entry["id"], "at": entry["at"], "booking_id": entry["booking_id"], "ticket": d.get("ticket"),
          "operator_id": d.get("staff_id") or (t["operator_id"] if t else None), "toast": False, "urgent": False}

    if action == "ticket_raised":
        if not t:
            return None
        owner = f"assigned to {t['operator']}" if t["operator"] else "with the control tower"
        return {**ev, "kind": "ticket", "toast": True, "urgent": t["severity"] == "urgent",
                "title": f"{t['ref']} raised for {guest}",
                "text": f"{t['summary']} · {t['category'].replace('_', ' ')}, {t['severity']} · {villa} · {owner}"}
    if action == "handoff_raised":  # every handoff, whether Gia asked for it or errored (NFR-08)
        urgent = d.get("urgency") == "urgent"
        return {**ev, "kind": "handoff", "toast": True, "urgent": urgent,
                "title": f"{guest} {'needs a person urgently' if urgent else 'is asking for a person'}",
                "text": d.get("reason", "")}
    if action == "ticket_status:closed":
        if not t:
            return None
        took = operators.duration(t["resolve_minutes"]) if t["status"] == "closed" else ""
        return {**ev, "kind": "resolved", "toast": True,
                "title": f"{t['ref']} resolved" + (f" in {took}" if took else ""),
                "text": f"{t['summary']} · {villa} · by {d.get('by', 'ops')}"}
    if action == "ticket_status:delayed" and t:
        return {**ev, "kind": "delayed", "toast": True, "title": f"{t['ref']} is running late",
                "text": f"{t['summary']} · {villa}"}
    if action == "ticket_escalated" and t:
        return {**ev, "kind": "flag", "toast": True, "urgent": True, "title": f"{t['ref']} escalated",
                "text": f"{t['summary']} · {villa} · {d.get('reason', '')}"}
    if action == "message_failed":
        return {**ev, "kind": "flag", "toast": True, "title": f"Message to {guest} not delivered",
                "text": d.get("error", "")}
    if action == "t1_no_reply_flagged":
        return {**ev, "kind": "flag", "toast": True, "title": f"No reply from {guest} before arrival",
                "text": f"{d.get('ticket')} raised for {d.get('assigned_to', 'the villa team')}"}
    if action in ("operator_notify_failed", "staff_alert_failed"):
        return {**ev, "kind": "flag", "toast": True, "title": f"Couldn't reach {d.get('to')} about {d.get('ticket')}",
                "text": d.get("error", "")}
    if action == "operator_message":
        return {**ev, "kind": "operator", "toast": True, "title": f"{d.get('from')} (operator) wrote",
                "text": d.get("text", "")}
    if action == "ticket_assigned" and t:
        return {**ev, "kind": "ticket", "title": f"{t['ref']} reassigned", "text": f"{t['summary']} · to {d.get('to')}"}
    if action.startswith("uc_ops_01:"):
        step = scheduler.STEP_LABELS.get(action.split(":", 1)[1], "Pre-arrival")
        return {**ev, "kind": "journey", "title": f"{step} message sent to {guest}", "text": "Pre-arrival message"}
    if action == "save_arrival_details":
        fields = ", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in d.items() if v not in (None, "", []))
        return {**ev, "kind": "profile", "title": f"Arrival details captured for {guest}", "text": fields}
    if action == "preference_saved":  # only when the profile changed, not each time Gia repeats one
        return {**ev, "kind": "profile", "title": f"Preference noted for {guest}",
                "text": f"{preferences.KIND_LABELS.get(d.get('kind'), 'Likes')} · {d.get('preference', '')}"}
    if action == "preference_removed":
        return {**ev, "kind": "profile", "title": f"Preference removed for {guest}", "text": d.get("preference", "")}
    if action in ("oi_booking_confirmed", "oi_booking_cancelled"):
        return {**ev, "kind": "booking", "title": f"Booking {action.removeprefix('oi_booking_')} · {guest}",
                "text": entry["booking_id"] or ""}
    return None
