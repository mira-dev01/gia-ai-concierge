"""UC-OPS-09 Log guest preferences: what a guest likes, dislikes and wants arranged, kept on their guest profile so
their next stay, at any villa in the portfolio, starts with it and they never have to say it twice.

Stand-in for OI's guest profile: log() and remove() are the two functions to point at OI when its profile API is
ready. Every preference links back to the guest message it came from: the transcript row (and so the booking's
conversation), how it was captured (WhatsApp, the console's simulator or the terminal) and when.
"""

from . import store

KINDS = ("like", "dislike", "arrangement")
KIND_LABELS = {"like": "Likes", "dislike": "Dislikes", "arrangement": "Arrangements"}
CATEGORIES = ("food", "room_setup", "activities", "occasions", "routine", "other")
TEMPLATE_SUMMARY_CHARS = 180  # what fits in a WhatsApp template parameter alongside the rest of the message
AGENT_PROFILE_LIMIT = 60      # the most recent preferences Gia gets with every turn


def log(booking: dict, phone: str, kind: str, category: str, preference: str, source_quote: str,
        source: dict | None) -> dict:
    """Put a preference on the guest's profile, tagged with the message it came from. source is the turn being
    handled: {"message_id": the guest's message (None when Gia opened the conversation), "channel": ...}."""
    preference = " ".join((preference or "").split())
    if kind not in KINDS or category not in CATEGORIES or not preference:
        return {"logged": False, "error": f"kind must be one of {KINDS}, category one of {CATEGORIES}, "
                                          "and the preference can't be empty"}
    msg = _source_message(phone, source_quote, source)
    if not msg:
        return {"logged": False, "error": "Not saved: preferences must come from something the guest wrote, and "
                                          "no guest message contains that quote."}
    store.upsert_guest_profile(booking)
    pref, outcome = store.save_preference(store.guest_id_for(booking), _booking_of(msg, booking), kind, category,
                                          preference, " ".join((source_quote or "").split()), _channel(source),
                                          msg["id"])
    if outcome == "exists":
        return {"logged": False, "preference_id": pref["id"], "note": "Already on the guest's profile."}
    store.audit(pref["booking_id"], "preference_saved", "tier0",
                {"preference_id": pref["id"], "kind": kind, "category": category, "preference": preference,
                 "source_quote": pref["source_quote"], "message_id": msg["id"], "source": pref["source"],
                 **({"renewed": True} if outcome == "renewed" else {})})
    return {"logged": True, "preference_id": pref["id"]}


def remove(booking: dict, phone: str, preference_id: int, source_quote: str, source: dict | None) -> dict:
    """Take a preference off the profile because the guest said it no longer holds. It's kept, marked removed,
    with the message that removed it."""
    pref = store.get_preference(preference_id)
    if not pref or pref["guest_id"] != store.guest_id_for(booking) or pref["retired_at"]:
        return {"removed": False, "error": "No such preference on this guest's profile."}
    msg = _source_message(phone, source_quote, source)
    if not msg:
        return {"removed": False, "error": "Not removed: only the guest can change their profile, and no guest "
                                           "message contains that quote."}
    store.retire_preference(preference_id, msg["id"])
    store.audit(_booking_of(msg, booking)["booking_id"], "preference_removed", "tier0",
                {"preference_id": preference_id, "preference": pref["preference"], "message_id": msg["id"],
                 "source_quote": " ".join((source_quote or "").split())})
    return {"removed": True}


def profile(booking: dict) -> dict:
    """The guest's profile as the console shows it: every preference with where and when the guest said it."""
    guest_id = store.guest_id_for(booking)
    p = store.get_guest_profile(guest_id) or {}
    stays = [b for b in store.all_bookings() if store.guest_id_for(b) == guest_id]
    villa_of = {b["booking_id"]: b["villa_id"] for b in stays}
    return {
        "guest_id": guest_id, "since": p.get("created_at"),
        "stays": sum(b["status"] != "cancelled" for b in stays),
        "preferences": [{
            **{k: x[k] for k in ("id", "kind", "category", "preference", "source_quote", "at", "source",
                                 "booking_id", "message_id")},
            "villa": (store.get_villa(villa_of.get(x["booking_id"], "")) or {}).get("name"),
        } for x in store.preferences_for_guest(guest_id)],
    }


def on_profile(booking: dict) -> list[dict]:
    return store.preferences_for_guest(store.guest_id_for(booking))


def remembered(booking: dict) -> list[dict]:
    """Preferences the guest gave on other bookings: what Gia already knows before this stay's conversation."""
    return [x for x in store.preferences_for_guest(store.guest_id_for(booking))
            if x["booking_id"] != booking["booking_id"]]


def for_agent(booking: dict) -> list[dict]:
    """The profile as Gia sees it with every turn (the id is what remove_preference takes), newest last."""
    return [{"id": x["id"], "kind": x["kind"], "category": x["category"], "preference": x["preference"],
             "noted": (x["at"] or "")[:10], "on_this_booking": x["booking_id"] == booking["booking_id"]}
            for x in on_profile(booking)[-AGENT_PROFILE_LIMIT:]]


def summary(prefs: list[dict], limit: int = TEMPLATE_SUMMARY_CHARS) -> str:
    """One line for a WhatsApp template or an email: whole preferences only, then how many more."""
    out: list[str] = []
    for i, x in enumerate(prefs):
        left = len(prefs) - i - 1  # after this one
        if out and len("; ".join(out + [x["preference"]]) + (f"; and {left} more" if left else "")) > limit:
            return "; ".join(out) + f"; and {left + 1} more"
        out.append(x["preference"])
    return "; ".join(out)[:limit]


def _source_message(phone: str, quote: str, source: dict | None) -> dict | None:
    """The guest message a preference came from: the latest one containing the quote (normally the message being
    answered); failing that, the message being answered (Gia translated or paraphrased the quote). Never a message
    from Gia or ops, and never another guest's."""
    match = store.inbound_message_matching(phone, quote)
    if match:
        return match
    current = store.get_message(source["message_id"]) if (source or {}).get("message_id") else None
    return current if current and current["phone"] == phone and current["direction"] == "in" else None


def _booking_of(msg: dict, booking: dict) -> dict:
    """The booking whose conversation the message belongs to (an earlier stay's, if the quote came from there)."""
    if msg.get("booking_id") and msg["booking_id"] != booking["booking_id"]:
        return store.get_booking(msg["booking_id"]) or booking
    return booking


def _channel(source: dict | None) -> str:
    return (source or {}).get("channel") or "whatsapp"
