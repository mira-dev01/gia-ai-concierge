"""End-to-end check of UC-OPS-01 with a frozen clock, a throwaway database, WhatsApp faked and Resend mocked.

Nothing is sent to WhatsApp or by email, and your gia.db is not touched.

    python -m tests.uc_ops_01_check
"""
import asyncio
import os
import sys
import tempfile
from datetime import datetime

tmp = tempfile.mkdtemp()
os.environ.update(DATABASE_URL=os.environ.get("TEST_DATABASE_URL", ""), DB_PATH=f"{tmp}/t.db", DRY_RUN="true", ADMIN_PASSWORD="pw", OI_WEBHOOK_SECRET="s3",
                  GROQ_API_KEY=os.environ.get("GROQ_API_KEY") or "dummy", DEMO_BOOKING_ID="", TICKET_EMAIL_TO="hello@hostwithmira.com", RESEND_API_KEY="")
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from app import store, scheduler, tickets, whatsapp, agent  # noqa: E402

clock = {"t": datetime(2026, 10, 10, 9, 0, tzinfo=store.IST)}
store.now = lambda: clock["t"]
sent = []
counter = {"n": 0}
fail = {"on": False}


async def fake_post(payload):
    sent.append(payload)
    if fail["on"] and payload.get("type") in ("template", "text"):
        return {"error": {"code": 131026, "message": "Message undeliverable"}}
    counter["n"] += 1
    return {"messages": [{"id": f"wamid.{counter['n']}"}]}

whatsapp._post = fake_post


async def fake_initiate(phone, directive):
    return f"FREE TEXT for: {directive[:30]}"

agent.initiate = fake_initiate


def at(*a):
    clock["t"] = datetime(*a, tzinfo=store.IST)


def steps(bid):
    return {k: (v["status"], v["channel"], v["template"], (v["note"] or "")[:40]) for k, v in store.steps_for_booking(bid).items()}


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        global failures
        failures += 1

failures = 0


