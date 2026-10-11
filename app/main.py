"""Gia WhatsApp concierge: Meta webhook, mock OI booking events, and a small ops console for the demo."""

import asyncio
import html
import logging
import secrets
from collections import defaultdict
from datetime import date
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

from fastapi import BackgroundTasks, Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel

from . import agent, config, operators, ops_view, scheduler, store, tickets, whatsapp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("gia")

app = FastAPI(title="Gia WhatsApp concierge (Lohono demo)")
store.init()

_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)  # one turn at a time per guest
_background: set[asyncio.Task] = set()  # keeps fire-and-forget tasks referenced until they finish

SCHEDULE_INTERVAL_SECONDS = 60  # how often to send due UC-OPS-01 steps and pending ticket emails


@app.on_event("startup")
async def _start_scheduler() -> None:
    async def loop():
        while True:
            try:
                await scheduler.run_once()
            except Exception:
                log.exception("UC-OPS-01 schedule run failed")
            try:
                await tickets.flush_outbox()
            except Exception:
                log.exception("Ticket email flush failed")
            await asyncio.sleep(SCHEDULE_INTERVAL_SECONDS)
    task = asyncio.create_task(loop())
    _background.add(task)

STATUS_MESSAGES = tickets.STATUS_MESSAGES


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
                background.add_task(scheduler.on_delivery_status, st)  # UC-OPS-01 delivered / read / failed
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
    staff = store.staff_by_phone(phone)
    if staff and not any(b["guest_phone"] == phone for b in store.all_bookings()):  # a guest's own number stays a guest
        async with _locks[phone]:
            await operators.handle_message(staff, text)
        return
    await _converse(phone, text, send=True)


async def _converse(phone: str, text: str, send: bool) -> str:
    async with _locks[phone]:
        booking = store.find_booking(phone)
        booking_id = booking["booking_id"] if booking else None
        store.log_message(phone, booking_id, "in", text)
        if store.takeover_active(phone):  # a person from ops is replying; Gia catches up when they hand back
            store.add_note(phone, f"while the ops team was handling the chat, the guest wrote: \"{text}\"")
            return ""
        try:
            answer = await agent.reply(phone, text)
        except Exception:
            log.exception("Gia failed for %s", phone)
            tickets.raise_handoff(booking, phone, f"Gia errored on: {text}", "normal")  # NFR-08
            answer = "Sorry, I'm having trouble right now. I've asked someone from the Lohono team to reply to you."
        store.log_message(phone, booking_id, "out", answer)
        if send:
            await whatsapp.send_text(phone, answer)
        return answer


# ---------------- Mock OI booking events (UC-OPS-01 trigger) ----------------

@app.post("/oi/events/booking")
async def oi_booking_event(request: Request):
    """Stand-in for OI's booking webhook.

    Body: {"event": "confirmed" | "modified" | "cancelled", "booking": {"booking_id": ..., "guest_name": ...,
    "guest_phone": ..., "villa_id": ..., "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD", ...}}
    Header: X-OI-Secret: <OI_WEBHOOK_SECRET>
    """
    if not config.OI_WEBHOOK_SECRET:
        raise HTTPException(503, "OI_WEBHOOK_SECRET is not set")
    if not secrets.compare_digest(request.headers.get("X-OI-Secret", ""), config.OI_WEBHOOK_SECRET):
        raise HTTPException(401, "Bad OI secret")
    payload = await request.json()
    try:
        booking = scheduler.on_booking_event(payload.get("event", ""), payload.get("booking") or {})
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    task = asyncio.create_task(scheduler.run_once())  # send a due welcome now rather than at the next loop
    _background.add(task)
    task.add_done_callback(_background.discard)
    return {"ok": True, "booking": booking, "steps": store.steps_for_booking(booking["booking_id"])}


# ---------------- Ops console (demo) ----------------

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


def _short(iso: str | None) -> str:
    return iso[5:16].replace("T", " ") if iso else ""


def _back(path: str, back: str, msg: str) -> RedirectResponse:
    """Redirect to a console page, keeping its filters and showing a one-line message."""
    params = dict(parse_qsl(back))
    params["msg"] = msg
    return RedirectResponse(f"{path}?{urlencode(params)}", status_code=303)


