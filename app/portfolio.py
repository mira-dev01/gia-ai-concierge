"""Portfolio rules every screen of the ops console shares: what a booking's status means, whether a villa is
occupied today, how ready it is for its next guest, and what needs a person. Overview, Properties and Operations
all read them from here, so a count on one screen agrees with the same count on another.

Occupancy comes only from confirmed bookings (never from a conversation or a ticket). Readiness is never shown as
ready: no turnover checklist is tracked yet, so a villa is either blocked by an open maintenance or housekeeping
ticket, or not assessed."""

from datetime import date, datetime, time

from . import operators, store

# OI booking statuses by what they mean for a stay. Any other status is shown as not recognised and is never
# counted as a confirmed stay.
CONFIRMED = ("confirmed", "in_stay")
COMPLETED = ("checked_out", "completed", "departed")
CANCELLED = ("cancelled", "canceled")
TENTATIVE = ("tentative", "pending", "provisional", "hold", "enquiry", "inquiry")
STATE_LABELS = {"completed": "Checked out", "cancelled": "Cancelled", "tentative": "Tentative · not confirmed"}

PRE_ARRIVAL_DAYS = 7  # a villa with no one in it and a confirmed arrival this close is "pre-arrival"
READINESS_CATEGORIES = ("maintenance", "housekeeping")  # open tickets of these kinds block a villa's readiness
DEFAULT_CHECK_IN = time(14, 0)
STAY_LABELS = {"occupied": "Occupied", "checkout": "Checkout today", "turnover": "Turnover today",
               "pre_arrival": "Pre-arrival", "vacant": "Vacant", "conflict": "Booking conflict", "unknown": "Unknown"}
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2}


# ---------------- bookings ----------------

def _status(b: dict) -> str:
    return str(b.get("status") or "").strip().lower().replace("-", "_").replace(" ", "_")


def booking_state(b: dict) -> str:
    """confirmed, completed, cancelled, tentative, or unrecognised (a status this console doesn't know)."""
    s = _status(b)
    for state, statuses in (("confirmed", CONFIRMED), ("completed", COMPLETED), ("cancelled", CANCELLED),
                            ("tentative", TENTATIVE)):
        if s in statuses:
            return state
    return "unrecognised"


def booking_label(b: dict) -> str:
    state = booking_state(b)
    if state == "confirmed":
        return "Checked in" if _status(b) == "in_stay" else "Confirmed"
    if state == "unrecognised":
        return f"Status not recognised: {b.get('status') or 'none'}"
    return STATE_LABELS[state]


def stay_dates(b: dict) -> tuple[date, date] | None:
    try:
        return date.fromisoformat(b["check_in"]), date.fromisoformat(b["check_out"])
    except (KeyError, TypeError, ValueError):
        return None


def presence(b: dict, today: date) -> str | None:
    """Where a confirmed booking's guest is today: arriving, in_house, departing, upcoming or past.
    None when the booking isn't confirmed or has no usable dates."""
    dates = stay_dates(b)
    if booking_state(b) != "confirmed" or not dates:
        return None
    check_in, check_out = dates
    if check_out < today:
        return "past"
    if check_in > today:
        return "upcoming"
    if check_out == today:
        return "departing"  # here until checkout
    if check_in == today and _status(b) != "in_stay":
        return "arriving"   # due today; in the villa once OI marks them checked in
    return "in_house"


def stage(b: dict, today: date) -> str:
    """The guest's journey stage, from the same rules as the villa's occupancy."""
    state = booking_state(b)
    if state != "confirmed":
        return {"cancelled": "Cancelled", "tentative": "Tentative", "completed": "Post-stay"}.get(state, "Unconfirmed")
    return {"arriving": "Pre-arrival", "upcoming": "Pre-arrival", "in_house": "In stay",
            "departing": "In stay"}.get(presence(b, today), "Post-stay")