async def main():
    store.init()
    staff_id = store.add_staff("Ravi Caretaker", "919999000001", "ravi@example.com")
    store.assign_staff(["GOA-ASG-01"], "caretaker", staff_id)

    at(2026, 10, 10, 9, 0)  # before the send window
    await scheduler.run_once()
    s17 = steps("LH-24017")
    check(s17["welcome"][0] == "scheduled", "welcome waits for the send window")
    check(s17["t7"][0] == "skipped" and s17["t7"][3].startswith("Merged"), "late booking: T-7 merged into welcome")
    check(steps("LH-24021")["t7"][0] == "scheduled", "normal booking: T-7 scheduled")
    check(store.steps_for_booking("LH-24021")["t7"]["due_at"].startswith("2026-10-17T10:00"), "T-7 due 17 Oct 10:00")
    check(not store.steps_for_booking("LH-24009"), "in-stay booking gets no pre-arrival steps")
    check(not sent, "nothing sent outside the window")

    at(2026, 10, 10, 10, 5)
    await scheduler.run_once()
    s17 = steps("LH-24017")
    check(s17["welcome"][:3] == ("sent", "template", "hello_world"), f"merged welcome sent as template {s17['welcome']}")
    check("t7_reminder" in s17, "reminder scheduled after merged welcome")
    check(steps("LH-24021")["welcome"][0] == "sent", "LH-24021 welcome sent")
    tr = [m for m in store.transcript() if m["booking_id"] == "LH-24017"]
    check(tr and "As your stay is coming up soon" in tr[-1]["body"], "transcript has the real template text")
    # run again: no double send
    n = len(sent)
    await scheduler.run_once()
    check(len(sent) == n, "second run sends nothing new")

    # delivery receipts
    wamid = store.steps_for_booking("LH-24017")["welcome"]["wa_message_id"]
    await scheduler.on_delivery_status({"id": wamid, "status": "delivered"})
    await scheduler.on_delivery_status({"id": wamid, "status": "read"})
    check(steps("LH-24017")["welcome"][0] == "read", "delivered then read")

    # reminder after 24h with no reply
    at(2026, 10, 11, 10, 10)
    await scheduler.run_once()
    check(steps("LH-24017")["t7_reminder"][:3] == ("sent", "template", "hello_world"), "reminder sent after 24h silence")

    # T-1 with no reply -> flag ticket, email, staff alert, then T-1 sent
    at(2026, 10, 14, 10, 1)
    await scheduler.run_once()
    s17 = steps("LH-24017")
    check(s17["t1"][0] == "sent", "T-1 sent")
    tks = [t for t in store.all_tickets() if t["booking_id"] == "LH-24017"]
    check(tks and tks[0]["category"] == "pre_arrival" and tks[0]["source"] == "uc-ops-01", "no-reply ticket raised")
    check("Ravi Caretaker" in tks[0]["assignee"] and "control tower" in tks[0]["assignee"], f"assigned: {tks[0]['assignee']}")
    staff_msgs = [p for p in sent if p.get("to") == "919999000001"]
    check(len(staff_msgs) == 1, "caretaker got a WhatsApp alert")
    await tickets.flush_outbox()
    box = store.outbox()
    check(box and box[0]["status"] == "logged" and box[0]["to_addr"] == "hello@hostwithmira.com", f"ticket email queued+logged {box[0]['status'] if box else None}")
    t1_text = [m for m in store.transcript() if m["booking_id"] == "LH-24017"][-1]["body"]
    check("Ravi Caretaker, 919999000001" in t1_text and "maps.google" in t1_text, "T-1 has caretaker contact and map")

    # LH-24021: guest replies after T-7 -> reminder skipped; free text when window open
    at(2026, 10, 17, 10, 0)
    await scheduler.run_once()
    check(steps("LH-24021")["t7"][0] == "sent", "T-7 sent on 17 Oct")
    at(2026, 10, 17, 12, 0)
    store.log_message("919800000003", "LH-24021", "in", "We arrive at 4pm")
    at(2026, 10, 18, 10, 1)
    await scheduler.run_once()
    check(steps("LH-24021")["t7_reminder"][0] == "skipped", "reminder skipped because guest replied")
    at(2026, 10, 22, 18, 0)
    store.log_message("919800000003", "LH-24021", "in", "Can we get a chef?")
    at(2026, 10, 23, 10, 0)
    await scheduler.run_once()
    check(steps("LH-24021")["t1"][:2] == ("sent", "free_text"), "T-1 as free text inside the 24h window")
    check(not [t for t in store.all_tickets() if t["booking_id"] == "LH-24021"], "no no-reply flag when guest replied")

    # OI events
    at(2026, 10, 23, 11, 0)
    b = scheduler.on_booking_event("confirmed", {"booking_id": "LH-30001", "guest_name": "Zara Khan",
                                                 "guest_phone": "+91 98000 00009", "villa_id": "LNV-TGR-03",
                                                 "check_in": "2026-11-20", "check_out": "2026-11-22"})
    check(b["guest_phone"] == "919800000009", "phone normalised")
    s = store.steps_for_booking("LH-30001")
    check(s["t7"]["due_at"].startswith("2026-11-13T10:00") and s["t1"]["due_at"].startswith("2026-11-19T10:00"), "OI confirmed: T-7/T-1 planned")
    scheduler.on_booking_event("modified", {"booking_id": "LH-30001", "check_in": "2026-11-25", "check_out": "2026-11-27"})
    s = store.steps_for_booking("LH-30001")
    check(s["t7"]["due_at"].startswith("2026-11-18") and s["t1"]["due_at"].startswith("2026-11-24"), "OI modified: steps moved")
    scheduler.apply_settings(["LNV-TGR-03"], {"t7_days": 10, "window_start": "11:00"})
    s = store.steps_for_booking("LH-30001")
    check(s["t7"]["due_at"].startswith("2026-11-15T11:00"), f"villa settings move T-7 {s['t7']['due_at']}")
    try:
        scheduler.apply_settings(["LNV-TGR-03"], {"t1_days": 3, "t7_days": 2})
        check(False, "invalid settings rejected")
    except ValueError:
        check(True, "invalid settings rejected")
    scheduler.on_booking_event("cancelled", {"booking_id": "LH-30001"})
    s = steps("LH-30001")
    check(s["t7"][0] == "cancelled" and s["t1"][0] == "cancelled", "OI cancelled: steps cancelled")
    check(s["welcome"][0] == "cancelled", "welcome not yet sent is cancelled too")
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30001"})
    s = steps("LH-30001")
    check(s["welcome"][0] == "scheduled" and s["t1"][0] == "scheduled", "re-confirmed after cancel: steps planned afresh")

    # failure -> retry -> failed -> system ticket
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30002", "guest_name": "Ann Roy", "guest_phone": "919800000010",
                                             "villa_id": "ALB-AWS-02", "check_in": "2026-12-20", "check_out": "2026-12-22"})
    fail["on"] = True
    await scheduler.run_once()
    w = store.steps_for_booking("LH-30002")["welcome"]
    check(w["status"] == "scheduled" and w["attempts"] == 1 and "retrying" in w["note"], "first failure retries")
    at(2026, 10, 23, 11, 20)
    await scheduler.run_once()
    w = store.steps_for_booking("LH-30002")["welcome"]
    check(w["status"] == "failed", "second failure marks failed")
    sys_t = [t for t in store.all_tickets() if t["booking_id"] == "LH-30002"]
    check(sys_t and sys_t[0]["source"] == "system", "delivery failure ticket raised")
    fail["on"] = False

    # disabled villa skips
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30003", "guest_name": "Dev Shah", "guest_phone": "919800000011",
                                             "villa_id": "GOA-ASG-01", "check_in": "2026-12-20", "check_out": "2026-12-22"})
    scheduler.apply_settings(["GOA-ASG-01"], {"enabled": False})
    await scheduler.run_once()
    check(steps("LH-30003")["welcome"][0] == "skipped", "switched-off villa skips steps")

    scheduler.apply_settings(["GOA-ASG-01"], {"enabled": True})

    # booking inside T-1: merged welcome (spec: under 7 days), then T-1
    at(2026, 10, 23, 12, 0)
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30004", "guest_name": "Isha Rao", "guest_phone": "919800000012",
                                             "villa_id": "LNV-TGR-03", "check_in": "2026-10-24", "check_out": "2026-10-26"})
    s = steps("LH-30004")
    check(s["t7"][0] == "skipped" and s["t7"][3].startswith("Merged"), "inside T-1: T-7 merged into the welcome")
    await scheduler.run_once()
    await scheduler.run_once()
    body = [m["body"] for m in store.transcript() if m["booking_id"] == "LH-30004"]
    check(len(body) == 2 and "As your stay is coming up soon" in body[0] and "Check-in is from" in body[1],
          "merged welcome, then T-1")
    await scheduler.run_once()
    check(steps("LH-30004").get("t7_reminder", ("",))[0] in ("scheduled", "skipped"), "no reminder sent after T-1")
    check(not [t for t in store.all_tickets() if t["booking_id"] == "LH-30004"], "no no-reply flag minutes after welcome")

    # booking 2 days out: merged welcome at 18:00, T-1 next morning (16 h later) -> no flag yet
    at(2026, 10, 23, 18, 0)
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30005", "guest_name": "Om Das", "guest_phone": "919800000013",
                                             "villa_id": "ALB-AWS-02", "check_in": "2026-10-25", "check_out": "2026-10-27"})
    await scheduler.run_once()
    check(steps("LH-30005")["welcome"][0] == "sent", "merged welcome sent")
    at(2026, 10, 24, 10, 0)
    await scheduler.run_once()
    check(steps("LH-30005")["t1"][0] == "sent", "T-1 sent")
    check(not [t for t in store.all_tickets() if t["booking_id"] == "LH-30005"], "no flag when guest had < 24 h to reply")

    # confirmed_at in UTC is read in IST (20:00Z on 23 Oct = 01:30 IST on 24 Oct)
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30006", "guest_name": "Lea Paul", "guest_phone": "919800000014",
                                             "villa_id": "GOA-ASG-01", "check_in": "2026-10-31", "check_out": "2026-11-02",
                                             "confirmed_at": "2026-10-23T20:00:00Z"})
    w = store.steps_for_booking("LH-30006")
    check(w["welcome"]["due_at"].startswith("2026-10-24T01:30") and w["t7"]["status"] == "scheduled",
          f"UTC confirmed_at converted ({w['welcome']['due_at']}, T-7 {w['t7']['status']})")

    # Gia's free-text call fails inside the 24 h window -> template instead
    async def broken(phone, directive):
        raise RuntimeError("Groq down")
    agent.initiate = broken
    store.log_message("919800000014", "LH-30006", "in", "hello")
    await scheduler.send_now("LH-30006", "welcome")
    check(steps("LH-30006")["welcome"][:2] == ("sent", "template"), "AI failure falls back to the template")
    agent.initiate = fake_initiate

    # legacy concierge_schedule rows count as sent
    with store._db() as con:  # the app's own connection, so this works on SQLite and Postgres
        con.execute("CREATE TABLE concierge_schedule (booking_id TEXT PRIMARY KEY, welcome_at TEXT, t7_at TEXT, "
                    "t7_reminder_at TEXT, t1_at TEXT, t1_host_flag_at TEXT)")
        con.execute("INSERT INTO concierge_schedule VALUES ('LH-30007', '2026-10-20T10:00:00+05:30', NULL, NULL, NULL, NULL)")
    n = len(sent)
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30007", "guest_name": "Old Guest", "guest_phone": "919800000015",
                                             "villa_id": "GOA-ASG-01", "check_in": "2026-11-20", "check_out": "2026-11-22",
                                             "confirmed_at": "2026-10-20T09:00:00+05:30"})
    await scheduler.run_once()
    s = steps("LH-30007")
    check(s["welcome"][0] == "sent" and "before the UC-OPS-01 upgrade" in s["welcome"][3], "legacy welcome kept as sent")
    check(not [p for p in sent[n:] if p.get("to") == "919800000015"], "legacy welcome not re-sent")

    # sample bookings follow bookings.json edits, and keep OI changes otherwise
    scheduler.on_booking_event("modified", {"booking_id": "LH-24021", "occasion": "Changed by OI"})
    store.init()
    check(store.get_booking("LH-24021")["occasion"] == "Changed by OI", "OI change kept when bookings.json unchanged")
    store._seed_bookings[2] = {**store._seed_bookings[2], "guest_phone": "919811111111"}
    store.init()
    b = store.get_booking("LH-24021")
    check(b["guest_phone"] == "919811111111" and b["confirmed_at"].startswith("2026-10-10"),
          "bookings.json edit applied, confirmed_at kept")

    # Resend
    import httpx
    from app import config, mailer
    calls = []
    def handler(request):
        calls.append(request)
        if b"bad" in request.content:
            return httpx.Response(422, json={"statusCode": 422, "message": "Invalid from"})
        return httpx.Response(200, json={"id": "re_123"})
    real_client = httpx.AsyncClient
    mailer.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    config.DRY_RUN, config.RESEND_API_KEY, config.RESEND_FROM = False, "re_test", "Gia <gia@example.com>"
    out = await mailer.send("hello@hostwithmira.com", ["ravi@example.com"], "Subj", "Body", idempotency_key="k1")
    import json as _json
    req = _json.loads(calls[-1].content)
    check(out == "sent" and calls[-1].url == "https://api.resend.com/emails", "Resend called")
    check(calls[-1].headers["authorization"] == "Bearer re_test" and calls[-1].headers["idempotency-key"] == "k1", "auth + idempotency headers")
    check(req == {"from": "Gia <gia@example.com>", "to": ["hello@hostwithmira.com"], "subject": "Subj", "text": "Body",
                  "cc": ["ravi@example.com"]}, f"payload {req}")
    try:
        await mailer.send("hello@hostwithmira.com", [], "bad", "bad")
        check(False, "Resend error raises")
    except mailer.MailError as e:
        check("422" in str(e), "Resend error raises")
    store.enqueue_email("ticket", "OI-TEST", "hello@hostwithmira.com", [], "via outbox", "x")
    await tickets.flush_outbox()
    row = [r for r in store.outbox() if r["ref"] == "OI-TEST"][0]
    check(row["status"] == "sent", "outbox sends through Resend")
    check(calls[-1].headers["idempotency-key"].startswith(f"gia-outbox-{row['id']}-2026"), "outbox idempotency key has created_at")
    config.DRY_RUN = True
    mailer.httpx.AsyncClient = real_client
    # live-test recipe: reminder delay 1 h, no reply, then OI moves check-in to tomorrow -> flag + T-1.
    # Ridge House has no caretaker/manager here, so the flag falls back to the villa host on record.
    scheduler.apply_settings(["LNV-TGR-03"], {"reminder_hours": 1, "t7_days": 7, "window_start": "10:00"})
    at(2026, 10, 24, 12, 0)
    scheduler.on_booking_event("confirmed", {"booking_id": "LH-30008", "guest_name": "Tara Sen", "guest_phone": "919800000016",
                                             "villa_id": "LNV-TGR-03", "check_in": "2026-10-31", "check_out": "2026-11-02"})
    await scheduler.run_once()
    await scheduler.run_once()
    check(steps("LH-30008")["t7"][0] == "sent", "T-7 sent right after welcome when check-in is 7 days out")
    at(2026, 10, 24, 13, 5)
    await scheduler.run_once()
    check(steps("LH-30008")["t7_reminder"][0] == "sent", "reminder after the villa's 1 h delay")
    scheduler.on_booking_event("modified", {"booking_id": "LH-30008", "check_in": "2026-10-25", "check_out": "2026-10-27"})
    await scheduler.run_once()
    flag = [t for t in store.all_tickets() if t["booking_id"] == "LH-30008"]
    check(flag and flag[0]["category"] == "pre_arrival" and "(villa host)" in flag[0]["assignee"],
          f"no reply by T-1 flagged to the villa host + control tower ({flag[0]['assignee'] if flag else None})")
    check(steps("LH-30008")["t1"][0] == "sent", "T-1 sent after the flag")
    rec = store.booking_record("LH-30008")
    check(any(a["action"] == "staff_alert_skipped" for a in rec["audit"]), "placeholder host phone: WhatsApp alert skipped and audited")
    check(len([m for m in rec["messages"] if m["direction"] == "out"]) == 4, "all 4 messages on the booking record")
    print("failures:", failures)
    if failures:
        sys.exit(1)

