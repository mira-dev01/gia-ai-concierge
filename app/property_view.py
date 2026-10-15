"""The ops console's Properties workspace: a searchable register of the whole portfolio, and one property's profile
(its stay, readiness, attention, facilities, team and guest conversations). Filtering, sorting and paging happen
here, so the console only ever receives the page of villas it shows. Status rules come from portfolio.py."""

from datetime import datetime, timedelta

from . import ops_view, portfolio, scheduler, store

STAY_FILTERS = {
    "all": lambda r: True,
    "occupied": lambda r: r["stay"]["key"] == "occupied",
    "pre_arrival": lambda r: r["stay"]["key"] == "pre_arrival",
    "turnover": lambda r: r["stay"]["key"] in ("checkout", "turnover"),
    "vacant": lambda r: r["stay"]["key"] == "vacant",
    "attention": lambda r: r["attention"]["count"] > 0,
}
ARRIVAL_WINDOWS = {"today": None, "48h": timedelta(hours=48), "7d": timedelta(days=7)}
SORTS = ("arrival", "attention", "overdue", "name")
MAX_PAGE = 200
RECENT_PAST_STAYS = 2      # past stays kept on a property's timeline and conversation list
RESOLVED_SHOWN = 5         # recently resolved tickets shown on a property
ACTIVITY_LENGTH = 15


def _rows(base: dict, managers: dict) -> list[dict]:
    """Every villa's register row: identity, today's stay, next arrival, readiness and attention."""
    items = portfolio.group_by_villa(portfolio.attention(base), base["villas"])
    bookings = portfolio.bookings_by_villa(base)
    open_by_villa = portfolio.group_by_villa([t for t in base["tickets"] if t["status"] != "closed"], base["villas"])
    rows = []
    for vid, v in base["villas"].items():
        open_here = open_by_villa[vid]
        stay = portfolio.villa_stay(bookings.get(vid, []), base["today"], v)
        rows.append({
            "id": vid, "name": v.get("name", vid), "location": v.get("location", ""), "area": v.get("area", ""),
            "residency": v.get("residency", ""), "group": v.get("group", ""),
            "manager": managers.get(vid),
            "stay": {k: stay[k] for k in ("key", "label", "current", "next", "next_arrival_at")},
            "has_bookings": bool(bookings.get(vid)),
            "readiness": portfolio.readiness(open_here),
            "attention": portfolio.attention_summary(items[vid]),
            "overdue": sum(t["overdue"] for t in open_here),
            "open_tickets": len(open_here),
        })
    return rows


def _matches(row: dict, q: str) -> bool:
    hay = " ".join(str(row.get(k) or "") for k in ("id", "name", "location", "area", "residency", "group"))
    hay = (hay + " " + ((row["manager"] or {}).get("name") or "")).lower()
    return all(word in hay for word in q.lower().split())


def _arrives_within(row: dict, window: str, base: dict) -> bool:
    nxt = row["stay"]["next"]
    if not nxt:
        return False
    if window == "today":
        return nxt["days_to_arrival"] == 0
    return datetime.fromisoformat(row["stay"]["next_arrival_at"]) <= base["now"] + ARRIVAL_WINDOWS[window]


def _sort_key(sort: str):
    def by_name(r):
        return r["name"].lower()
    if sort == "attention":
        return lambda r: (portfolio.SEVERITY_RANK.get(r["attention"]["severity"], 9), -r["attention"]["count"], by_name(r))
    if sort == "overdue":
        return lambda r: (-r["overdue"], portfolio.SEVERITY_RANK.get(r["attention"]["severity"], 9), by_name(r))
    if sort == "arrival":
        return lambda r: (r["stay"]["next_arrival_at"] is None, r["stay"]["next_arrival_at"] or "", by_name(r))
    return by_name