PAGE = """<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Gia ops console</title>{refresh}
<style>
:root{{--bg:#faf8f4;--fg:#1d1b18;--muted:#7a746b;--line:#e6e0d6;--accent:#8a6a3b}}
@media (prefers-color-scheme:dark){{:root{{--bg:#16140f;--fg:#efe9df;--muted:#a39b8e;--line:#2f2a22;--accent:#d2ad74}}}}
body{{font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px;max-width:1200px}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:28px 0 8px;color:var(--accent)}}
a{{color:var(--accent)}} .muted{{color:var(--muted)}} .msg{{border:1px solid var(--accent);padding:6px 10px;margin:12px 0}}
table{{border-collapse:collapse;width:100%;display:block;overflow-x:auto}}
td,th{{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}}
th{{font-weight:600;color:var(--muted)}} form{{display:inline}} button{{margin:1px;cursor:pointer}}
fieldset{{border:1px solid var(--line);margin:12px 0;padding:8px 12px}} label{{margin-right:12px;white-space:nowrap}}
input[type=number]{{width:4em}}
.chat{{max-height:420px;overflow:auto;border:1px solid var(--line);padding:8px}}
.in{{margin:4px 0}} .out{{margin:4px 0 4px 32px;color:var(--accent)}}
</style></head><body>
<h1>Gia ops console</h1><div class=muted>Lohono Stays demo · stands in for OI ·
<a href=/admin>Console</a> · <a href=/admin/villas>Villas &amp; staff</a> · <a href=/>Ops console</a></div>
{msg}{body}</body></html>"""


def _page(body: str, msg: str = "", refresh: bool = False) -> str:
    return PAGE.format(body=body, msg=f"<div class=msg>{_e(msg)}</div>" if msg else "",
                       refresh="<meta http-equiv=refresh content=15>" if refresh else "")


def _step_cell(st: dict | None) -> str:
    if not st:
        return ""
    when = {"scheduled": st["due_at"], "sent": st["sent_at"], "delivered": st["delivered_at"],
            "read": st["read_at"]}.get(st["status"]) or st["updated_at"]
    cell = f"{st['status']} {_short(when)}"
    if st["channel"]:
        cell += f" · {st['template'] or 'free text'}"
    if st["note"]:
        cell += f" ({st['note']})"
    return cell


def _coverage(all_steps: dict, booking_ids: set[str]) -> str:
    """Acceptance check: how many bookings have received each UC-OPS-01 message."""
    groups = {"received": ("delivered", "read"), "sent, no receipt yet": ("sent",), "scheduled": ("scheduled",),
              "failed": ("failed",), "skipped or cancelled": ("skipped", "cancelled")}
    lines = []
    for name in ("welcome", "t7", "t1"):
        statuses = [all_steps.get(b, {}).get(name, {}).get("status") for b in booking_ids]
        parts = [f"{n} {label}" for label, group in groups.items() if (n := sum(st in group for st in statuses))]
        lines.append(f"<b>{scheduler.STEP_LABELS[name]}</b>: {', '.join(parts) or 'none yet'}")
    return f"<p>{' · '.join(lines)}</p>"


