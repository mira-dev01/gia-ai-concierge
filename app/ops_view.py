"""Live data for the ops console (/): one snapshot of bookings, conversations, tickets, handoffs, field operators
and the activity that matters, shaped for the console's screens. Read-only; the console's actions are routes in
main.py."""

import json
from datetime import date, datetime, timedelta

from . import operators, scheduler, store

MESSAGES_PER_BOOKING = 150
MESSAGES_PER_OPERATOR = 100
EVENTS_LENGTH = 30
IN_CONVERSATION = timedelta(minutes=15)  # a guest who wrote this recently is "in conversation"


def snapshot(ticket_statuses: list[str]) -> dict:
    now = store.now()
    today = now.date()
    villas = {v["villa_id"]: v for v in store.all_villas()}
    bookings = store.all_bookings()
    names = {b["booking_id"]: b["guest_name"] for b in bookings}
    taken_over = store.takeover_phones()
    all_steps = store.all_steps()

    staff = {p["id"]: p for p in store.all_staff()}
    tickets = [_ticket(t, villas, names, staff, now) for t in store.all_tickets()]
    by_ref = {t["ref"]: t for t in tickets}
    ticket_history: dict[str, list] = {t["ref"]: [] for t in tickets}

    out_bookings = []
    for b in bookings:
        rec = store.booking_record(b["booking_id"])
        for entry in rec["audit"]:
            ref = _data(entry).get("ticket")
            if ref in ticket_history:
                ticket_history[ref].append(_activity(entry, names))
        villa = villas.get(b["villa_id"], {})
        contacts = store.staff_for_villa(b["villa_id"])
        steps = all_steps.get(b["booking_id"], {})
        last_in = max((m["at"] for m in rec["messages"] if m["direction"] == "in"), default=None)
        out_bookings.append({
            "id": b["booking_id"],
            "name": b["guest_name"],
            "phone": b["guest_phone"],
            "language": b.get("language"),
            "villa_id": b["villa_id"],
            "villa": villa.get("name", b["villa_id"]),
            "location": villa.get("location", ""),
            "check_in": b["check_in"],
            "check_out": b["check_out"],
            "status": b["status"],
            "stage": _stage(b, today),
            "adults": b.get("adults"), "children": b.get("children"), "pets": b.get("pets"),
            "occasion": b.get("occasion"), "vip": bool(b.get("vip")),
            "pre_booked_services": b.get("pre_booked_services") or [],
            "details": store.guest_details(b["booking_id"]),
            "preferences": [{k: p[k] for k in ("category", "preference", "source_quote", "at")}
                            for p in rec["preferences"]],
            "messages": [{k: m[k] for k in ("direction", "body", "at")}
                         for m in rec["messages"][-MESSAGES_PER_BOOKING:]],
            "journey": [{"step": scheduler.STEP_LABELS[name], **{k: steps[name][k] for k in
                         ("status", "due_at", "sent_at", "delivered_at", "read_at", "channel", "note")}}
                        for name in scheduler.STEPS if name in steps],
            "takeover": b["guest_phone"] in taken_over,
            "last_inbound_at": last_in,
            "in_conversation": bool(last_in and now - datetime.fromisoformat(last_in) < IN_CONVERSATION),
            "staff": {role: p["name"] for role, p in contacts.items()},
            "host": (villa.get("host") or {}).get("name"),
            "activity": [_activity(e, names) for e in rec["audit"]],
        })
    for t in tickets:
        t["history"] = list(reversed(ticket_history[t["ref"]]))  # oldest first, like a ticket's own log

    handoffs = [{
        "id": h["id"], "booking_id": h["booking_id"], "guest": names.get(h["booking_id"], h["phone"]),
        "villa": villas.get(_villa_of(h["booking_id"], bookings), {}).get("name", ""),
        "reason": h["reason"], "urgency": h["urgency"], "status": h["status"], "at": h["at"],
    } for h in store.all_handoffs()]

    roles = store.operator_roles()
    ops = []
    for p in staff.values():
        mine = [t for t in tickets if t["operator_id"] == p["id"]]
        resolved = [t["resolve_minutes"] for t in mine if t["resolve_minutes"] is not None]
        ops.append({
            "id": p["id"], "name": p["name"], "phone": p["phone"], "presence": p.get("presence") or "onsite",
            "roles": [{"villa_id": r["villa_id"], "villa": villas.get(r["villa_id"], {}).get("name", r["villa_id"]),
                       "role": r["role"]} for r in roles.get(p["id"], [])],
            "open": sum(t["status"] != "closed" for t in mine),
            "resolved": len(resolved),
            "avg_resolve_minutes": round(sum(resolved) / len(resolved)) if resolved else None,
            "window_open": operators.window_open(p["id"]),
            "messages": [{k: m[k] for k in ("direction", "body", "at", "ticket_ref")}
                         for m in store.operator_messages(p["id"], MESSAGES_PER_OPERATOR)],
        })

    events = []
    for e in store.audit_log(EVENTS_LENGTH * 6):
        ev = _event(e, names, by_ref, villas)
        if ev:
            events.append(ev)

    return {
        "now": now.isoformat(),
        "ticket_statuses": ticket_statuses,
        "villas": [{"id": v["villa_id"], "name": v["name"], "location": v.get("location", ""),
                    "caps": _capabilities(v)} for v in villas.values()],
        "bookings": out_bookings,
        "tickets": tickets,
        "handoffs": handoffs,
        "operators": ops,
        "operator_roles": list(store.OPERATOR_ROLES),
        "events": events[:EVENTS_LENGTH],
    }


