"""Gia WhatsApp concierge: Meta webhook + a small ops dashboard for the demo."""

import asyncio
import html
import logging
import secrets
from collections import defaultdict
from datetime import date

from fastapi import BackgroundTasks, Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import agent, config, scheduler, store, whatsapp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("gia")

app = FastAPI(title="Gia WhatsApp concierge (Lohono demo)")
store.init()

_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)  # one turn at a time per guest

SCHEDULE_INTERVAL_SECONDS = 300  # how often to check for a due UC-OPS-01 trigger


@app.on_event("startup")
async def _start_scheduler() -> None:
    async def loop():
        while True:
            try:
                await scheduler.run_once()
            except Exception:
                log.exception("UC-OPS-01 schedule run failed")
            await asyncio.sleep(SCHEDULE_INTERVAL_SECONDS)
    asyncio.create_task(loop())

STATUS_MESSAGES = {
    "acknowledged": "The team has picked up your request {ref} ({summary}). Expected by {due}.",
    "in_progress": "Your request {ref} ({summary}) is in progress now.",
    "delayed": "Sorry, your request {ref} ({summary}) is running late. We've escalated it and will update you shortly.",
    "closed": "Your request {ref} ({summary}) is done. Is everything as you wanted? Just reply here if not.",
}


# ---------------- Meta webhook ----------------

@app.get("/webhook")
async def verify(request: Request):
    """Meta calls this once when you save the callback URL."""
    p = request.query_params
    if p.get("hub.mode") == "subscribe" and config.WHATSAPP_VERIFY_TOKEN and \
            secrets.compare_digest(p.get("hub.verify_token", ""), config.WHATSAPP_VERIFY_TOKEN):
        return PlainTextResponse(p.get("hub.challenge", ""))
    raise HTTPException(status_code=403, detail="Verification failed")


@app.post("/webhook")
async def receive(request: Request, background: BackgroundTasks):
    raw = await request.body()
    if not whatsapp.signature_ok(raw, request.headers.get("X-Hub-Signature-256")):
        raise HTTPException(status_code=401, detail="Bad signature")
    payload = await request.json()

    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for msg in value.get("messages", []):
                if store.first_time_seen(msg["id"]):  # Meta retries deliveries; handle each message once
                    background.add_task(_handle_incoming, msg)
            for st in value.get("statuses", []):
                if st.get("status") == "failed":
                    log.error("Delivery failed to %s: %s", st.get("recipient_id"), st.get("errors"))
    return {"ok": True}  # acknowledge fast; Meta expects a 200 quickly


async def _handle_incoming(msg: dict) -> None:
    phone = msg["from"]
    kind = msg.get("type")
    if kind == "text":
        text = msg["text"]["body"]
    elif kind == "interactive":
        reply = msg["interactive"].get("button_reply") or msg["interactive"].get("list_reply") or {}
        text = reply.get("title", "")
    elif kind == "button":
        text = msg["button"].get("text", "")
    elif kind in ("image", "video", "document"):
        caption = msg.get(kind, {}).get("caption", "")
        text = f"(The guest sent a {kind}{': ' + caption if caption else ''}. You cannot see attachments yet; acknowledge it and ask them to describe it in words if needed.)"
    elif kind == "audio":
        text = "(The guest sent a voice note. You cannot listen to it yet; ask them kindly to type the message.)"
    elif kind == "location":
        loc = msg["location"]
        text = f"(The guest shared a location: {loc.get('name') or ''} {loc.get('latitude')},{loc.get('longitude')})"
    else:
        text = f"(The guest sent an unsupported {kind} message.)"

    await whatsapp.mark_read(msg["id"])
    await _converse(phone, text, send=True)