def register(q: str = "", stay: str = "all", arrivals: str = "", blockers: bool = False, location: str = "",
             manager: str = "", sort: str = "arrival", offset: int = 0, limit: int = 50) -> dict:
    """One page of the property register. The stay-filter counts are taken after every other filter, so each
    chip says how many villas it would show."""
    if stay not in STAY_FILTERS or (arrivals and arrivals not in ARRIVAL_WINDOWS) or sort not in SORTS:
        raise ValueError("Unknown filter or sort")
    base = portfolio.load()
    managers = store.villa_managers()
    all_rows = _rows(base, managers)
    scoped = [r for r in all_rows
              if (not q.strip() or _matches(r, q))
              and (not location or r["area"] == location)
              and (not manager or (str((r["manager"] or {}).get("id")) == manager if manager != "none" else not r["manager"]))
              and (not arrivals or _arrives_within(r, arrivals, base))
              and (not blockers or r["readiness"]["key"] == "blocked")]
    shown = sorted((r for r in scoped if STAY_FILTERS[stay](r)), key=_sort_key(sort))
    limit = max(1, min(limit, MAX_PAGE))
    offset = max(0, offset)
    manager_names = {m["id"]: m["name"] for m in managers.values()}
    return {
        "now": base["now"].isoformat(),
        "bookings_updated_at": store.bookings_updated_at(),
        "total": len(shown), "portfolio_total": len(all_rows), "offset": offset, "limit": limit,
        "rows": shown[offset:offset + limit],
        "counts": {key: sum(fn(r) for r in scoped) for key, fn in STAY_FILTERS.items()},
        "facets": {
            "locations": sorted({r["area"] for r in all_rows if r["area"]}),
            "managers": [{"id": i, "name": n} for i, n in sorted(manager_names.items(), key=lambda m: m[1])],
        },
    }


# ---------------- one property ----------------

def profile(villa_id: str) -> dict | None:
    v = store.get_villa(villa_id)
    if not v:
        return None
    full = portfolio.load()
    base = portfolio.for_villa(full, villa_id)  # attention for this villa only, by the same rules as everywhere
    today = base["today"]
    bookings, here = base["bookings"], base["tickets"]
    stay = portfolio.villa_stay(bookings, today, v)
    open_here = [t for t in here if t["status"] != "closed"]
    resolved = sorted((t for t in here if t["status"] == "closed"), key=lambda t: t["resolved_at"] or "", reverse=True)
    items = portfolio.attention(base)
    contacts = store.staff_for_villa(villa_id)
    nxt = stay["next"]
    return {
        "now": base["now"].isoformat(),
        "bookings_updated_at": store.bookings_updated_at(),
        "property": {"id": villa_id, "name": v.get("name", villa_id), "location": v.get("location", ""),
                     "area": v.get("area", ""), "residency": v.get("residency", ""), "group": v.get("group", ""),
                     "manager": store.villa_managers().get(villa_id),
                     "caretaker": {"id": contacts["caretaker"]["id"], "name": contacts["caretaker"]["name"]}
                     if "caretaker" in contacts else None},
        "stay": stay,
        "readiness": portfolio.readiness(open_here),
        "attention": items,
        "timeline": _timeline(bookings, today, v),
        "preparation": _preparation(nxt, open_here, contacts) if nxt else None,
        "tickets": {"open": open_here, "resolved": resolved[:RESOLVED_SHOWN], "resolved_total": len(resolved)},
        "conversations": _conversations(bookings, stay, today, v),
        "facilities": facilities(v),
        "team": _team(villa_id, full, contacts, v),  # an operator's open work at other villas counts too
        "activity": [ops_view._activity(e, base["names"])
                     for e in store.audit_for_bookings([b["booking_id"] for b in bookings], ACTIVITY_LENGTH)],
    }


def _timeline(bookings: list[dict], today, villa: dict) -> list[dict]:
    """Current and upcoming stays, the latest past ones, and any booking that isn't a confirmed stay, by date."""
    summaries = [portfolio.booking_summary(b, today, villa) for b in bookings]
    dated = sorted((s for s in summaries if s["check_in"]), key=lambda s: s["check_in"])
    past = [s for s in dated if s["presence"] == "past" or s["state"] == "completed"]
    keep = past[-RECENT_PAST_STAYS:] + [s for s in dated if s not in past]
    return sorted(keep, key=lambda s: s["check_in"]) + [s for s in summaries if not s["check_in"]]


def _preparation(nxt: dict, open_here: list[dict], contacts: dict) -> dict:
    """What's known about getting the villa ready for its next guest. Only real records: the pre-arrival
    messages, the arrival details the guest gave Gia, the caretaker, and open tickets."""
    steps = store.steps_for_booking(nxt["id"])
    return {
        "booking_id": nxt["id"], "guest": nxt["guest"],
        "journey": [{"step": scheduler.STEP_LABELS[name], **{k: steps[name][k] for k in
                     ("status", "due_at", "sent_at", "delivered_at", "read_at", "note")}}
                    for name in scheduler.STEPS if name in steps],
        "arrival_details": store.guest_details(nxt["id"]),
        "caretaker": contacts.get("caretaker", {}).get("name"),
        "requests": [t for t in open_here if t["booking_id"] == nxt["id"]],
        "blockers": [t["ref"] for t in open_here if t["category"] in portfolio.READINESS_CATEGORIES],
    }


