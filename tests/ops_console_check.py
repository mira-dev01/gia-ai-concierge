"""Check of the ops console's live API (/admin/ops/api) against a throwaway database, with WhatsApp faked
and Gia's model replaced by a stub. Nothing is sent to WhatsApp, Groq or by email; your gia.db is not touched.

    python -m tests.ops_console_check
"""
import asyncio
import os
import sys
import tempfile
from datetime import datetime

tmp = tempfile.mkdtemp()
os.environ.update(DATABASE_URL=os.environ.get("TEST_DATABASE_URL", ""), DB_PATH=f"{tmp}/t.db", DRY_RUN="true", ADMIN_PASSWORD="pw", OI_WEBHOOK_SECRET="s3",
                  GROQ_API_KEY=os.environ.get("GROQ_API_KEY") or "dummy", DEMO_BOOKING_ID="",
                  TICKET_EMAIL_TO="hello@hostwithmira.com", RESEND_API_KEY="")
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import store  # noqa: E402

clock = {"t": datetime(2026, 10, 10, 11, 0, tzinfo=store.IST)}
store.now = lambda: clock["t"]  # frozen before main is imported, since importing it seeds the bookings

from app import agent, main, scheduler, tickets, whatsapp  # noqa: E402
sent = []
outside_window = {"on": False}


async def fake_post(payload):
    sent.append(payload)
    if outside_window["on"] and payload.get("type") == "text":
        return {"error": {"code": whatsapp.OUTSIDE_SERVICE_WINDOW, "message": "Re-engagement message"}}
    return {"messages": [{"id": f"wamid.{len(sent)}"}]}

whatsapp._post = fake_post

gia_calls = []


async def fake_reply(phone, text):
    gia_calls.append(text)
    return f"Gia: {text}"

agent.reply = fake_reply

failures = 0


def check(cond, label):
    global failures
    print(("PASS " if cond else "FAIL ") + label)
    failures += not cond


def texts_to(phone):
    return [p["text"]["body"] for p in sent if p.get("type") == "text" and p.get("to") == phone]