def booking_summary(b: dict, today: date, villa: dict | None = None) -> dict:
    """What property screens show of a booking. No phone number: the conversation panel has it."""
    dates = stay_dates(b)
    return {
        "id": b["booking_id"], "guest": b.get("guest_name") or "Name not available",
        "check_in": b.get("check_in"), "check_out": b.get("check_out"),
        "status": b.get("status"), "state": booking_state(b), "label": booking_label(b),
        "stage": stage(b, today), "presence": presence(b, today),
        "days_to_arrival": (dates[0] - today).days if dates else None,
        "arrival_time": (villa or {}).get("check_in_time"),
        "adults": b.get("adults"), "children": b.get("children"), "pets": b.get("pets"),
        "occasion": b.get("occasion"), "vip": bool(b.get("vip")),
    }


def _overlapping(bookings: list[dict]) -> list[tuple[dict, dict]]:
    """Pairs of confirmed bookings whose nights overlap (one checking out the day another checks in is fine)."""
    pairs = []
    for i, a in enumerate(bookings):
        for b in bookings[i + 1:]:
            (a_in, a_out), (b_in, b_out) = stay_dates(a), stay_dates(b)
            if a_in < b_out and b_in < a_out:
                pairs.append((a, b))
    return pairs


def villa_stay(bookings: list[dict], today: date, villa: dict | None = None) -> dict:
    """Today at one villa, from its bookings: the stay status, the current guest and the next confirmed arrival."""
    live = sorted((b for b in bookings if presence(b, today) not in (None, "past")), key=lambda b: b["check_in"])
    where = {b["booking_id"]: presence(b, today) for b in live}
    pick = lambda *kinds: [b for b in live if where[b["booking_id"]] in kinds]  # noqa: E731
    in_house, departing, arriving = pick("in_house"), pick("departing"), pick("arriving")
    upcoming = pick("arriving", "upcoming")
    conflicts = _overlapping(live)
    unclear = [b for b in bookings if booking_state(b) == "unrecognised"
               and (not stay_dates(b) or stay_dates(b)[0] <= today <= stay_dates(b)[1])]
    nxt = upcoming[0] if upcoming else None
    days_out = (stay_dates(nxt)[0] - today).days if nxt else None

    if conflicts:
        key = "conflict"
    elif unclear:
        key = "unknown"   # a booking we can't read covers today, so we can't say who's there
    elif departing and arriving:
        key = "turnover"
    elif departing:
        key = "checkout"
    elif in_house:
        key = "occupied"
    elif nxt and days_out <= PRE_ARRIVAL_DAYS:
        key = "pre_arrival"
    else:
        key = "vacant"
    label = "Arriving today" if key == "pre_arrival" and arriving else STAY_LABELS[key]
    current = (in_house or departing or [None])[0]
    return {
        "key": key, "label": label,
        "current": booking_summary(current, today, villa) if current else None,
        "next": booking_summary(nxt, today, villa) if nxt else None,
        "next_arrival_at": _arrival_at(nxt, villa).isoformat() if nxt else None,
        "tentative": [booking_summary(b, today, villa) for b in bookings if booking_state(b) == "tentative"
                      and stay_dates(b) and stay_dates(b)[1] >= today],
        "conflicts": [[a["booking_id"], b["booking_id"]] for a, b in conflicts],
        "unclear": [booking_summary(b, today, villa) for b in unclear],
    }


def _arrival_at(b: dict, villa: dict | None) -> datetime:
    """A booking's check-in date at the villa's check-in time, in IST."""
    try:
        at = time.fromisoformat((villa or {}).get("check_in_time") or "")
    except ValueError:
        at = DEFAULT_CHECK_IN
    return datetime.combine(stay_dates(b)[0], at, tzinfo=store.IST)