def _conversations(bookings: list[dict], stay: dict, today, villa: dict) -> dict:
    """The guest conversations at this villa, current stay first. The default is the current guest's, else the
    next confirmed arrival's; a past guest's conversation is only ever opened on purpose."""
    counts = store.message_counts([b["booking_id"] for b in bookings])
    current = (stay["current"] or {}).get("id")
    nxt = (stay["next"] or {}).get("id")
    order = {"current": 0, "next": 1, "upcoming": 2, "past": 3, "other": 4}
    out = []
    for b in bookings:
        s = portfolio.booking_summary(b, today, villa)
        relation = ("current" if s["id"] == current else "next" if s["id"] == nxt
                    else "upcoming" if s["presence"] == "upcoming"
                    else "past" if s["presence"] == "past" or s["state"] == "completed" else "other")
        c = counts.get(s["id"], {})
        out.append({**s, "relation": relation, "messages": c.get("count", 0), "last_message_at": c.get("last_at")})
    past = sorted((c for c in out if c["relation"] == "past"), key=lambda c: c["check_in"] or "", reverse=True)
    rest = sorted((c for c in out if c["relation"] != "past"), key=lambda c: (order[c["relation"]], c["check_in"] or ""))
    ordered = [c for c in rest if order[c["relation"]] < order["past"]] + past + [c for c in rest if c["relation"] == "other"]
    return {"default": current or nxt, "list": ordered}


def facilities(v: dict) -> dict:
    """The villa's capability record, grouped. A field the record doesn't have is None ("Not tracked")."""
    pool, pets = v.get("pool") or {}, v.get("pets") or {}
    services = v.get("services") or {}
    name = lambda key: key.replace("_", " ").capitalize()  # noqa: E731
    pool_text = None
    if pool:
        pool_text = ((pool.get("type") or "Pool") + (", heated" if pool.get("heated") else "")
                     + (f" · {pool['hours']}" if pool.get("hours") else "")
                     + ("" if pool.get("lifeguard") else " · no lifeguard")) if pool.get("available") else "No pool"
    return {
        "capacity": [{"label": "Bedrooms", "value": v.get("bedrooms")},
                     {"label": "Bathrooms", "value": v.get("bathrooms")},
                     {"label": "Maximum guests", "value": v.get("max_guests")}],
        "stay": [{"label": "Check-in", "value": v.get("check_in_time")},
                 {"label": "Check-out", "value": v.get("check_out_time")},
                 {"label": "Early check-in", "value": v.get("early_check_in")}],
        "amenities": [{"label": "Pool", "value": pool_text},
                      {"label": "Wi-Fi", "value": v.get("wifi")},
                      {"label": "Power backup", "value": v.get("power_backup")},
                      {"label": "Parking", "value": v.get("parking")},
                      {"label": "Pets", "value": (pets.get("rules") or "Allowed") if pets.get("allowed")
                       else ("Not allowed" if pets else None)}],
        "services": [{"label": name(k), "price": s.get("price"), "notice": s.get("notice"),
                      "extra": ", ".join(s.get("cuisines") or []) or None}
                     for k, s in services.items() if s.get("available")],
        "unavailable": [{"label": name(k), "alternative": s.get("alternative")}
                        for k, s in services.items() if not s.get("available")],
        "rules": v.get("house_rules") or [],
        "directions": v.get("directions"), "maps_url": v.get("maps_url"), "nearby": v.get("nearby") or [],
        "host": v.get("host"),
    }


def _team(villa_id: str, base: dict, contacts: dict, villa: dict) -> dict:
    """The villa's operators, one entry per person (an operator on several villas is the same record), split by
    where they are now. "Assigned" means they hold an open ticket here; otherwise they're available."""
    people: dict[int, dict] = {}
    for r in store.operators_for_villa(villa_id):
        p = people.setdefault(r["id"], {"id": r["id"], "name": r["name"], "phone": r["phone"],
                                        "presence": r["presence"] or "onsite", "roles": []})
        p["roles"].append(r["role"])
    open_tickets = [t for t in base["tickets"] if t["status"] != "closed"]
    for p in people.values():
        mine = [t for t in open_tickets if t["operator_id"] == p["id"]]
        here = [t for t in mine if t["villa_id"] == villa_id]
        p.update(open_here=len(here), open_elsewhere=len(mine) - len(here), assigned=bool(here),
                 refs_here=[t["ref"] for t in here], contact_role=next((r for r in ("manager", "caretaker")
                                                                       if contacts.get(r, {}).get("id") == p["id"]), None))
    ordered = sorted(people.values(), key=lambda p: (not p["assigned"], p["name"]))
    return {"onsite": [p for p in ordered if p["presence"] == "onsite"],
            "offsite": [p for p in ordered if p["presence"] != "onsite"],
            "host": villa.get("host")}