@app.get("/admin/bookings/{booking_id}", response_class=HTMLResponse, dependencies=[Depends(admin)])
async def booking_page(booking_id: str):
    """Everything on one booking: the UC-OPS-01 journey, every message both ways, tickets and preferences."""
    b = store.get_booking(booking_id)
    if not b:
        raise HTTPException(404)
    villa = store.get_villa(b["villa_id"]) or {}
    rec = store.booking_record(booking_id)
    steps = store.steps_for_booking(booking_id)
    journey = [{**steps[name], "step": scheduler.STEP_LABELS[name]} for name in scheduler.STEPS if name in steps]
    chat = "".join(
        f"<div class={m['direction']}><span class=muted>{_e(_short(m['at']))} "
        f"{ {'in': 'guest', 'ops': 'ops team'}.get(m['direction'], 'Gia')}</span> {_e(m['body'])}</div>"
        for m in rec["messages"])
    staff = store.staff_for_villa(b["villa_id"])
    body = (
        f"<h2>{_e(b['guest_name'])} · {_e(booking_id)}</h2>"
        f"<p>{_e(villa.get('name', b['villa_id']))}, {_e(villa.get('location'))} · {_e(b['check_in'])} to "
        f"{_e(b['check_out'])} · status {_e(b['status'])} · +{_e(b['guest_phone'])} · confirmed "
        f"{_e(_short(b.get('confirmed_at')))}<br>Caretaker: "
        f"{_e(staff.get('caretaker', {}).get('name', 'not assigned'))} · Manager: "
        f"{_e(staff.get('manager', {}).get('name', 'not assigned'))}</p>"
        "<h2>UC-OPS-01 journey</h2>"
        + _table(journey, ["step", "status", "due_at", "sent_at", "delivered_at", "read_at", "channel", "template",
                           "attempts", "note"])
        + "<h2>Messages on this booking</h2><div class=chat>"
        + (chat or "<p class=muted>No messages yet.</p>") + "</div>"
        + "<h2>Tickets</h2>"
        + _table(rec["tickets"], ["ref", "created_at", "source", "category", "severity", "summary", "status",
                                  "assignee"])
        + "<h2>Handoffs</h2>" + _table(rec["handoffs"], ["id", "at", "urgency", "reason", "status"])
        + "<h2>Arrival details</h2><p>" + (_e(d) if (d := store.guest_details(booking_id)) else "None yet.") + "</p>"
        + "<h2>Preferences</h2>" + _table(rec["preferences"], ["at", "category", "preference", "source_quote"])
        + "<h2>Audit trail</h2>" + _table(rec["audit"], ["at", "action", "tier", "data"])
    )
    return _page(body)


@app.get("/admin", response_class=HTMLResponse, dependencies=[Depends(admin)])
async def dashboard(msg: str = ""):
    def ticket_actions(t):
        return "".join(
            f"<form method=post action=/admin/tickets/{t['id']}/status>"
            f"<input type=hidden name=status value={s}><button>{s.replace('_', ' ')}</button></form>"
            for s in STATUS_MESSAGES if s != t["status"]) if t["status"] != "closed" else ""

    def booking_actions(b):
        return (f"<a href=/admin/bookings/{_e(b['booking_id'])}>Open</a> "
                f"<form method=post action=/admin/reset/{b['guest_phone']}><button>Reset chat</button></form>")

    def journey_actions(r):
        link = f"<a href=/admin/bookings/{_e(r['booking_id'])}>Open</a> "
        if r["_welcome_status"] != "scheduled":
            return link
        return (link + f"<form method=post action=/admin/welcome/{r['booking_id']}>"
                f"<button>Send welcome now</button></form>")

    chat = "".join(
        f"<div class={m['direction']}><span class=muted>{_e(m['at'][11:16])} {_e(m['phone'])}</span> "
        f"{_e(m['body'])}</div>" for m in store.transcript())

    bookings = [dict(b, details=store.guest_details(b["booking_id"])) for b in store.all_bookings()]
    all_steps = store.all_steps()
    today = store.now().date()
    journey = []
    for b in store.all_bookings():
        steps = all_steps.get(b["booking_id"], {})
        if b["status"] != "confirmed" and not steps:
            continue
        villa = store.get_villa(b["villa_id"]) or {}
        journey.append(dict(
            booking_id=b["booking_id"], guest=b["guest_name"], villa=villa.get("name", b["villa_id"]),
            check_in=b["check_in"], days_left=(date.fromisoformat(b["check_in"]) - today).days,
            booking_status=b["status"], _welcome_status=(steps.get("welcome") or {}).get("status"),
            **{scheduler.STEP_LABELS[name]: _step_cell(steps.get(name)) for name in scheduler.STEPS}))

    villa_options = "".join(f"<option value={_e(v['villa_id'])}>{_e(v['name'])}</option>" for v in store.all_villas())
    body = (
        "<h2>UC-OPS-01 pre-arrival journey</h2>"
        + "<p class=muted>Welcome on booking confirmation, then T-7 and T-1 before check-in, inside each villa's "
          f"send window. Due steps go out every {SCHEDULE_INTERVAL_SECONDS} s. Status: scheduled → sent → "
          "delivered → read, or failed / skipped / cancelled. Per-villa settings are on "
          "<a href=/admin/villas>Villas &amp; staff</a>.</p>"
        + _coverage(all_steps, {r["booking_id"] for r in journey})
        + "<form method=post action=/admin/run-schedule><button>Run check now</button></form>"
        + _table(journey, ["booking_id", "guest", "villa", "check_in", "days_left", "booking_status",
                           *scheduler.STEP_LABELS.values()], journey_actions)
        + "<h2>Simulate an OI booking event</h2>"
        + "<p class=muted>Stands in for OI's booking webhook (POST /oi/events/booking). For modified and "
          "cancelled, only the booking ID and the fields that change are needed.</p>"
        + "<form method=post action=/admin/oi-event>"
          "<select name=event><option>confirmed</option><option>modified</option><option>cancelled</option></select> "
          "<input name=booking_id placeholder='LH-24030' size=9> <input name=guest_name placeholder='Guest name'> "
          "<input name=guest_phone placeholder='9198XXXXXXXX' size=13> "
          f"<select name=villa_id><option value=''>Villa</option>{villa_options}</select> "
          "<label>check-in <input type=date name=check_in></label><label>check-out <input type=date name=check_out></label>"
          "<select name=language><option value=''>Language</option><option>en</option><option>hi</option></select> "
          "<button>Send event</button></form>"
        + "<h2>Human handoffs (control tower)</h2>"
        + _table(store.all_handoffs(), ["id", "at", "urgency", "booking_id", "phone", "reason", "status"])
        + "<h2>Tickets (mock OI)</h2><p class=muted>Every ticket is emailed to "
          f"{_e(config.TICKET_EMAIL_TO)}. Changing the status of a guest's own request messages them on "
          "WhatsApp (UC-OPS-05 step 5); internal tickets don't.</p>"
        + _table(store.all_tickets(), ["ref", "created_at", "booking_id", "source", "category", "severity",
                                       "summary", "status", "assignee", "due_at"], ticket_actions)
        + "<h2>Ticket emails</h2>"
        + ("<p class=muted>RESEND_API_KEY isn't set, so emails are logged, not sent.</p>"
           if not config.RESEND_API_KEY or config.DRY_RUN else "")
        + _table(store.outbox(), ["created_at", "ref", "to_addr", "subject", "status", "attempts", "error"])
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
                            "status", "confirmed_at", "details"], booking_actions)
        + "<h2>Audit log (NFR-04)</h2>"
        + _table(store.audit_log(), ["at", "booking_id", "action", "tier", "data"])
    )
    return _page(body, msg, refresh=not msg)