def _stage(b: dict, today: date) -> str:
    if b["status"] == "cancelled":
        return "Cancelled"
    check_in, check_out = date.fromisoformat(b["check_in"]), date.fromisoformat(b["check_out"])
    if b["status"] == "in_stay" or (b["status"] == "confirmed" and check_in <= today < check_out):
        return "In stay"
    if today < check_in:
        return "Pre-arrival"
    return "Post-stay"


def _ticket(t: dict, villas: dict, names: dict, staff: dict, now: datetime) -> dict:
    due = datetime.fromisoformat(t["due_at"]) if t["due_at"] else None
    resolved_at = t["resolved_at"] or (t["updated_at"] if t["status"] == "closed" else None)  # closed before tracking
    minutes = operators.minutes_to_resolve({**t, "resolved_at": resolved_at})
    op = staff.get(t["operator_id"])
    return {
        "id": t["id"], "ref": t["ref"], "booking_id": t["booking_id"], "guest": names.get(t["booking_id"], ""),
        "villa_id": t["villa_id"], "villa": villas.get(t["villa_id"], {}).get("name", t["villa_id"]),
        "category": t["category"], "severity": t["severity"], "summary": t["summary"], "details": t["details"],
        "status": t["status"], "assignee": t["assignee"] or "Unassigned", "source": t["source"] or "guest",
        "notifies_guest": t["source"] in (None, "guest"),
        "created_at": t["created_at"], "due_at": t["due_at"], "updated_at": t["updated_at"],
        "overdue": bool(due and t["status"] != "closed" and now > due),
        "operator_id": op["id"] if op else None,
        "operator": op["name"] if op else None,
        "resolved_at": resolved_at, "resolved_by": t["resolved_by"],
        "resolve_minutes": minutes,
        "within_sla": bool(resolved_at and due and datetime.fromisoformat(resolved_at) <= due) if resolved_at else None,
    }


def _villa_of(booking_id: str | None, bookings: list[dict]) -> str | None:
    return next((b["villa_id"] for b in bookings if b["booking_id"] == booking_id), None)


def _capabilities(v: dict) -> list[dict]:
    """What the villa can and can't do, from its capability record: the console's read-only list."""
    caps = []
    pool = v.get("pool") or {}
    if pool:
        caps.append({"label": "Pool", "ok": bool(pool.get("available")), "note": pool.get("type", "")})
    for key, s in (v.get("services") or {}).items():
        note = s.get("price", "") if s.get("available") else s.get("alternative", "Not available")
        caps.append({"label": key.replace("_", " ").capitalize(), "ok": bool(s.get("available")), "note": note})
    pets = v.get("pets") or {}
    if pets:
        caps.append({"label": "Pets", "ok": bool(pets.get("allowed")), "note": "" if pets.get("allowed") else "Not allowed"})
    return caps


def _data(entry: dict) -> dict:
    try:
        return json.loads(entry["data"] or "{}")
    except (TypeError, ValueError):
        return {}


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
        status = action.split(":", 1)[1].replace("_", " ")
        who, title, text = "human", f"{d.get('ticket')} → {status}", f"Ops updated the ticket for {guest}"
    elif action == "save_arrival_details":
        fields = ", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in d.items() if v not in (None, "", []))
        who, title, text = "ai", "Arrival details saved", fields
    elif action == "log_preference":
        who, title, text = "ai", "Preference saved", f"{d.get('preference', '')} (“{d.get('source_quote', '')}”)"
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
        title = "Villa staff assigned" if action == "villa_staff_assigned" else "UC-OPS-01 settings changed"
        text = ", ".join(d.get("villas") or [])

    return {"at": entry["at"], "booking_id": entry["booking_id"], "action": action, "who": who, "title": title,
            "text": text, "tier": entry["tier"]}


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
        return {**ev, "kind": "journey", "title": f"{step} message sent to {guest}", "text": "UC-OPS-01 pre-arrival journey"}
    if action == "save_arrival_details":
        fields = ", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in d.items() if v not in (None, "", []))
        return {**ev, "kind": "profile", "title": f"Arrival details captured for {guest}", "text": fields}
    if action == "log_preference":
        return {**ev, "kind": "profile", "title": f"Preference noted for {guest}", "text": d.get("preference", "")}
    if action in ("oi_booking_confirmed", "oi_booking_cancelled"):
        return {**ev, "kind": "booking", "title": f"Booking {action.removeprefix('oi_booking_')} · {guest}",
                "text": entry["booking_id"] or ""}
    return None