async def main_async():
    store.init()
    c = TestClient(main.app)
    auth = ("ops", "pw")

    check(c.get("/api/state").status_code == 401 and c.get("/").status_code == 401, "console needs the admin password")
    r = c.get("/", auth=auth)
    check(r.status_code == 200 and "ops/console.js" in r.text, "console served at /")
    check(c.get("/ops/console.js", auth=auth).status_code == 200, "console assets served")
    r = c.get("/admin/ops", auth=auth, follow_redirects=False)
    check(r.status_code == 308 and r.headers["location"] == "/", "old address redirects to /")
    check(c.get("/health").json()["ok"], "health check at /health, no password")

    priya = store.get_booking("LH-24009")
    phone = priya["guest_phone"]
    t = tickets.raise_ticket(priya, phone, "maintenance", "high", "AC not cooling", "Master bedroom AC is warm.")
    tickets.raise_ticket(priya, phone, "pre_arrival", "high", "Internal flag", "No reply.", source="uc-ops-01")
    ho = tickets.raise_handoff(priya, phone, "Guest asked for a person", "normal")
    store.add_preference(priya, "food", "Loves seafood", "we love seafood")
    store.log_message(phone, "LH-24009", "in", "Hi Gia")

    s = c.get("/api/state", auth=auth).json()
    b = next(x for x in s["bookings"] if x["id"] == "LH-24009")
    # LH-24009's sample status is "Pre-Arrival", which isn't an OI status: never counted as a confirmed stay
    check(b["villa"] == "Casa Alba" and b["stage"] == "Unconfirmed" and "not recognised" in b["status_label"],
          f"booking stage and villa ({b['stage']}, {b['villa']}, {b['status_label']})")
    check("messages" not in b and "activity" not in b, "the polled snapshot carries no chat history")
    convo = c.get("/api/bookings/LH-24009/conversation", auth=auth).json()
    check(convo["messages"][-1]["body"] == "Hi Gia" and convo["preferences"][0]["preference"] == "Loves seafood",
          "conversation endpoint carries the transcript and preferences")
    st = next(x for x in s["tickets"] if x["ref"] == t["ref"])
    hist = c.get(f"/api/tickets/{t['id']}", auth=auth).json()["history"]
    check(st["notifies_guest"] and not st["overdue"] and hist[0]["title"] == f"{t['ref']} created",
          "ticket has guest flag, SLA state and history")
    check(any(h["id"] == ho and h["status"] == "waiting" for h in s["handoffs"]), "handoff listed as waiting")
    check(s["ticket_statuses"] == ["open", *main.STATUS_MESSAGES], "allowed statuses come from the backend")
    check(any(e["title"] == f"{t['ref']} raised for Abhaya Trivedi" and e["toast"] for e in s["events"]),
          "events: ticket raised, as a toast")
    check(any(e["kind"] == "handoff" and e["toast"] for e in s["events"]), "events: guest asking for a person")
    check(any(sv["label"] == "Private chef" for sv in
              c.get("/api/properties/ALB-AWS-02", auth=auth).json()["facilities"]["services"]),
          "villa capabilities listed")

    # status change on a guest's request: guest messaged, audit written
    r = c.post(f"/api/tickets/{t['id']}/status", json={"status": "acknowledged"}, auth=auth)
    check(r.status_code == 200 and r.json()["guest_messaged"], "status change accepted")
    check(any("picked up your request" in m for m in texts_to(phone)), "guest told on WhatsApp")
    check(c.post(f"/api/tickets/{t['id']}/status", json={"status": "bogus"}, auth=auth).status_code == 400,
          "unknown status refused")
    internal = next(x for x in s["tickets"] if x["source"] == "uc-ops-01")
    n = len(sent)
    r = c.post(f"/api/tickets/{internal['id']}/status", json={"status": "closed"}, auth=auth)
    check(not r.json()["guest_messaged"] and len(sent) == n, "internal ticket: guest not messaged")

    # SLA: an hour past due shows as overdue
    clock["t"] = datetime(2026, 10, 10, 12, 30, tzinfo=store.IST)
    st = next(x for x in c.get("/api/state", auth=auth).json()["tickets"] if x["ref"] == t["ref"])
    check(st["overdue"], "ticket past its SLA is overdue")

    # reply without takeover is refused
    r = c.post("/api/bookings/LH-24009/reply", json={"text": "Hello"}, auth=auth)
    check(r.status_code == 409, "reply needs a takeover first")

    # takeover: Gia stays quiet, guest messages are kept for her
    r = c.post("/api/bookings/LH-24009/takeover", json={"on": True}, auth=auth)
    check(r.status_code == 200 and store.takeover_active(phone), "takeover on")
    gia_calls.clear()
    n = len(sent)
    answer = await main._converse(phone, "Is anyone there?", send=True)
    check(answer == "" and not gia_calls and len(sent) == n, "Gia doesn't reply during a takeover")
    check(store.transcript_for(phone)[-1]["body"] == "Is anyone there?", "guest message still logged")

    r = c.post("/api/bookings/LH-24009/reply", json={"text": "Hi Priya, Neha from Lohono here."}, auth=auth)
    check(r.status_code == 200 and texts_to(phone)[-1] == "Hi Priya, Neha from Lohono here.", "ops reply sent on WhatsApp")
    check(store.transcript_for(phone)[-1]["direction"] == "ops", "ops reply logged as ops")
    check(c.post("/api/bookings/LH-24009/reply", json={"text": "  "}, auth=auth).status_code == 400,
          "empty reply refused")
    outside_window["on"] = True
    r = c.post("/api/bookings/LH-24009/reply", json={"text": "Still there?"}, auth=auth)
    check(r.status_code == 502 and "24 hours" in r.json()["detail"], "outside the 24-hour window explained")
    check(store.transcript_for(phone)[-1]["body"] != "Still there?", "failed reply not logged as sent")
    outside_window["on"] = False

    # scheduled UC-OPS-01 steps wait during a takeover
    aarav = store.get_booking("LH-24017")
    c.post("/api/bookings/LH-24017/takeover", json={"on": True}, auth=auth)
    await scheduler.run_once()
    check(store.steps_for_booking("LH-24017")["welcome"]["status"] == "scheduled", "welcome held during takeover")
    c.post("/api/bookings/LH-24017/takeover", json={"on": False}, auth=auth)
    await scheduler.run_once()
    welcome = store.steps_for_booking("LH-24017")["welcome"]
    check(welcome["status"] == "sent", f"welcome goes once handed back ({welcome['status']}: {welcome['note']})")
    check(not store.takeover_active(aarav["guest_phone"]), "takeover off")

    # hand back: Gia replies again and knows what happened meanwhile
    c.post("/api/bookings/LH-24009/takeover", json={"on": False}, auth=auth)
    notes = " | ".join(store.pop_notes(phone))  # what Gia is told with the guest's next message
    check("Is anyone there?" in notes and "Neha from Lohono" in notes and "handed the conversation back" in notes,
          "Gia is told what happened during the takeover")
    gia_calls.clear()
    await main._converse(phone, "Thanks!", send=True)
    check(gia_calls == ["Thanks!"] and texts_to(phone)[-1] == "Gia: Thanks!", "Gia replies again after hand-back")

    # handoff resolution
    r = c.post(f"/api/handoffs/{ho}/resolve", auth=auth)
    check(r.status_code == 200 and store.all_handoffs()[0]["status"] == "resolved", "handoff resolved")
    check(c.post("/api/handoffs/999/resolve", auth=auth).status_code == 404, "unknown handoff 404")
    check(c.post("/api/bookings/NOPE/takeover", json={"on": True}, auth=auth).status_code == 404,
          "unknown booking 404")

    actions = [a["action"] for a in store.audit_log()]
    check(all(a in actions for a in ("ops_takeover", "ops_reply", "ops_handback", "handoff_resolved",
                                     "ticket_status:acknowledged")), "every ops action is in the audit log")
    kinds = {e["kind"] for e in c.get("/api/state", auth=auth).json()["events"]}
    check(not kinds & {"takeover", "handback", "ops_reply"}, f"events leave out takeovers and ops replies ({kinds})")

    # the old console's form route still works through the shared helper
    r = c.post(f"/admin/tickets/{t['id']}/status", data={"status": "closed"}, auth=auth, follow_redirects=False)
    check(r.status_code == 303 and store.get_ticket(t["id"])["status"] == "closed", "old console status form")
    r = c.get("/admin/bookings/LH-24009", auth=auth)
    check("ops team</span> Hi Priya" in r.text, "booking page labels ops replies")

    await operator_checks(c, auth)

    print(f"\n{failures} failure(s)" if failures else "\nAll checks passed")
    return failures