async def _set_ticket_status(ticket_id: int, status: str, by: str = "ops") -> dict:
    try:
        return await tickets.set_status(ticket_id, status, by=by)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except LookupError:
        raise HTTPException(404) from None


@app.post("/admin/tickets/{ticket_id}/status", dependencies=[Depends(admin)])
async def change_status(ticket_id: int, status: str = Form(...)):
    await _set_ticket_status(ticket_id, status)
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/welcome/{booking_id}", dependencies=[Depends(admin)])
async def send_welcome(booking_id: str):
    """UC-OPS-01 manual override: send the welcome now instead of waiting for the send window."""
    if not store.get_booking(booking_id):
        raise HTTPException(404)
    await scheduler.send_now(booking_id, "welcome")
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/run-schedule", dependencies=[Depends(admin)])
async def run_schedule():
    """UC-OPS-01 manual trigger: send due steps now instead of waiting for the background loop."""
    await scheduler.run_once()
    await tickets.flush_outbox()
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/oi-event", dependencies=[Depends(admin)])
async def simulate_oi_event(request: Request):
    form = await request.form()
    event = form.get("event", "")
    data = {k: form.get(k) for k in ("booking_id", "guest_name", "guest_phone", "villa_id", "check_in",
                                     "check_out", "language")}
    try:
        booking = scheduler.on_booking_event(event, data)
    except (LookupError, ValueError) as e:
        return _back("/admin", "", f"OI event not applied: {e}")
    await scheduler.run_once()
    return _back("/admin", "", f"OI '{event}' event applied to {booking['booking_id']}")


@app.post("/admin/simulate", dependencies=[Depends(admin)])
async def simulate(phone: str = Form(...), text: str = Form(...)):
    await _converse(phone, text, send=False)
    return RedirectResponse("/admin", status_code=303)


@app.post("/admin/reset/{phone}", dependencies=[Depends(admin)])
async def reset(phone: str):
    store.reset_history(phone)
    return RedirectResponse("/admin", status_code=303)


# ---------------- Villas & staff: caretakers, managers and per-villa UC-OPS-01 settings ----------------

