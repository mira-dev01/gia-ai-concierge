"""End-to-end check of UC-OPS-09 (guest preferences on the guest profile) with a frozen clock, a throwaway database
and WhatsApp faked. Gia's real tool loop runs, with the model's replies scripted, so what's checked is what the
server does with them: where each preference is saved, what it links back to, and how the next stay uses it.

Nothing is sent to WhatsApp, Groq or by email, and your gia.db is not touched.

    python -m tests.uc_ops_09_check
"""
import asyncio
import json
import os
import sys
import tempfile
from datetime import datetime
from types import SimpleNamespace

tmp = tempfile.mkdtemp()
os.environ.update(DATABASE_URL=os.environ.get("TEST_DATABASE_URL", ""), DB_PATH=f"{tmp}/t.db", DRY_RUN="true",
                  WA_TEMPLATES_LIVE="false", ADMIN_PASSWORD="pw", OI_WEBHOOK_SECRET="s3",
                  GROQ_API_KEY=os.environ.get("GROQ_API_KEY") or "dummy", DEMO_BOOKING_ID="",
                  TICKET_EMAIL_TO="hello@hostwithmira.com", RESEND_API_KEY="")
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import store  # noqa: E402

clock = {"t": datetime(2026, 10, 10, 11, 0, tzinfo=store.IST)}
store.now = lambda: clock["t"]  # frozen before main is imported, since importing it seeds the bookings

from app import agent, config, main, preferences, scheduler, tickets, wa_templates, whatsapp  # noqa: E402

sent = []
approved = {"returning": False}  # whether Meta has approved the returning-guest templates (when live)


async def fake_post(payload):
    sent.append(payload)
    name = (payload.get("template") or {}).get("name", "")
    if config.WA_TEMPLATES_LIVE and name.endswith("_returning") and not approved["returning"]:
        return {"error": {"code": 132001, "message": "Template name does not exist in the translation"}}
    return {"messages": [{"id": f"wamid.{len(sent)}"}]}

whatsapp._post = fake_post


# ---- the model, scripted: each turn is some tool calls, then a reply ----

queue, model_calls = [], []


class _Call:
    def __init__(self, n, name, args):
        self.id, self.function = f"call_{n}", SimpleNamespace(name=name, arguments=json.dumps(args, ensure_ascii=False))

    def model_dump(self, mode=None):
        return {"id": self.id, "type": "function",
                "function": {"name": self.function.name, "arguments": self.function.arguments}}


def _response(content=None, calls=None):
    msg = SimpleNamespace(content=content, tool_calls=calls or None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason="tool_calls" if calls else "stop")])


async def fake_create(**kw):
    model_calls.append(kw["messages"])
    return queue.pop(0)

agent.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create)))


def script(tools=(), reply="Noted, thank you!"):
    if tools:
        queue.append(_response(calls=[_Call(len(model_calls) + i, name, args) for i, (name, args) in enumerate(tools)]))
    queue.append(_response(content=reply))


def tool_results(phone):
    """What the tools returned to Gia in the latest turn."""
    history = store.load_history(phone)
    last_user = max(i for i, m in enumerate(history) if m["role"] == "user")
    return [json.loads(m["content"]) for m in history[last_user:] if m["role"] == "tool"]


async def say(phone, text, tools=(), send=True):
    script(tools)
    await main._converse(phone, text, send=send)
    return tool_results(phone)


def pref(kind, category, preference, quote):
    return ("log_preference", {"kind": kind, "category": category, "preference": preference, "source_quote": quote})


failures = 0


def check(cond, label):
    global failures
    print(("PASS " if cond else "FAIL ") + label)
    failures += not cond


def inbound(phone, text):
    return next(m for m in reversed(store.transcript_for(phone, 200)) if m["direction"] == "in" and m["body"] == text)


def on_profile(phone, preference):
    return next((x for x in store.preferences_for_guest(phone) if x["preference"] == preference), None)


def saved_audits():
    return [a for a in store.audit_log(1000) if a["action"] == "preference_saved"]