asyncio.run(main())

# Console pages
from fastapi.testclient import TestClient  # noqa: E402
from app import main as m  # noqa: E402
m.app.router.on_startup.clear()
c = TestClient(m.app)
auth = ("x", "pw")
r = c.get("/admin", auth=auth); print("GET /admin", r.status_code, "UC-OPS-01 pre-arrival journey" in r.text)
r = c.get("/admin/villas?group=Mumbai+weekend", auth=auth); print("GET villas filter", r.status_code, r.text.count("name=villa_ids value="))
r = c.post("/admin/villas/assign", auth=auth, data={"villa_ids": ["ALB-AWS-02", "LNV-TGR-03"], "role": "manager", "staff_id": "1", "back": "group=Mumbai+weekend"}, follow_redirects=False)
print("assign", r.status_code, r.headers["location"])
print("manager now", store.staff_for_villa("LNV-TGR-03").get("manager", {}).get("name"))
r = c.post("/admin/villas/uc-ops-01", auth=auth, data={"villa_ids": ["ALB-AWS-02"], "reminder_hours": "12", "flag_no_reply": "off", "enabled": "", "back": ""}, follow_redirects=False)
print("settings", r.status_code, r.headers["location"], store.villa_settings("ALB-AWS-02", "UC-OPS-01"))
r = c.post("/admin/villas/uc-ops-01", auth=auth, data={"villa_ids": ["ALB-AWS-02"], "t7_days": "99"}, follow_redirects=False)
print("bad settings", r.headers["location"])
r = c.post("/admin/oi-event", auth=auth, data={"event": "modified", "booking_id": "NOPE"}, follow_redirects=False)
print("bad oi event", r.headers["location"])
r = c.post("/oi/events/booking", json={"event": "confirmed", "booking": {"booking_id": "LH-1"}}, headers={"X-OI-Secret": "s3"})
print("OI endpoint missing fields", r.status_code, r.json())
r = c.post("/oi/events/booking", json={"event": "confirmed", "booking": {}}, headers={"X-OI-Secret": "bad"})
print("OI endpoint bad secret", r.status_code)
r = c.get("/admin/villas?msg=hi", auth=auth); print("villas msg", "class=msg>hi<" in r.text)
r = c.get("/admin/bookings/LH-30008", auth=auth)
print("booking page", r.status_code, "Messages on this booking" in r.text, "No reply from Tara" in r.text)
r = c.get("/admin", auth=auth); print("coverage line", "<b>Welcome</b>:" in r.text)
r = c.get("/admin/bookings/NOPE", auth=auth); print("unknown booking", r.status_code)