VILLA_SEARCH_FIELDS = ("villa_id", "name", "location", "area", "residency", "group")


@app.get("/admin/villas", response_class=HTMLResponse, dependencies=[Depends(admin)])
async def villas_page(request: Request, q: str = "", area: str = "", residency: str = "", group: str = "",
                      msg: str = ""):
    villas = store.all_villas()
    filters = {"area": area, "residency": residency, "group": group}

    def select(key: str) -> str:
        values = sorted({v.get(key) for v in villas if v.get(key)})
        opts = "".join(f"<option{' selected' if val == filters[key] else ''}>{_e(val)}</option>" for val in values)
        return f"<label>{key} <select name={key}><option value=''>All</option>{opts}</select></label>"

    shown = [v for v in villas
             if all(not want or v.get(key) == want for key, want in filters.items())
             and (not q or q.lower() in " ".join(str(v.get(k) or "") for k in VILLA_SEARCH_FIELDS).lower())]

    def staff_cell(person: dict | None) -> str:
        return f"{_e(person['name'])} <span class=muted>{_e(person['phone'])}</span>" if person else \
            "<span class=muted>not assigned</span>"

    def settings_cell(villa_id: str) -> str:
        s = scheduler.settings(villa_id)
        return _e(f"{'on' if s['enabled'] else 'OFF'} · T-{s['t7_days']} / T-{s['t1_days']} · "
                  f"{s['window_start']}–{s['window_end']} · reminder "
                  f"{str(s['reminder_hours']) + 'h' if s['reminder_enabled'] else 'off'} · no-reply flag "
                  f"{'on' if s['flag_no_reply'] else 'off'}")

    rows = ""
    for v in shown:
        staff = store.staff_for_villa(v["villa_id"])
        rows += (f"<tr><td><input type=checkbox name=villa_ids value={_e(v['villa_id'])}></td>"
                 f"<td>{_e(v['name'])}<br><span class=muted>{_e(v['villa_id'])}</span></td>"
                 f"<td>{_e(v.get('area'))}</td><td>{_e(v.get('residency'))}</td><td>{_e(v.get('group'))}</td>"
                 f"<td>{staff_cell(staff.get('caretaker'))}</td><td>{staff_cell(staff.get('manager'))}</td>"
                 f"<td>{settings_cell(v['villa_id'])}</td></tr>")
    staff_list = store.all_staff()
    staff_options = "".join(f"<option value={p['id']}>{_e(p['name'])}</option>" for p in staff_list)
    back = _e(urlencode({k: v for k, v in request.query_params.items() if k != "msg"}))
    d = scheduler.DEFAULTS
    on_off = lambda name: (f"<select name={name}><option value=''>keep</option>"  # noqa: E731
                           "<option value=on>on</option><option value=off>off</option></select>")

    body = (
        "<h2>Find villas</h2><form method=get action=/admin/villas>"
        f"<input name=q value='{_e(q)}' placeholder='Search name, area, residency, group' size=32> "
        f"{select('area')}{select('residency')}{select('group')}<button>Filter</button> "
        "<a href=/admin/villas>Clear</a></form>"
        f"<form method=post id=bulk><input type=hidden name=back value='{back}'>"
        "<table><tr><th><input type=checkbox title='Select all' onclick=\"document.querySelectorAll("
        "'input[name=villa_ids]').forEach(c => c.checked = this.checked)\"></th><th>Villa</th><th>Area</th>"
        "<th>Residency</th><th>Group</th><th>Caretaker</th><th>Manager</th><th>UC-OPS-01</th></tr>"
        + (rows or "<tr><td colspan=8 class=muted>No villas match.</td></tr>") + "</table>"
        "<fieldset><legend>Assign to the selected villas</legend>"
        "<select name=role><option value=caretaker>Caretaker</option><option value=manager>Manager</option></select> "
        f"<select name=staff_id>{staff_options}<option value=''>(remove)</option></select> "
        "<button formaction=/admin/villas/assign>Assign</button>"
        + ("" if staff_list else " <span class=muted>Add people under Staff below first.</span>")
        + "</fieldset>"
        "<fieldset><legend>UC-OPS-01 settings for the selected villas (blank or 'keep' leaves a value as it is)</legend>"
        f"<label>Use case {on_off('enabled')}</label>"
        f"<label>T-<input type=number name=t7_days min=2 max=30 placeholder={d['t7_days']}> pre-arrival days</label>"
        f"<label>T-<input type=number name=t1_days min=1 max=3 placeholder={d['t1_days']}> arrival days</label>"
        f"<label>Send between <input type=time name=window_start> and <input type=time name=window_end> IST</label>"
        f"<label>Reminder {on_off('reminder_enabled')} after "
        f"<input type=number name=reminder_hours min=1 max=72 placeholder={d['reminder_hours']}> h without a reply</label>"
        f"<label>Flag no reply by T-1 to the caretaker, manager and control tower {on_off('flag_no_reply')}</label>"
        "<br><button formaction=/admin/villas/uc-ops-01>Apply to selected</button>"
        "</fieldset></form>"
        "<h2>Staff</h2><p class=muted>Caretakers and managers get the ticket email in copy and a WhatsApp alert "
        "(template gia_staff_alert). The caretaker's number is the contact Gia gives guests at T-1.</p>"
        + _table(staff_list, ["name", "phone", "email"])
        + "<form method=post action=/admin/staff><input name=name placeholder='Name' required> "
          "<input name=phone placeholder='9198XXXXXXXX' size=13> <input name=email type=email placeholder='Email'> "
          "<button>Add person</button></form>"
    )
    return _page(body, msg)


