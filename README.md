# Gia on WhatsApp: Lohono Stays concierge demo

Gia is Lohono's AI guest concierge from the *AI-Native Guest Operations BRD*. This demo is the first use case: a guest chats with Gia on WhatsApp and Gia answers villa questions, turns requests into tracked tickets, and keeps the guest updated.

| BRD item | What the demo does |
|---|---|
| UC-OPS-05 Handle a guest request | Classifies each message; answers information from the villa capability data; creates an OI-style ticket for service, reservation, housekeeping and maintenance requests, with an SLA time |
| UC-OPS-05 step 5 | Changing a ticket's status in the ops console messages the guest on WhatsApp automatically |
| UC-OPS-01 Initiate concierge chat | Welcome on booking confirmation, T-7 and T-1 before check-in, inside each villa's send window. Late bookings get T-7 merged into the welcome; no reply in 24 h gets one reminder; no reply by T-1 (given at least the reminder delay, 24 h by default, to answer) raises a ticket for the control tower and the villa's caretaker and manager. Every message is logged against the booking with its delivery status. Each booking has its own page in the console with the journey, every message and its tickets. See [UC-OPS-01 in detail](#uc-ops-01-initiate-concierge-chat) |
| UC-OPS-02 Arrival details | Gia collects arrival time, transport, dietary needs, allergies, occasions, kids and pets, conversationally |
| UC-OPS-09 Preferences | Lasting preferences are logged with the guest's own words as the source |
| UC-OPS-10 Human takeover | Requests for a person, money matters, frustration, and any safety or medical issue go to the control tower list (urgent ones flagged) |
| BR-01, BR-02 | Gia says it is AI and offers a human; it never promises anything the villa data doesn't allow and offers the listed alternative instead |
| NFR-03, NFR-04, NFR-08 | Replies in English or Hindi; every action is in an audit log with its tier; if Gia errors, the chat goes to a human |

OI (Lohono's CRM) is simulated with a local SQLite file, and villas and bookings are **sample data** in `app/data/`. Swapping in OI's real APIs means replacing the functions in `app/store.py`.

## Run it

Needs Python 3.10+.

```bash
cd gia-whatsapp-demo
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill it in on your machine; never paste keys into chat
```

**1. Try Gia in the terminal first** (only `GROQ_API_KEY` needed):

```bash
python -m scripts.chat                 # as Priya, in-stay at Casa Alba, Alibaug
python -m scripts.chat 919800000001    # as Aarav, arriving at Villa Serena, Goa
```

**2. Run the webhook service:**

```bash
uvicorn app.main:app --port 8000
```

Open http://localhost:8000/admin (any username, password = `ADMIN_PASSWORD`). The console shows handoffs, tickets with status buttons, the live conversation, captured preferences, arrival details and the audit log. "Try Gia without WhatsApp" lets you chat from the browser too.

**3. Connect it to your Meta app:** follow [SETUP_META.md](SETUP_META.md).

## Demo script (about 5 minutes)

Use your own phone as the guest (with `DEMO_BOOKING_ID=LH-24009`, you're Priya, in-stay at Casa Alba). Keep the ops console open on a laptop beside it.

1. **"Hi"**. Gia introduces itself as Lohono's AI concierge, by first name.
2. **"What's the wifi like, and what time is checkout?"** Answered from villa data, no ticket.
3. **"Can we get a private chef for dinner tomorrow? We love seafood, 6 of us"**. Gia checks the villa, quotes the price, creates a ticket. The ticket appears in the console, and a seafood preference is logged.
4. **"Can we get a spa massage at the villa?"** Casa Alba has no in-villa spa: Gia says so and offers the partner spa in town (BR-02).
5. In the console, click **acknowledged**, then **closed** on the chef ticket. The guest gets each update on WhatsApp without asking.
6. **"AC in the master bedroom is not cooling"** (or in Hindi: *"मास्टर बेडरूम का AC ठंडा नहीं कर रहा"*). Maintenance ticket with high severity, replied in the guest's language.
7. **"My son fell near the pool and is bleeding"**. Urgent handoff: Gia gives the host's number and 112, and the console shows an urgent control-tower item.
8. Show **Preferences** and the **Audit log**: every action with time and tier.

"Reset chat" on a booking clears Gia's memory of that conversation so you can rehearse again.

## Layout

```
app/main.py       Meta webhook (verify + receive), ops console, status-update push
app/agent.py      Gia: system prompt, tools, Claude tool-use loop
app/whatsapp.py   WhatsApp Cloud API client and webhook signature check
app/store.py      SQLite stand-in for OI (tickets, preferences, handoffs, audit)
app/data/         Sample villas (capability database) and bookings
scripts/chat.py   Terminal chat for testing without WhatsApp
```

## Notes for going beyond the demo

- Model: `llama-3.3-70b-versatile` on Groq for fast WhatsApp replies (`GIA_MODEL` in `.env`).
- WhatsApp only allows free-form messages within 24 hours of the guest's last message. UC-OPS-01 uses templates outside that window; ticket status updates (UC-OPS-05) still need their own template.
- On Railway, put `DB_PATH` on a volume (for example `/data/gia.db`); otherwise every redeploy starts a fresh database and the sample bookings get their welcome again.
- Not built yet: photo evidence and vision checks, SLA breach escalation, trip scoring, voice notes.

## UC-OPS-01 Initiate concierge chat

**Trigger.** OI calls `POST /oi/events/booking` with header `X-OI-Secret` and a body like
`{"event": "confirmed", "booking": {"booking_id": "LH-30001", "guest_name": "Zara Khan", "guest_phone": "919800000009", "villa_id": "LNV-TGR-03", "check_in": "2026-11-20", "check_out": "2026-11-22", "language": "en"}}`.
`modified` (new dates) moves the steps that haven't gone out; `cancelled` cancels them. The console has a form that sends the same events, and the sample bookings count as confirmed the first time the service starts.

**Steps.** Each booking gets a row per step (`journey_steps`): welcome, T-7, T-7 reminder (only after T-7 goes unanswered) and T-1. Status: scheduled → sent → delivered → read (from WhatsApp delivery receipts), or failed / skipped / cancelled, with the reason in the note. A step is marked sent before it's sent, so overlapping runs can't send it twice. A failed send is retried once after 15 minutes; a second failure raises a ticket for the control tower.

**Template or free text.** If the guest has written in the last 24 hours, Gia writes the step's message herself; otherwise the approved template goes out (`app/wa_templates.py`). Once the guest replies, Gia carries the conversation in free text: arrival details, services (as tickets) and preferences.

**Per-villa settings** (console → Villas & staff, for one villa or a filtered group with checkboxes): on/off, T-7 and T-1 offsets, send window, reminder on/off and delay, no-reply flag on/off. Caretakers and managers are assigned the same way. The caretaker is the contact Gia gives guests at T-1, and caretaker and manager get the no-reply ticket by email (cc) and WhatsApp.

**Mock OI tickets.** `app/tickets.py` saves every ticket and handoff and emails it, with the booking and the recent conversation, to `TICKET_EMAIL_TO` (one address, or several separated by commas) through [Resend](https://resend.com). Set `RESEND_API_KEY` and `RESEND_FROM` (an address on a domain verified in Resend) in `.env`; without a key, emails are logged in the console instead of sent. Emails go through an outbox, so a failed send is retried. Replace `raise_ticket` and `raise_handoff` with OI's endpoint when it's ready.

**Automated check.** `python -m tests.uc_ops_01_check` runs every UC-OPS-01 rule against a frozen clock and a throwaway database, with WhatsApp faked and Resend mocked, so nothing is sent.

**Templates to submit to Meta** (category Utility, English): `gia_welcome`, `gia_welcome_pre_arrival`, `gia_pre_arrival`, `gia_pre_arrival_reminder`, `gia_arrival_t1`, `gia_staff_alert`, with the exact bodies and buttons in `app/wa_templates.py`. Set `WA_TEMPLATES_LIVE=true` once they're approved; until then `hello_world` goes out and the real text is logged.