async def main_async():
    store.init()
    c = TestClient(main.app)
    auth = ("ops", "pw")
    priya = store.get_booking("LH-24009")  # Casa Alba, Alibaug
    P, A = priya["guest_phone"], store.get_booking("LH-24017")["guest_phone"]

    # ---------------- Step 1: Gia extracts preferences from messages, requests and feedback ----------------
    chef = "Can we get a private chef for dinner tomorrow? We love seafood, 6 of us"
    r = await say(P, chef, [("create_ticket", {"category": "service", "severity": "medium",
                                               "summary": "Private chef, dinner 11 Oct, 6 guests",
                                               "details": "Seafood menu"}),
                            pref("like", "food", "Loves seafood", "We love seafood")])
    seafood = on_profile(P, "Loves seafood")
    check(store.tickets_for_booking("LH-24009") and r[-1]["logged"], "a request: ticket raised and the preference logged")
    check(seafood and (seafood["kind"], seafood["category"]) == ("like", "food"), "saved as a food like")

    await say(P, "The pillows were too soft last night, we prefer firm ones",
              [pref("arrangement", "room_setup", "Firm pillows", "we prefer firm ones")])
    check(on_profile(P, "Firm pillows")["kind"] == "arrangement", "feedback: saved as a room-setup arrangement")
    await say(P, "Please keep dinner mild, the kids don't eat spicy food",
              [pref("dislike", "food", "Spicy food", "the kids don't eat spicy food")])
    spicy = on_profile(P, "Spicy food")
    check(spicy and spicy["kind"] == "dislike", "a dislike is saved as one")
    hindi = "हमें सुबह योग करना बहुत पसंद है"
    await say(P, hindi, [pref("like", "activities", "Morning yoga", "सुबह योग करना बहुत पसंद है")])
    check(on_profile(P, "Morning yoga")["message_id"] == inbound(P, hindi)["id"], "Hindi: the quote finds its message")

    # ---------------- Step 2: on the guest profile, tagged with source and date ----------------
    check(seafood["guest_id"] == P and seafood["booking_id"] == "LH-24009", "on the guest's profile, from this booking")
    check(seafood["message_id"] == inbound(P, chef)["id"] and seafood["source"] == "whatsapp",
          "source: the guest's WhatsApp message it came from")
    check(seafood["at"] == clock["t"].isoformat() and seafood["source_quote"] == "We love seafood",
          "dated, with the guest's own words")
    check(store.get_guest_profile(P)["name"] == "Abhaya Trivedi", "guest profile record created")

    said = "We always sleep with the AC at 24 degrees"
    await say(P, said)  # Gia didn't log it at the time...
    await say(P, "Thanks!", [pref("arrangement", "room_setup", "AC at 24°C", "we always sleep with the AC at 24 degrees")])
    check(on_profile(P, "AC at 24°C")["message_id"] == inbound(P, said)["id"],
          "a quote from an earlier message links to that message, not the latest")
    sunset = "Sunsets by the pool are our favourite thing"
    await say(P, sunset, [pref("like", "activities", "Sunset by the pool", "We adore pool sunsets")])
    check(on_profile(P, "Sunset by the pool")["message_id"] == inbound(P, sunset)["id"],
          "paraphrased quote: linked to the message being answered")

    n = len(saved_audits())
    r = await say(P, "Did I mention we love seafood!", [pref("like", "food", "loves seafood!", "we love seafood")])
    check(not r[0]["logged"] and "Already" in r[0]["note"], "a repeat is recognised as already on the profile")
    check(len([x for x in store.preferences_for_guest(P) if "seafood" in x["preference"].lower()]) == 1
          and on_profile(P, "Loves seafood")["message_id"] == seafood["message_id"] and len(saved_audits()) == n,
          "no duplicate row or event, and it keeps its original source")

    script([pref("like", "activities", "Golf", "we adore golf")])
    await agent.initiate(P, "Say hello.")
    check("error" in tool_results(P)[0] and not on_profile(P, "Golf"),
          "nothing is saved that the guest never wrote (Gia opening the chat)")
    r = await say("919999999999", "We love jazz", [pref("like", "activities", "Jazz", "We love jazz")])
    check("error" in r[0] and not store.preferences_for_guest("919999999999"), "no booking: nothing saved")

    script([pref("arrangement", "routine", "Breakfast at 7 am", "breakfast at 7")])
    c.post("/admin/simulate", data={"phone": P, "text": "We are early risers, breakfast at 7 please"}, auth=auth)
    check(on_profile(P, "Breakfast at 7 am")["source"] == "console", "console simulator tagged as such")

    # The guest changes their mind: removed, kept for the record with the message that removed it.
    changed = "Actually spicy food is fine now, the kids have grown up"
    r = await say(P, changed, [("remove_preference", {"preference_id": spicy["id"], "source_quote": "spicy food is fine now"})])
    gone = store.get_preference(spicy["id"])
    check(r[0]["removed"] and not on_profile(P, "Spicy food") and gone["retired_message_id"] == inbound(P, changed)["id"],
          "removed from the profile, with the message that removed it")
    r = await say(A, "Remove the seafood thing", [("remove_preference", {"preference_id": seafood["id"],
                                                                          "source_quote": "Remove the seafood thing"})])
    check("error" in r[0] and on_profile(P, "Loves seafood"), "another guest can't change this profile")
    again = "Hmm, no, keep it mild after all, the kids don't eat spicy food"
    await say(P, again, [pref("dislike", "food", "Spicy food", "the kids don't eat spicy food")])
    back = on_profile(P, "Spicy food")
    check(back and back["id"] == spicy["id"] and back["message_id"] == inbound(P, again)["id"],
          "said again: back on the profile, linked to the new message")
    check(len(saved_audits()) == 8 and json.loads(saved_audits()[0]["data"]).get("renewed"),
          f"one audit entry per change to the profile ({len(saved_audits())})")

    # Acceptance: every preference on the profile links back to the guest message, in the conversation it came from.
    links = [(x, store.get_message(x["message_id"]) or {}) for x in store.preferences_for_guest(P)]
    check(len(links) == 7 and all(m.get("direction") == "in" and m.get("phone") == P and m.get("booking_id") == x["booking_id"]
                                  for x, m in links), "every preference links to a guest message on its booking")

    # The console shows the profile and its links.
    convo = c.get("/api/bookings/LH-24009/conversation", auth=auth).json()
    ids = {m["id"] for m in convo["messages"]}
    check(convo["profile"]["guest_id"] == P and all(x["message_id"] in ids and x["at"] and x["kind"]
                                                    for x in convo["preferences"]),
          "conversation API: each preference points at a message in the chat")
    events = c.get("/api/state", auth=auth).json()["events"]
    check(any(e["title"] == "Preference noted for Abhaya Trivedi" and "Likes · " in e["text"] for e in events),
          "Live activity shows the new preference")
    page = c.get("/admin/bookings/LH-24009", auth=auth).text
    check(f"id=m{seafood['message_id']}>" in page and f"#m{seafood['message_id']}>" in page,
          "booking page: Source links to the message's anchor")
    check("Preferences captured (guest profiles)" in c.get("/admin", auth=auth).text, "admin dashboard lists them")

    # ---------------- The next stay, at another villa: Gia already knows ----------------
    clock["t"] = datetime(2026, 10, 13, 11, 0, tzinfo=store.IST)  # Priya's 24-hour window has closed
    booking = lambda bid, villa, ci, co: scheduler.on_booking_event("confirmed", {  # noqa: E731
        "booking_id": bid, "guest_name": "Abhaya Trivedi", "guest_phone": P, "villa_id": villa,
        "check_in": ci, "check_out": co})

    def welcome_text(bid):
        return next(m["body"] for m in store.messages_for_booking(bid, 10)[0] if m["direction"] == "out")

    booking("LH-30009", "GOA-ASG-01", "2026-11-20", "2026-11-23")
    await scheduler.run_once()
    text = welcome_text("LH-30009")
    check("welcome back" in text and "Loves seafood" in text and "Firm pillows" in text,
          "returning guest's welcome names what's remembered")
    check(store.steps_for_booking("LH-30009")["welcome"]["template"] == "hello_world", "(templates not live: hello_world sent)")
    check(welcome_text("LH-24021").startswith("Hi Kabir, your stay"), "a first-time guest gets the standard welcome")
    template, values, fallback = scheduler._template_for(store.get_booking("LH-30009"), "t7", False)
    check(template is wa_templates.PRE_ARRIVAL_RETURNING and fallback[0] is wa_templates.PRE_ARRIVAL
          and len(fallback[1]) == len(fallback[0].params), "T-7 for a returning guest, with the standard one as fallback")
    summary = values[-1]
    check(len(summary) <= preferences.TEMPLATE_SUMMARY_CHARS and "\n" not in summary and summary.startswith("Loves seafood"),
          f"template parameter fits ({summary})")

    config.WA_TEMPLATES_LIVE = True  # templates live, the returning one not approved yet
    n = len(sent)
    booking("LH-30010", "LNV-TGR-03", "2026-12-20", "2026-12-22")
    await scheduler.run_once()
    names = [p["template"]["name"] for p in sent[n:] if p.get("to") == P]
    check(names == ["gia_welcome_returning", "gia_welcome"] and not welcome_text("LH-30010").startswith("Hi Abhaya, welcome back"),
          f"not approved yet: the standard welcome goes instead ({names})")
    approved["returning"] = True
    n = len(sent)
    booking("LH-30011", "ALB-AWS-02", "2027-01-10", "2027-01-12")
    await scheduler.run_once()
    out = [p for p in sent[n:] if p.get("to") == P]
    params = [x["text"] for x in out[0]["template"]["components"][0]["parameters"]] if out else []
    check(len(out) == 1 and out[0]["template"]["name"] == "gia_welcome_returning" and params[-1] == summary,
          "approved: the returning welcome goes, with the preferences as its last parameter")
    config.WA_TEMPLATES_LIVE = False

    model_calls.clear()
    await say(P, "Hi Gia, is the pool heated at Villa Serena?")
    system = model_calls[0][0]["content"]
    check('"guest_profile"' in system and "Loves seafood" in system and "Firm pillows" in system,
          "on the new booking, Gia's context has the guest profile")
    convo = c.get("/api/bookings/LH-30009/conversation", auth=auth).json()
    from_before = [x for x in convo["preferences"] if x["booking_id"] == "LH-24009"]
    check(len(from_before) == 7 and from_before[0]["villa"] == "Casa Alba" and convo["profile"]["stays"] == 4,
          "the new booking's console shows the profile, with where each came from")
    check("Guest profile: like: Loves seafood" in tickets._context(store.get_booking("LH-30009"), P),
          "ticket emails carry the profile to the villa team")

    model_calls.clear()  # the guest wrote just now, so the next welcome is Gia's free text
    script(reply="Welcome back, Abhaya!")
    booking("LH-30012", "GOA-ASG-01", "2027-02-01", "2027-02-03")
    await scheduler.run_once()
    check("stayed with Lohono before" in model_calls[0][-1]["content"] and
          store.steps_for_booking("LH-30012")["welcome"]["channel"] == "free_text",
          "inside the 24-hour window, Gia writes the returning welcome herself")

    # ---------------- A first stay: what the guest said since booking shapes T-7, not the welcome ----------------
    kabir = store.get_booking("LH-24021")
    check(scheduler._template_for(kabir, "t7", False)[0] is wa_templates.PRE_ARRIVAL, "no preferences yet: standard T-7")
    await say(kabir["guest_phone"], "We're vegetarian, all of us",
              [pref("like", "food", "Vegetarian meals", "We're vegetarian")])
    template, values, _ = scheduler._template_for(kabir, "t7", False)
    check(template is wa_templates.PRE_ARRIVAL_RETURNING and values[-1] == "Vegetarian meals",
          "first stay: T-7 uses what they've already said instead of asking again")
    check(scheduler._template_for(kabir, "welcome", False)[0] is wa_templates.WELCOME,
          "first stay: the welcome doesn't claim earlier stays")

    # ---------------- Preferences saved before guest profiles are moved onto them ----------------
    jain = store.log_message(A, "LH-24017", "in", "Note: we eat only Jain food")
    answered = store.log_message(A, "LH-24017", "in", "And the kids love board games")
    legacy_row = ("INSERT INTO preferences (booking_id, guest_name, category, preference, source_quote, at) "
                  "VALUES ('LH-24017', 'Aarav Mehta', 'food', ?, ?, ?)")
    with store._db() as db:
        db.execute(legacy_row, ("Jain food", "we eat only Jain food", clock["t"].isoformat()))
        db.execute(legacy_row, ("Board games", "kids enjoy board games", clock["t"].isoformat()))  # paraphrased
        db.execute(legacy_row, ("Jain food", "Jain please", clock["t"].isoformat()))  # logged twice
    store.init()
    legacy = on_profile(A, "Jain food")
    check(legacy and legacy["message_id"] == jain and legacy["kind"] == "like", "legacy preference: on the profile, linked")
    check(on_profile(A, "Board games")["message_id"] == answered,
          "legacy paraphrase: linked to the message being answered when it was saved")
    check(len([x for x in store.preferences_for_guest(A) if x["preference"] == "Jain food"]) == 1,
          "legacy repeat: shown once")
    check(all(x["message_id"] for x in store.preferences_for_guest(A) + store.preferences_for_guest(P)),
          "acceptance holds after the migration: every preference on a profile has its message")

    print(f"\n{failures} failure(s)" if failures else "\nAll checks passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main_async()) else 0)