async def _converse(phone: str, text: str, send: bool) -> str:
    async with _locks[phone]:
        booking = store.find_booking(phone)
        booking_id = booking["booking_id"] if booking else None
        store.log_message(phone, booking_id, "in", text)
        try:
            answer = await agent.reply(phone, text)
        except Exception:
            log.exception("Gia failed for %s", phone)
            store.create_handoff(booking_id, phone, f"Gia errored on: {text}", "normal")  # NFR-08
            answer = "Sorry, I'm having trouble right now. I've asked someone from the Lohono team to reply to you."
        store.log_message(phone, booking_id, "out", answer)
        if send:
            await whatsapp.send_text(phone, answer)
        return answer


# ---------------- Ops dashboard (demo) ----------------

security = HTTPBasic()


def admin(creds: HTTPBasicCredentials = Depends(security)) -> None:
    if not config.ADMIN_PASSWORD or not secrets.compare_digest(creds.password, config.ADMIN_PASSWORD):
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Basic"})


def _e(v) -> str:
    return html.escape("" if v is None else str(v))


def _table(rows: list[dict], cols: list[str], extra=None) -> str:
    if not rows:
        return "<p class=muted>Nothing yet.</p>"
    head = "".join(f"<th>{_e(c)}</th>" for c in cols) + ("<th></th>" if extra else "")
    body = ""
    for r in rows:
        body += "<tr>" + "".join(f"<td>{_e(r.get(c))}</td>" for c in cols)
        body += f"<td>{extra(r)}</td>" if extra else ""
        body += "</tr>"
    return f"<table><tr>{head}</tr>{body}</table>"


PAGE = """<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Gia ops console</title><meta http-equiv=refresh content=15>
<style>
:root{{--bg:#faf8f4;--fg:#1d1b18;--muted:#7a746b;--line:#e6e0d6;--accent:#8a6a3b}}
@media (prefers-color-scheme:dark){{:root{{--bg:#16140f;--fg:#efe9df;--muted:#a39b8e;--line:#2f2a22;--accent:#d2ad74}}}}
body{{font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px;max-width:1200px}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:28px 0 8px;color:var(--accent)}}
.muted{{color:var(--muted)}} table{{border-collapse:collapse;width:100%;display:block;overflow-x:auto}}
td,th{{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}}
th{{font-weight:600;color:var(--muted)}} form{{display:inline}} button{{margin:1px;cursor:pointer}}
.chat{{max-height:420px;overflow:auto;border:1px solid var(--line);padding:8px}}
.in{{margin:4px 0}} .out{{margin:4px 0 4px 32px;color:var(--accent)}}
</style></head><body>
<h1>Gia ops console</h1><div class=muted>Lohono Stays demo · stands in for OI · refreshes every 15s</div>
{body}</body></html>"""


