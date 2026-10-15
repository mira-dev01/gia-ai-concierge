"""Check of the Properties workspace and the portfolio rules behind it (occupancy, booking status, readiness,
attention), plus ticket escalation, resolution notes and message delivery states. Runs against a throwaway database
with WhatsApp faked; nothing is sent and your gia.db is not touched.

    python -m tests.properties_check
"""
import asyncio
import os
import sys
import tempfile
import time
from datetime import date, datetime

tmp = tempfile.mkdtemp()
os.environ.update(DATABASE_URL=os.environ.get("TEST_DATABASE_URL", ""), DB_PATH=f"{tmp}/t.db", DRY_RUN="true",
                  ADMIN_PASSWORD="pw", OI_WEBHOOK_SECRET="s3", GROQ_API_KEY="dummy", DEMO_BOOKING_ID="",
                  TICKET_EMAIL_TO="hello@hostwithmira.com", RESEND_API_KEY="")
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import store  # noqa: E402

clock = {"t": datetime(2026, 10, 15, 10, 0, tzinfo=store.IST)}
store.now = lambda: clock["t"]  # frozen before main is imported, since importing it seeds the bookings

from app import agent, main, portfolio, tickets, whatsapp  # noqa: E402

sent = []
fail_next = {"on": False}


async def fake_post(payload):
    sent.append(payload)
    if fail_next["on"] and payload.get("type") == "text":
        return {"error": {"code": 131026, "message": "Message undeliverable"}}
    return {"messages": [{"id": f"wamid.{len(sent)}"}]}

whatsapp._post = fake_post


async def fake_reply(phone, text):
    return f"Gia: {text}"

agent.reply = fake_reply

failures = 0


def check(cond, label):
    global failures
    print(("PASS " if cond else "FAIL ") + label)
    failures += not cond


def bk(bid, ci, co, status="confirmed", villa="V1"):
    return {"booking_id": bid, "villa_id": villa, "guest_name": f"Guest {bid}", "guest_phone": "9190000" + bid[-5:],
            "check_in": ci, "check_out": co, "status": status}


def rules():
    """The portfolio rules on their own, with hand-made bookings."""
    today = date(2026, 10, 15)
    stay = lambda *bs: portfolio.villa_stay(list(bs), today)  # noqa: E731

    check(stay()["key"] == "vacant" and stay()["next"] is None, "no bookings: vacant, no next arrival")
    s = stay(bk("B1", "2026-10-12", "2026-10-18"))
    check(s["key"] == "occupied" and s["current"]["id"] == "B1", "mid-stay: occupied, current guest")
    s = stay(bk("B1", "2026-10-15", "2026-10-18"))
    check(s["key"] == "pre_arrival" and s["label"] == "Arriving today" and s["current"] is None,
          "arrival day, not marked in by OI: arriving today, not occupied")
    s = stay(bk("B1", "2026-10-15", "2026-10-18", status="in_stay"))
    check(s["key"] == "occupied", "arrival day, OI says in_stay: occupied")
    s = stay(bk("B1", "2026-10-12", "2026-10-15"))
    check(s["key"] == "checkout" and s["current"]["id"] == "B1", "checkout day: checkout, guest still current")
    s = stay(bk("B1", "2026-10-12", "2026-10-15"), bk("B2", "2026-10-15", "2026-10-17"))
    check(s["key"] == "turnover" and s["next"]["id"] == "B2", "out and in the same day: turnover")
    s = stay(bk("B1", "2026-10-20", "2026-10-22"))
    check(s["key"] == "pre_arrival" and s["label"] == "Pre-arrival" and s["next"]["days_to_arrival"] == 5,
          "arrival in 5 days: pre-arrival")
    s = stay(bk("B1", "2026-11-20", "2026-11-22"))
    check(s["key"] == "vacant" and s["next"]["id"] == "B1", "arrival far off: vacant, next arrival still shown")
    s = stay(bk("B1", "2026-10-16", "2026-10-18", status="tentative"))
    check(s["key"] == "vacant" and s["next"] is None and s["tentative"][0]["id"] == "B1",
          "tentative booking is never the next confirmed arrival")
    s = stay(bk("B1", "2026-10-16", "2026-10-18", status="cancelled"))
    check(s["key"] == "vacant" and s["next"] is None, "cancelled booking ignored")
    s = stay(bk("B1", "2026-10-14", "2026-10-17", status="Pre-Arrival"))
    check(s["key"] == "unknown" and s["unclear"][0]["id"] == "B1", "unrecognised status covering today: unknown")
    s = stay(bk("B1", "2026-10-14", "2026-10-18"), bk("B2", "2026-10-17", "2026-10-20"))
    check(s["key"] == "conflict" and s["conflicts"] == [["B1", "B2"]], "overlapping confirmed bookings: conflict")
    s = stay(bk("B1", "2026-10-10", "2026-10-12"))
    check(s["key"] == "vacant" and s["current"] is None, "past stay doesn't occupy the villa")
    check(portfolio.booking_label(bk("B1", "2026-10-10", "2026-10-12", "Pre-Arrival")) ==
          "Status not recognised: Pre-Arrival", "unrecognised status labelled as such")
    check(portfolio.stage(bk("B1", "2026-10-15", "2026-10-18"), today) == "Pre-arrival" and
          portfolio.stage(bk("B1", "2026-10-12", "2026-10-15"), today) == "In stay",
          "journey stage follows the same arrival and checkout rules")

    t = {"category": "maintenance", "ref": "OI-1"}
    check(portfolio.readiness([t])["key"] == "blocked" and portfolio.readiness([])["key"] == "not_assessed",
          "readiness: blocked by maintenance, otherwise not assessed (never ready)")
    check(portfolio.readiness([{"category": "service", "ref": "OI-2"}])["key"] == "not_assessed",
          "a service request isn't a readiness blocker")