@app.post("/admin/villas/assign", dependencies=[Depends(admin)])
async def assign_staff(request: Request):
    form = await request.form()
    villa_ids, role, staff_id = form.getlist("villa_ids"), form.get("role"), form.get("staff_id") or ""
    back = form.get("back", "")
    if not villa_ids:
        return _back("/admin/villas", back, "Select at least one villa.")
    if role not in store.STAFF_ROLES:
        raise HTTPException(400, "Unknown role")
    store.assign_staff(villa_ids, role, int(staff_id) if staff_id else None)
    store.audit(None, "villa_staff_assigned", "tier0", {"villas": villa_ids, "role": role, "staff_id": staff_id})
    who = next((p["name"] for p in store.all_staff() if str(p["id"]) == staff_id), None)
    return _back("/admin/villas", back,
                 f"{who} is now {role} for {len(villa_ids)} villa(s)." if who else
                 f"Removed the {role} from {len(villa_ids)} villa(s).")


@app.post("/admin/villas/uc-ops-01", dependencies=[Depends(admin)])
async def save_villa_settings(request: Request):
    form = await request.form()
    villa_ids, back = form.getlist("villa_ids"), form.get("back", "")
    if not villa_ids:
        return _back("/admin/villas", back, "Select at least one villa.")
    try:
        changes = scheduler.parse_settings({k: form.get(k) for k in scheduler.DEFAULTS})
        if not changes:
            return _back("/admin/villas", back, "Nothing to change: fill in at least one setting.")
        scheduler.apply_settings(villa_ids, changes)
    except ValueError as e:
        return _back("/admin/villas", back, f"Not saved: {e}")
    store.audit(None, "uc_ops_01_settings", "tier0", {"villas": villa_ids, "changes": changes})
    return _back("/admin/villas", back, f"UC-OPS-01 settings saved for {len(villa_ids)} villa(s).")


@app.post("/admin/staff", dependencies=[Depends(admin)])
async def add_staff(name: str = Form(...), phone: str = Form(""), email: str = Form("")):
    phone = "".join(ch for ch in phone if ch.isdigit())
    store.add_staff(name.strip(), phone, email.strip())
    return _back("/admin/villas", "", f"Added {name.strip()}.")


# ---------------- Ops console (/) ----------------
# Overview, Guest Journeys and Operations run on the live data below. The guided demo scenarios, the
# field app's photo evidence and the workflow explorer are scripted in the browser (static/ops/data.js).

OPS_CONSOLE_DIR = Path(__file__).parent / "static" / "ops"
OPS_CONSOLE_ASSETS = {"console.css", "console.js", "data.js", "live.js", "lohono-logo.jpeg"}
API = "/api"


class StatusChange(BaseModel):
    status: str


class Takeover(BaseModel):
    on: bool


class OpsReply(BaseModel):
    text: str


class Presence(BaseModel):
    presence: str


class Assign(BaseModel):
    operator_id: int | None


class NewOperator(BaseModel):
    name: str
    phone: str
    role: str
    villa_ids: list[str]
    presence: str = "onsite"