def incoming(phone, text):
    return {"from": phone, "id": f"wamid.in.{len(sent)}.{text}", "type": "text", "text": {"body": text}}


def operator_chat(c, auth, staff_id):
    return c.get(f"/api/operators/{staff_id}", auth=auth).json()


async def operator_checks(c, auth):
    """Field operators: routing, notifications, WhatsApp commands, field-app done, resolve time, reassignment."""
    clock["t"] = datetime(2026, 10, 10, 15, 0, tzinfo=store.IST)
    priya = store.get_booking("LH-24009")
    add = lambda **kw: c.post("/api/operators", json={"presence": "onsite", **kw}, auth=auth)  # noqa: E731
    r = add(name="Ravi Plumber", phone="+91 99990 00011", role="maintenance", villa_ids=["ALB-AWS-02"])
    check(r.status_code == 200, "operator added")
    ravi = r.json()["id"]
    sunil = add(name="Sunil Caretaker", phone="919999000012", role="caretaker", villa_ids=["ALB-AWS-02"],
                presence="offsite").json()["id"]
    meera = add(name="Meera Manager", phone="919999000013", role="manager", villa_ids=["GOA-ASG-01"]).json()["id"]
    check(add(name="Dup", phone="919999000011", role="caretaker", villa_ids=["ALB-AWS-02"]).status_code == 409,
          "duplicate number refused")
    check(add(name="X", phone="12", role="caretaker", villa_ids=["ALB-AWS-02"]).status_code == 400, "bad number refused")
    check(add(name="X", phone="919999000099", role="chef", villa_ids=["ALB-AWS-02"]).status_code == 400, "bad role refused")
    check(store.staff_for_villa("ALB-AWS-02").keys() == {"caretaker"}, "maintenance operator isn't a UC-OPS-01 contact")

    # a guest's maintenance request goes to the villa's maintenance operator, who gets it on WhatsApp
    n = len(sent)
    leak = tickets.raise_ticket(priya, priya["guest_phone"], "maintenance", "medium", "Basin leak", "Bedroom 2 basin.")
    await asyncio.sleep(0.05)  # the notification is sent in the background
    leak = store.get_ticket(leak["id"])
    check(leak["operator_id"] == ravi and leak["assignee"] == "Ravi Plumber · Maintenance", "routed by category")
    to_ravi = [p for p in sent[n:] if p.get("to") == "919999000011"]
    check(to_ravi and to_ravi[0]["type"] == "template", "operator told by template (no 24-hour window yet)")
    chat = operator_chat(c, auth, ravi)
    check(chat["messages"][-1]["direction"] == "out" and "Basin leak" in chat["messages"][-1]["body"], "task in operator chat")

    # onsite first: Ravi goes offsite, Sunil onsite, so the next maintenance job goes to Sunil
    c.post(f"/api/operators/{ravi}/presence", json={"presence": "offsite"}, auth=auth)
    c.post(f"/api/operators/{sunil}/presence", json={"presence": "onsite"}, auth=auth)
    check(c.post(f"/api/operators/{sunil}/presence", json={"presence": "away"}, auth=auth).status_code == 400,
          "bad presence refused")
    fan = tickets.raise_ticket(priya, priya["guest_phone"], "maintenance", "low", "Fan squeaks", "Living room fan.")
    check(store.get_ticket(fan["id"])["operator_id"] == sunil, "an onsite operator is preferred")
    towels = tickets.raise_ticket(priya, priya["guest_phone"], "housekeeping", "low", "Fresh towels", "4 towels.")
    check(store.get_ticket(towels["id"])["operator_id"] == sunil, "no housekeeping operator: falls back to caretaker")
    await asyncio.sleep(0.05)

    # the operator writes: shown to ops as an event
    await main._handle_incoming(incoming("919999000012", "On my way to Casa Alba"))
    chat = operator_chat(c, auth, sunil)
    check(chat["messages"][-1]["direction"] == "in" and chat["window_open"], "operator message logged, window open")
    events = c.get("/api/state", auth=auth).json()["events"]
    check(events[0]["kind"] == "operator" and events[0]["toast"], "operator message is an event")

    # DONE with two open tasks asks which one; DONE OI-n closes it, the guest is told, time recorded
    n = len(sent)
    await main._handle_incoming(incoming("919999000012", "DONE"))
    check(texts_to("919999000012")[-1].startswith("Your open tasks:") and store.get_ticket(fan["id"])["status"] != "closed",
          "DONE with several open tasks asks which")
    clock["t"] = datetime(2026, 10, 10, 15, 42, tzinfo=store.IST)
    await main._handle_incoming(incoming("919999000012", f"done {fan['ref']}"))
    closed = store.get_ticket(fan["id"])
    check(closed["status"] == "closed" and closed["resolved_by"] == "Sunil Caretaker (WhatsApp)", "DONE OI-n closes it")
    check("resolved in 42 min" in texts_to("919999000012")[-1], f"operator thanked with the time ({texts_to('919999000012')[-1]})")
    check(any("is done" in m for m in texts_to(priya["guest_phone"])[-2:]), "guest told it's done")
    st = next(x for x in c.get("/api/state", auth=auth).json()["tickets"] if x["id"] == fan["id"])
    check(st["resolve_minutes"] == 42 and st["within_sla"], "snapshot has time to resolve, within SLA")
    ev = c.get("/api/state", auth=auth).json()["events"]
    check(any(e["kind"] == "resolved" and e["title"] == f"{fan['ref']} resolved in 42 min" for e in ev), "resolved event")
    await main._handle_incoming(incoming("919999000012", "done"))  # one task left: closes it without a number
    check(store.get_ticket(towels["id"])["status"] == "closed", "DONE with one open task closes it")
    await main._handle_incoming(incoming("919999000012", "Done with the first part, need a part"))
    check(store.get_staff(sunil)["presence"] == "onsite", "free text isn't a command")
    await main._handle_incoming(incoming("919999000012", "OFFSITE"))
    check(store.get_staff(sunil)["presence"] == "offsite", "OFFSITE sets presence")

    # field app "Mark done"; ops messaging the operator; reassigning
    clock["t"] = datetime(2026, 10, 10, 18, 5, tzinfo=store.IST)  # 5 minutes past the leak's 3-hour SLA
    r = c.post(f"/api/tickets/{leak['id']}/done", auth=auth)
    check(r.status_code == 200 and r.json()["minutes"] == 185, f"field app done ({r.json()})")
    st = next(x for x in c.get("/api/state", auth=auth).json()["tickets"] if x["id"] == leak["id"])
    check(st["resolved_by"] == "Ravi Plumber (field app)" and st["within_sla"] is False, "over-SLA resolve flagged")
    check(c.post(f"/api/tickets/{leak['id']}/done", auth=auth).status_code == 409, "already closed")
    r = c.post(f"/api/operators/{sunil}/message", json={"text": "Thanks Sunil"}, auth=auth)
    check(r.status_code == 200 and operator_chat(c, auth, sunil)["messages"][-1]["direction"] == "ops", "ops message to operator")
    outside_window["on"] = True
    r = c.post(f"/api/operators/{ravi}/message", json={"text": "Hi"}, auth=auth)
    check(r.status_code == 502 and "24 hours" in r.json()["detail"], "operator outside 24 hours explained")
    outside_window["on"] = False
    gym = tickets.raise_ticket(priya, priya["guest_phone"], "service", "low", "Late checkout", "Asked for 1 pm.")
    n = len(sent)
    r = c.post(f"/api/tickets/{gym['id']}/assign", json={"operator_id": meera}, auth=auth)
    check(r.status_code == 200 and store.get_ticket(gym["id"])["operator_id"] == meera, "reassigned")
    check(any(p.get("to") == "919999000013" for p in sent[n:]), "new operator told")
    c.post(f"/api/tickets/{gym['id']}/assign", json={"operator_id": None}, auth=auth)
    check(store.get_ticket(gym["id"])["assignee"] == "Ops control tower", "back to the control tower")
    check(c.post(f"/api/tickets/{gym['id']}/done", auth=auth).status_code == 409, "done needs an operator")

    # a guest's own number stays a guest even if it's also an operator's
    add(name="Guest Too", phone=priya["guest_phone"], role="housekeeping", villa_ids=["LNV-TGR-03"])
    gia_calls.clear()
    await main._handle_incoming(incoming(priya["guest_phone"], "DONE"))
    check(gia_calls == ["DONE"], "guest number still goes to Gia")


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main_async()) else 0)