@app.get("/admin", response_class=HTMLResponse, dependencies=[Depends(admin)])
async def dashboard():
    def ticket_actions(t):
        return "".join(
            f"<form method=post action=/admin/tickets/{t['id']}/status>"
            f"<input type=hidden name=status value={s}><button>{s.replace('_', ' ')}</button></form>"
            for s in STATUS_MESSAGES if s != t["status"]) if t["status"] != "closed" else ""

    def booking_actions(b):
        return (f"<form method=post action=/admin/welcome/{b['booking_id']}><button>Send welcome</button></form>"
                f"<form method=post action=/admin/reset/{b['guest_phone']}><button>Reset chat</button></form>")

    chat = "".join(
        f"<div class={m['direction']}><span class=muted>{_e(m['at'][11:16])} {_e(m['phone'])}</span> "
        f"{_e(m['body'])}</div>" for m in store.transcript())

    bookings = [dict(b, details=store.guest_details(b["booking_id"])) for b in store.all_bookings()]
    schedules = store.all_schedules()
    today = store.now().date()
    pre_arrival = [
        dict(booking_id=b["booking_id"], guest_name=b["guest_name"],
             check_in=b["check_in"], days_left=(date.fromisoformat(b["check_in"]) - today).days,
             **{k: v for k, v in schedules.get(b["booking_id"], {}).items() if k != "booking_id"})
        for b in store.all_bookings() if b["status"] == "confirmed"
    ]
    body = (
        "<h2>Pre-arrival schedule (UC-OPS-01)</h2>"
        + "<p class=muted>Welcome at booking confirmation, then T-7 and T-1 before check-in. "
          f"Runs automatically every {SCHEDULE_INTERVAL_SECONDS // 60} min.</p>"
        + "<form method=post action=/admin/run-schedule><button>Run check now</button></form>"
        + _table(pre_arrival, ["booking_id", "guest_name", "check_in", "days_left", "welcome_at", "t7_at",
                               "t7_reminder_at", "t1_at", "t1_host_flag_at"])
        + "<h2>Human handoffs (control tower)</h2>"
        + _table(store.all_handoffs(), ["id", "at", "urgency", "booking_id", "phone", "reason", "status"])
        + "<h2>Tickets</h2><p class=muted>Changing a status messages the guest on WhatsApp (UC-OPS-05 step 5).</p>"
        + _table(store.all_tickets(), ["ref", "created_at", "booking_id", "category", "severity", "summary",
                                       "status", "assignee", "due_at"], ticket_actions)
        + "<h2>Conversation</h2><div class=chat>" + (chat or "<p class=muted>No messages yet.</p>") + "</div>"
        + "<h2>Try Gia without WhatsApp</h2>"
        + "<form method=post action=/admin/simulate><select name=phone>"
        + "".join(f"<option value={b['guest_phone']}>{_e(b['guest_name'])} ({b['booking_id']})</option>"
                  for b in store.all_bookings())
        + "</select> <input name=text size=60 placeholder='Can we get a private chef tomorrow night?'> "
          "<button>Send as guest</button></form>"
        + "<h2>Preferences captured</h2>"
        + _table(store.all_preferences(), ["at", "guest_name", "category", "preference", "source_quote"])
        + "<h2>Bookings and arrival details</h2>"
        + _table(bookings, ["booking_id", "guest_name", "guest_phone", "villa_id", "check_in", "check_out",
                            "status", "details"], booking_actions)
        + "<h2>Audit log (NFR-04)</h2>"
        + _table(store.audit_log(), ["at", "booking_id", "action", "tier", "data"])
    )
    return PAGE.format(body=body)


@app.post("/admin/tickets/{ticket_id}/status", dependencies=[Depends(admin)])
async def change_status(ticket_id: int, status: str = Form(...)):
    if status not in STATUS_MESSAGES:
        raise HTTPException(400, "Unknown status")
    t = store.set_ticket_status(ticket_id, status)
    if not t:
        raise HTTPException(404)
    msg = STATUS_MESSAGES[status].format(ref=t["ref"], summary=t["summary"],
                                         due=t["due_at"][11:16] + " IST")
    store.audit(t["booking_id"], f"ticket_status:{status}", "tier0", {"ticket": t["ref"]})
    store.log_message(t["phone"], t["booking_id"], "out", msg)
    store.add_note(t["phone"], f"ops set ticket {t['ref']} to '{status}' and Gia sent the guest: \"{msg}\"")
    await whatsapp.send_text(t["phone"], msg)
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/welcome/{booking_id}", dependencies=[Depends(admin)])
async def send_welcome(booking_id: str):
    """UC-OPS-01 manual override: open the conversation right now instead of waiting for the schedule."""
    b = store.get_booking(booking_id)
    if not b:
        raise HTTPException(404)
    await scheduler.send_welcome(b)
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/run-schedule", dependencies=[Depends(admin)])
async def run_schedule():
    """UC-OPS-01 manual trigger: check every booking now instead of waiting for the background loop."""
    await scheduler.run_once()
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/simulate", dependencies=[Depends(admin)])
async def simulate(phone: str = Form(...), text: str = Form(...)):
    await _converse(phone, text, send=False)
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/reset/{phone}", dependencies=[Depends(admin)])
async def reset(phone: str):
    store.reset_history(phone)
    return RedirectResponse("/admin", status_code=303)


@app.get("/")
async def health():
    return {"service": "gia-whatsapp-demo", "ok": True}