@app.get("/", dependencies=[Depends(admin)])
async def ops_console():
    return FileResponse(OPS_CONSOLE_DIR / "index.html")


@app.get("/admin/ops")
async def ops_console_old_address():
    return RedirectResponse("/", status_code=308)


@app.get(f"{API}/state", dependencies=[Depends(admin)])
async def ops_state():
    return ops_view.snapshot(["open", *STATUS_MESSAGES])


@app.post(f"{API}/tickets/{{ticket_id}}/status", dependencies=[Depends(admin)])
async def ops_ticket_status(ticket_id: int, body: StatusChange):
    t = await _set_ticket_status(ticket_id, body.status)
    return {"ok": True, "ref": t["ref"], "status": t["status"], "guest_messaged": t["source"] in (None, "guest")}


@app.post(f"{API}/bookings/{{booking_id}}/takeover", dependencies=[Depends(admin)])
async def ops_takeover(booking_id: str, body: Takeover):
    """Ops takes the conversation (Gia stops replying and holds scheduled messages) or hands it back."""
    b = store.get_booking(booking_id)
    if not b:
        raise HTTPException(404)
    phone = b["guest_phone"]
    async with _locks[phone]:
        if body.on == store.takeover_active(phone):
            return {"ok": True, "takeover": body.on}
        store.set_takeover(phone, booking_id, body.on)
        store.audit(booking_id, "ops_takeover" if body.on else "ops_handback", "tier0", {})
        if not body.on:
            store.add_note(phone, "the ops team has handed the conversation back to you")
    return {"ok": True, "takeover": body.on}


@app.post(f"{API}/bookings/{{booking_id}}/reply", dependencies=[Depends(admin)])
async def ops_reply(booking_id: str, body: OpsReply):
    """A person from ops replies to the guest on WhatsApp during a takeover."""
    b = store.get_booking(booking_id)
    if not b:
        raise HTTPException(404)
    text, phone = body.text.strip(), b["guest_phone"]
    if not text:
        raise HTTPException(400, "Write a message first")
    if not store.takeover_active(phone):
        raise HTTPException(409, "Take over the conversation before replying")
    async with _locks[phone]:
        try:
            whatsapp.message_id(await whatsapp.send_text(phone, text))
        except whatsapp.WhatsAppError as e:
            if e.code == whatsapp.OUTSIDE_SERVICE_WINDOW:
                raise HTTPException(502, "Not sent: the guest hasn't written in the last 24 hours, so WhatsApp "
                                         "only allows an approved template. Call the guest instead.") from e
            raise HTTPException(502, f"Not sent: {e}") from e
        store.log_message(phone, booking_id, "ops", text)
        store.add_note(phone, f"a person from the ops team replied to the guest: \"{text}\"")
        store.audit(booking_id, "ops_reply", "tier0", {"text": text})
    return {"ok": True}


@app.post(f"{API}/handoffs/{{handoff_id}}/resolve", dependencies=[Depends(admin)])
async def ops_resolve_handoff(handoff_id: int):
    h = store.set_handoff_status(handoff_id, "resolved")
    if not h:
        raise HTTPException(404)
    store.audit(h["booking_id"], "handoff_resolved", "tier0", {"handoff": handoff_id})
    return {"ok": True}


@app.post(f"{API}/operators", dependencies=[Depends(admin)])
async def ops_add_operator(body: NewOperator):
    """Add a field operator and make them the villas' operator for that role (replacing whoever had it)."""
    name, phone = body.name.strip(), "".join(ch for ch in body.phone if ch.isdigit())
    if not name:
        raise HTTPException(400, "Enter the operator's name")
    if len(phone) < 10:
        raise HTTPException(400, "Enter a WhatsApp number with country code, e.g. 9198XXXXXXXX")
    if body.role not in store.OPERATOR_ROLES:
        raise HTTPException(400, "Unknown role")
    if body.presence not in store.PRESENCE:
        raise HTTPException(400, "Presence must be onsite or offsite")
    villa_ids = [v for v in body.villa_ids if store.get_villa(v)]
    if not villa_ids:
        raise HTTPException(400, "Choose at least one villa")
    if store.staff_by_phone(phone):
        raise HTTPException(409, "An operator with this number already exists")
    staff_id = store.add_staff(name, phone, "", body.presence)
    store.assign_staff(villa_ids, body.role, staff_id)
    store.audit(None, "operator_added", "tier0", {"staff_id": staff_id, "name": name, "role": body.role,
                                                  "villas": villa_ids, "presence": body.presence})
    return {"ok": True, "id": staff_id}