def readiness(open_tickets_here: list[dict]) -> dict:
    """Never 'ready': that needs a turnover checklist, which isn't tracked yet. An open maintenance or
    housekeeping ticket at the villa blocks it; otherwise it's not assessed."""
    blockers = [t for t in open_tickets_here if t["category"] in READINESS_CATEGORIES]
    if blockers:
        n = len(blockers)
        return {"key": "blocked", "label": "Blocked",
                "text": f"{n} open maintenance or housekeeping ticket{'s' if n > 1 else ''}",
                "blockers": [t["ref"] for t in blockers]}
    return {"key": "not_assessed", "label": "Not assessed",
            "text": "No turnover checklist is tracked for this villa yet", "blockers": []}


# ---------------- tickets and handoffs, as every screen shows them ----------------

def ticket_view(t: dict, villas: dict, names: dict, staff: dict, now: datetime) -> dict:
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
        "escalated": bool(t.get("escalated_at")) and t["status"] != "closed",
        "escalated_at": t.get("escalated_at"), "escalation_reason": t.get("escalation_reason"),
        "operator_id": op["id"] if op else None,
        "operator": op["name"] if op else None,
        "resolved_at": resolved_at, "resolved_by": t["resolved_by"], "resolution_note": t.get("resolution_note"),
        "resolve_minutes": minutes,
        "within_sla": bool(resolved_at and due and datetime.fromisoformat(resolved_at) <= due) if resolved_at else None,
    }


def handoff_view(h: dict, villas: dict, names: dict, villa_of: dict) -> dict:
    villa_id = villa_of.get(h["booking_id"])
    return {"id": h["id"], "booking_id": h["booking_id"], "guest": names.get(h["booking_id"], h["phone"]),
            "villa_id": villa_id, "villa": villas.get(villa_id, {}).get("name", ""),
            "reason": h["reason"], "urgency": h["urgency"], "status": h["status"], "at": h["at"]}


def load() -> dict:
    """Everything the portfolio rules read, loaded once per request."""
    now = store.now()
    villas = {v["villa_id"]: v for v in store.all_villas()}
    bookings = store.all_bookings()
    names = {b["booking_id"]: b["guest_name"] for b in bookings}
    villa_of = {b["booking_id"]: b["villa_id"] for b in bookings}
    staff = {p["id"]: p for p in store.all_staff()}
    return {
        "now": now, "today": now.date(), "villas": villas, "bookings": bookings, "names": names, "staff": staff,
        "tickets": [ticket_view(t, villas, names, staff, now) for t in store.all_tickets()],
        "handoffs": [handoff_view(h, villas, names, villa_of) for h in store.all_handoffs()],
        "last_out": store.last_outbound_status_by_booking(),
    }


def bookings_by_villa(base: dict) -> dict[str, list[dict]]:
    return group_by_villa(base["bookings"], base["villas"])


def group_by_villa(records: list[dict], villas) -> dict[str, list[dict]]:
    """Records (bookings, tickets, attention items) grouped by villa_id in one pass; every villa has a list."""
    out: dict[str, list[dict]] = {v: [] for v in villas}
    for r in records:
        out.setdefault(r["villa_id"], []).append(r)
    return out


def for_villa(base: dict, villa_id: str) -> dict:
    """The same base narrowed to one villa, so its rules run over that villa's records only."""
    return {**base, "villas": {villa_id: base["villas"][villa_id]},
            "bookings": [b for b in base["bookings"] if b["villa_id"] == villa_id],
            "tickets": [t for t in base["tickets"] if t["villa_id"] == villa_id],
            "handoffs": [h for h in base["handoffs"] if h["villa_id"] == villa_id]}


# ---------------- what needs a person ----------------