async def api_checks():
    store.init()
    c = TestClient(main.app)
    auth = ("ops", "pw")
    check(c.get("/api/properties").status_code == 401, "properties need the password")

    # Sample data on 15 Oct: Aarav arrives at Villa Serena today; Kabir at Ridge House on 24 Oct (9 days);
    # Casa Alba's booking ended on the 14th and has a status OI doesn't use.
    r = c.get("/api/properties", auth=auth).json()
    rows = {x["id"]: x for x in r["rows"]}
    check(r["total"] == 3 and r["portfolio_total"] == 3, "register lists the portfolio")
    check(rows["GOA-ASG-01"]["stay"]["label"] == "Arriving today", "Villa Serena: arriving today")
    check(rows["LNV-TGR-03"]["stay"]["key"] == "vacant" and rows["LNV-TGR-03"]["stay"]["next"]["id"] == "LH-24021",
          "Ridge House: vacant, next arrival LH-24021")
    check(rows["ALB-AWS-02"]["stay"]["key"] == "vacant" and rows["ALB-AWS-02"]["stay"]["next"] is None,
          "Casa Alba: vacant, no confirmed arrival")
    check(list(rows) == ["GOA-ASG-01", "LNV-TGR-03", "ALB-AWS-02"], "default sort: next arrival first, none last")
    check("phone" not in str(r["rows"]) and "919" not in str(r["rows"]), "no guest phone numbers in the register")

    q = lambda **kw: c.get("/api/properties", params=kw, auth=auth).json()  # noqa: E731
    check([x["id"] for x in q(q="lonavala")["rows"]] == ["LNV-TGR-03"], "search by location")
    check([x["id"] for x in q(q="alb-aws")["rows"]] == ["ALB-AWS-02"], "search by property ID")
    check(q(q="nowhere at all")["total"] == 0, "search with no match")
    check([x["id"] for x in q(stay="pre_arrival")["rows"]] == ["GOA-ASG-01"], "filter: pre-arrival")
    check(q(stay="vacant", location="Lonavala")["total"] == 1, "filters compose (vacant + location)")
    check([x["id"] for x in q(arrivals="today")["rows"]] == ["GOA-ASG-01"], "arrivals today")
    check(q(arrivals="7d")["total"] == 1 and q(arrivals="48h")["total"] == 1, "arrivals within 48 h / 7 days")
    check(q(stay="pre_arrival")["counts"] == {"all": 3, "occupied": 0, "pre_arrival": 1, "turnover": 0, "vacant": 2,
                                              "attention": 0}, "counts per stay filter")
    check(c.get("/api/properties", params={"sort": "bogus"}, auth=auth).status_code == 400, "unknown sort refused")
    check([x["id"] for x in q(sort="name")["rows"]] == ["ALB-AWS-02", "LNV-TGR-03", "GOA-ASG-01"], "sort by name")

    # a maintenance ticket at Casa Alba: readiness blocked, needs attention (unassigned), sorted first by attention
    abhaya = store.get_booking("LH-24009")
    t = tickets.raise_ticket(abhaya, abhaya["guest_phone"], "maintenance", "high", "Pool pump noisy", "Loud pump.")
    r = q(sort="attention")
    check(r["rows"][0]["id"] == "ALB-AWS-02" and r["rows"][0]["readiness"]["key"] == "blocked",
          "maintenance ticket blocks readiness; attention sort puts it first")
    check(r["rows"][0]["attention"]["top"]["ref"] == t["ref"] and r["counts"]["attention"] == 1,
          "property attention summary names the ticket")
    check(q(blockers="true")["total"] == 1, "readiness-blocker filter")
    state = c.get("/api/state", auth=auth).json()
    check([a["ref"] for a in state["attention"]] == [r["rows"][0]["attention"]["top"]["ref"]],
          "Overview's attention list and the register agree")

    # escalation is a flag beside the status; resolving needs no flag and clears it
    check(c.post(f"/api/tickets/{t['id']}/escalate", json={"on": True}, auth=auth).status_code == 400,
          "escalating needs a reason")
    r = c.post(f"/api/tickets/{t['id']}/escalate", json={"on": True, "reason": "Guest leaving early"}, auth=auth)
    check(r.status_code == 200 and r.json()["escalated"], "escalated")
    c.post(f"/api/tickets/{t['id']}/status", json={"status": "in_progress"}, auth=auth)
    st = next(x for x in c.get("/api/state", auth=auth).json()["tickets"] if x["id"] == t["id"])
    check(st["status"] == "in_progress" and st["escalated"], "in progress and escalated at once")
    item = c.get("/api/state", auth=auth).json()["attention"][0]
    check(item["severity"] == "critical" and "Escalated" in item["reasons"], "escalation is critical attention")
    ev = c.get("/api/state", auth=auth).json()["events"]
    check(any(e["title"] == f"{t['ref']} escalated" and e["urgent"] for e in ev), "escalation pops up as urgent")

    clock["t"] = datetime(2026, 10, 15, 12, 0, tzinfo=store.IST)  # past the 60-minute SLA
    st = next(x for x in c.get("/api/state", auth=auth).json()["tickets"] if x["id"] == t["id"])
    check(st["overdue"] and st["escalated"] and st["status"] == "in_progress", "overdue, escalated, in progress")

    r = c.post(f"/api/tickets/{t['id']}/status", json={"status": "closed", "note": "Replaced pump bearing"}, auth=auth)
    detail = c.get(f"/api/tickets/{t['id']}", auth=auth).json()
    check(detail["status"] == "closed" and detail["resolution_note"] == "Replaced pump bearing"
          and not detail["escalated"], "resolved with a note; escalation cleared")
    check(any("Replaced pump bearing" in h["text"] for h in detail["history"]), "resolution note in the history")
    check(c.post(f"/api/tickets/{t['id']}/escalate", json={"on": True, "reason": "x"}, auth=auth).status_code == 400,
          "can't escalate a resolved ticket")
    c.post(f"/api/tickets/{t['id']}/status", json={"status": "in_progress"}, auth=auth)  # reopen
    detail = c.get(f"/api/tickets/{t['id']}", auth=auth).json()
    check(detail["status"] == "in_progress" and detail["resolution_note"] is None and detail["resolved_at"] is None,
          "reopen clears the resolution")
    check(q(blockers="true")["total"] == 1, "reopened ticket blocks readiness again")
    c.post(f"/api/tickets/{t['id']}/status", json={"status": "closed", "note": "Fixed"}, auth=auth)

    # the profile: Villa Serena with Aarav arriving today
    p = c.get("/api/properties/GOA-ASG-01", auth=auth).json()
    check(p["stay"]["label"] == "Arriving today" and p["conversations"]["default"] == "LH-24017",
          "profile: arriving today; default conversation is the arriving guest's")
    check(p["preparation"]["booking_id"] == "LH-24017" and p["readiness"]["key"] == "not_assessed",
          "preparation is for the next arrival; readiness not assessed")
    fac = p["facilities"]
    check(next(x for x in fac["capacity"] if x["label"] == "Bathrooms")["value"] is None
          and next(x for x in fac["capacity"] if x["label"] == "Bedrooms")["value"] == 5,
          "facilities: bathrooms not tracked, bedrooms from the record")
    check(any(u["label"] == "Bonfire" and u["alternative"] for u in fac["unavailable"]),
          "unavailable services carry their alternative")
    check(c.get("/api/properties/NOPE", auth=auth).status_code == 404, "unknown property 404")

    # Casa Alba: the only booking is past, so no conversation is opened by default
    p = c.get("/api/properties/ALB-AWS-02", auth=auth).json()
    check(p["conversations"]["default"] is None and p["conversations"]["list"][0]["relation"] in ("past", "other"),
          "past guest's conversation is listed, never the default")

    # team: one record per operator, split by presence; assigned means an open ticket here
    op = c.post("/api/operators", json={"name": "Ravi", "phone": "919999000011", "role": "maintenance",
                                       "villa_ids": ["GOA-ASG-01", "ALB-AWS-02"], "presence": "offsite"},
                auth=auth).json()["id"]
    aarav = store.get_booking("LH-24017")
    leak = tickets.raise_ticket(aarav, aarav["guest_phone"], "maintenance", "medium", "Basin leak", "Bedroom 2.")
    await asyncio.sleep(0.05)
    team = c.get("/api/properties/GOA-ASG-01", auth=auth).json()["team"]
    check(team["onsite"] == [] and team["offsite"][0]["id"] == op and team["offsite"][0]["assigned"]
          and team["offsite"][0]["refs_here"] == [leak["ref"]], "team: offsite operator, assigned to the leak")
    team = c.get("/api/properties/ALB-AWS-02", auth=auth).json()["team"]
    check(team["offsite"][0]["id"] == op and not team["offsite"][0]["assigned"]
          and team["offsite"][0]["open_elsewhere"] == 1, "same operator record at another villa: available there")
    o = c.get(f"/api/operators/{op}", auth=auth).json()
    check([x["ref"] for x in o["tasks"]] == [leak["ref"]] and "messages" in o, "operator detail: tasks and chat")

    # message delivery: Gia's reply is logged with its real state
    await main._converse(aarav["guest_phone"], "Hi", send=True)
    msgs = c.get("/api/bookings/LH-24017/conversation", auth=auth).json()["messages"]
    out = msgs[-1]
    check(out["direction"] == "out" and out["status"] == "sent", "Gia's reply logged as sent")
    wamid = store.messages_for_booking("LH-24017", 1)[0][0]["wa_message_id"]
    store.message_receipt(wamid, "read")
    store.message_receipt(wamid, "delivered")  # late receipt doesn't move it back
    out = c.get("/api/bookings/LH-24017/conversation", auth=auth).json()["messages"][-1]
    check(out["status"] == "read", "receipts move a message forward only")

    fail_next["on"] = True
    await main._converse(aarav["guest_phone"], "Hello?", send=True)
    fail_next["on"] = False
    convo = c.get("/api/bookings/LH-24017/conversation", auth=auth).json()
    out = convo["messages"][-1]
    check(out["status"] == "failed" and "131026" in (out["error"] or ""), "failed send shown as failed, not sent")
    att = c.get("/api/state", auth=auth).json()["attention"]
    check(any(a["kind"] == "message" and a["booking_id"] == "LH-24017" for a in att), "failed message needs attention")
    check(convo["window_open"] and convo["booking"]["villa_id"] == "GOA-ASG-01",
          "conversation is tied to its villa and knows the 24-hour window")
    check(c.get("/api/bookings/NOPE/conversation", auth=auth).status_code == 404, "unknown booking 404")

    # a status change that messages the guest also records delivery
    r = c.post(f"/api/tickets/{leak['id']}/status", json={"status": "acknowledged"}, auth=auth)
    out = c.get("/api/bookings/LH-24017/conversation", auth=auth).json()["messages"][-1]
    check("picked up your request" in out["body"] and out["status"] == "sent", "ticket update delivery tracked")
    check(not any(a["kind"] == "message" and a["booking_id"] == "LH-24017"
                  for a in c.get("/api/state", auth=auth).json()["attention"]),
          "a later delivered message clears the failed-message flag")

    # scale: 320 villas, search and paging stay server-side and quick
    for i in range(320):
        store._villas[f"SYN-{i:03d}"] = {"villa_id": f"SYN-{i:03d}", "name": f"Synthetic Villa {i:03d}",
                                         "location": f"Area {i % 12}", "area": f"Area {i % 12}"}
    started = time.perf_counter()
    r = q(limit=50)
    took = time.perf_counter() - started
    check(r["portfolio_total"] == 323 and len(r["rows"]) == 50 and r["total"] == 323, "pages of 50 out of 323")
    check(q(q="synthetic villa 317")["rows"][0]["id"] == "SYN-317", "search reaches beyond the first page")
    check(q(offset=300, limit=50)["rows"][-1]["id"] and len(q(offset=300, limit=50)["rows"]) == 23, "last page")
    check(took < 2.0, f"register for 323 villas in {took:.2f}s")
    started = time.perf_counter()
    c.get("/api/state", auth=auth)
    check(time.perf_counter() - started < 2.0, f"snapshot for 323 villas in {time.perf_counter() - started:.2f}s")


if __name__ == "__main__":
    rules()
    asyncio.run(api_checks())
    print(f"\n{failures} failure(s)" if failures else "\nAll checks passed")
    sys.exit(1 if failures else 0)