@app.post(f"{API}/operators/{{staff_id}}/presence", dependencies=[Depends(admin)])
async def ops_operator_presence(staff_id: int, body: Presence):
    staff = store.get_staff(staff_id)
    if not staff:
        raise HTTPException(404)
    if body.presence not in store.PRESENCE:
        raise HTTPException(400, "Presence must be onsite or offsite")
    store.set_presence(staff_id, body.presence)
    store.audit(None, "operator_presence", "tier0", {"staff_id": staff_id, "name": staff["name"], "presence": body.presence})
    return {"ok": True}


@app.post(f"{API}/operators/{{staff_id}}/message", dependencies=[Depends(admin)])
async def ops_message_operator(staff_id: int, body: OpsReply):
    """Ops writes to a field operator on WhatsApp (free text: only within 24 hours of their last message)."""
    staff = store.get_staff(staff_id)
    if not staff:
        raise HTTPException(404)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Write a message first")
    if not staff["phone"]:
        raise HTTPException(400, f"{staff['name']} has no WhatsApp number")
    try:
        await operators.send(staff, None, text, direction="ops")
    except whatsapp.WhatsAppError as e:
        if e.code == whatsapp.OUTSIDE_SERVICE_WINDOW:
            raise HTTPException(502, f"Not sent: {staff['name']} hasn't written in the last 24 hours, so WhatsApp "
                                     "only allows a template. Call them, or wait for them to reply to their task.") from e
        raise HTTPException(502, f"Not sent: {e}") from e
    store.audit(None, "operator_ops_message", "tier0", {"staff_id": staff_id, "text": text})
    return {"ok": True}


@app.post(f"{API}/tickets/{{ticket_id}}/assign", dependencies=[Depends(admin)])
async def ops_assign_ticket(ticket_id: int, body: Assign):
    """Give a ticket to another operator (or back to the control tower); the new operator is told on WhatsApp."""
    t = store.get_ticket(ticket_id)
    if not t:
        raise HTTPException(404)
    staff = store.get_staff(body.operator_id) if body.operator_id is not None else None
    if body.operator_id is not None and not staff:
        raise HTTPException(404, "No such operator")
    if staff and staff["id"] == t["operator_id"]:
        return {"ok": True, "assignee": t["assignee"]}
    assignee = operators.label({**staff, "role": operators.role_for(staff["id"], t["villa_id"])}) if staff \
        else "Ops control tower"
    t = store.assign_ticket(ticket_id, staff["id"] if staff else None, assignee)
    store.audit(t["booking_id"], "ticket_assigned", "tier0", {"ticket": t["ref"], "to": assignee})
    if staff and t["status"] != "closed":
        booking = store.get_booking(t["booking_id"]) or {"guest_name": "-", "booking_id": t["booking_id"], "check_in": "-"}
        await operators.notify_assignment(t, booking)
    return {"ok": True, "assignee": assignee}


@app.post(f"{API}/tickets/{{ticket_id}}/done", dependencies=[Depends(admin)])
async def ops_operator_done(ticket_id: int):
    """The field app's "Mark done": the ticket's operator finished the task."""
    t = store.get_ticket(ticket_id)
    if not t:
        raise HTTPException(404)
    staff = store.get_staff(t["operator_id"])
    if not staff:
        raise HTTPException(409, "Assign an operator first")
    if t["status"] == "closed":
        raise HTTPException(409, f"{t['ref']} is already closed")
    closed = await operators.mark_done(t, staff, "field app")
    return {"ok": True, "ref": closed["ref"], "minutes": operators.minutes_to_resolve(closed),
            "guest_messaged": closed["source"] in (None, "guest")}


@app.get("/ops/{name}", dependencies=[Depends(admin)])
async def ops_console_asset(name: str):
    if name not in OPS_CONSOLE_ASSETS:
        raise HTTPException(status_code=404)
    return FileResponse(OPS_CONSOLE_DIR / name)


@app.get("/health")
async def health():
    return {"service": "gia-whatsapp-demo", "ok": True}