def attention(base: dict) -> list[dict]:
    """Everything a person should act on now, most severe first: guests waiting for a person, escalated, urgent,
    overdue, delayed or unassigned tickets, messages that didn't reach the guest, and bookings that can't both be
    right. Overview's list, the navigation badges and each property's attention summary all come from here."""
    today, items = base["today"], []
    villa_name = lambda vid: base["villas"].get(vid, {}).get("name", vid or "")  # noqa: E731

    for h in base["handoffs"]:
        if h["status"] != "waiting":
            continue
        urgent = h["urgency"] == "urgent"
        items.append({"key": f"HO-{h['id']}", "kind": "handoff", "severity": "critical" if urgent else "high",
                      "title": h["reason"], "reasons": ["Urgent · needs a person" if urgent else "Waiting for a person"],
                      "villa_id": h["villa_id"], "villa": h["villa"], "booking_id": h["booking_id"],
                      "guest": h["guest"], "ref": f"HO-{h['id']}", "at": h["at"], "action": "Open conversation"})

    for t in base["tickets"]:
        if t["status"] == "closed":
            continue
        unassigned = not t["operator_id"]
        reasons = [r for r, on in (("Escalated", t["escalated"]), ("Urgent", t["severity"] == "urgent"),
                                   ("Overdue", t["overdue"]), ("Delayed", t["status"] == "delayed"),
                                   ("Unassigned", unassigned)) if on]
        if not reasons:
            continue
        severity = ("critical" if t["escalated"] or t["severity"] == "urgent"
                    else "high" if t["overdue"] or t["status"] == "delayed" or t["severity"] == "high"
                    else "medium")
        items.append({"key": t["ref"], "kind": "ticket", "severity": severity, "title": t["summary"],
                      "reasons": reasons, "due_at": t["due_at"], "status": t["status"],
                      "villa_id": t["villa_id"], "villa": t["villa"], "booking_id": t["booking_id"],
                      "guest": t["guest"], "ref": t["ref"], "ticket_id": t["id"], "at": t["created_at"],
                      "action": "Assign operator" if unassigned else "Update progress"})

    for vid, bookings in bookings_by_villa(base).items():
        live = [b for b in bookings if presence(b, today) not in (None, "past")]
        for a, b in _overlapping(live):
            items.append({"key": f"conflict-{a['booking_id']}-{b['booking_id']}", "kind": "booking",
                          "severity": "high", "reasons": ["Booking conflict"],
                          "title": f"Overlapping confirmed bookings {a['booking_id']} and {b['booking_id']}",
                          "villa_id": vid, "villa": villa_name(vid), "booking_id": a["booking_id"],
                          "guest": "", "ref": a["booking_id"], "at": max(a["check_in"], b["check_in"]),
                          "action": "Open property"})
        for b in bookings:
            dates = stay_dates(b)
            if booking_state(b) == "unrecognised" and (not dates or dates[1] >= today):
                items.append({"key": f"status-{b['booking_id']}", "kind": "booking", "severity": "medium",
                              "reasons": ["Booking status unclear"],
                              "title": f"{b['booking_id']} has status “{b.get('status') or 'none'}”, which isn’t a "
                                       "recognised OI status", "villa_id": vid, "villa": villa_name(vid),
                              "booking_id": b["booking_id"], "guest": b.get("guest_name", ""),
                              "ref": b["booking_id"], "at": b.get("check_in") or "", "action": "Open property"})
            elif base["last_out"].get(b["booking_id"]) == "failed" and presence(b, today) not in (None, "past"):
                items.append({"key": f"msg-{b['booking_id']}", "kind": "message", "severity": "high",
                              "reasons": ["Message not delivered"],
                              "title": f"The last message to {b['guest_name']} didn’t reach them",
                              "villa_id": vid, "villa": villa_name(vid), "booking_id": b["booking_id"],
                              "guest": b["guest_name"], "ref": b["booking_id"], "at": b["check_in"],
                              "action": "Open conversation"})

    return sorted(items, key=lambda a: (SEVERITY_RANK[a["severity"]], a["at"] or ""))


def attention_summary(items: list[dict]) -> dict:
    """One villa's attention at a glance: how many items, the worst severity and the most important one."""
    if not items:
        return {"count": 0, "severity": None, "top": None}
    top = items[0]
    return {"count": len(items), "severity": top["severity"],
            "top": {"title": top["title"], "reasons": top["reasons"], "kind": top["kind"], "ref": top["ref"]}}
