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

**http://localhost:8000/** is the **ops console** (same password; `/health` is the unauthenticated health check). Four areas, all on live data except Workflows; one sync loop refreshes the portfolio every 5 seconds, and whatever is open (a property, a conversation, a ticket, an operator) reloads its own detail on each sync:

- **Overview**: what needs a person now (guests waiting for a person, escalated, urgent, overdue, delayed or unassigned tickets, messages that didn't reach the guest, conflicting or unreadable bookings), the headline counts, **Live activity**, who's in conversation, guests in stay and arriving, and operators. Every item links straight to the property, conversation or ticket. Important events also pop up briefly on any screen.
- **Properties**: the portfolio as a searchable register (search by name, ID, location or villa manager; filter by stay status, arrival window, readiness blockers, location and manager; sort by next arrival, attention, overdue work or name). Search, filters, sorting and paging run on the server, so it works the same for 3 villas or 300. Opening a villa gives a three-column workspace: a property selector, the profile (current stay, next booking and what needs attention, then **Overview**, **Facilities** and **Team** tabs) and the guest's WhatsApp conversation with Gia. The conversation shows the current guest by default, or the next confirmed arrival; a past guest's conversation is only opened on purpose and is labelled as a past stay. **Take over** pauses Gia and holds scheduled UC-OPS-01 messages; ops replies go out on WhatsApp; on hand-back Gia is told what happened. Opening a conversation never changes who's handling it. Every message to the guest shows its delivery state (sent, delivered, read, **not delivered**, or *not sent · dry run*). This replaces the old Guest Journeys screen.
- **Operations**: the ticket queue, with counts for Open, Overdue, Unassigned, Escalated and Resolved, search, and filters for property, priority, assignee, status and category. Selecting a ticket opens its detail beside the queue (a drawer on narrow screens): the guest's request and what they wrote, assignment, progress against its SLA, activity, and only the actions valid for its state. The lifecycle is open → acknowledged → in progress → resolved, with delayed; the guest is messaged at each change. **Escalated** and **overdue** are flags beside the status, so a ticket can be in progress, overdue and escalated at once. Resolving needs a short note on how it was resolved; a resolved ticket can be reopened. New tickets go to the villa's operator for that kind of work, onsite first, and Gia sends them the task on WhatsApp. An operator's WhatsApp thread opens in a drawer (from the ticket or the property's Team tab): ops can message them, switch them onsite/offsite and tap **Mark done** as the field app would. Operators can reply **DONE** (or **DONE OI-00012** with several open), **ONSITE** or **OFFSITE**. **+ Add operator** adds one with their WhatsApp number, role, villas and presence.

How the console decides things (all in `app/portfolio.py`, so every screen agrees):

- **Booking status**: `confirmed` and `in_stay` are confirmed stays; `checked_out`, `cancelled` and `tentative`/`pending`-style statuses are shown as such; anything else is shown as *status not recognised* and never counted as a stay.
- **Stay status** comes only from confirmed bookings: occupied, checkout today, turnover today (one out, one in), pre-arrival (arriving today, or within 7 days), vacant, booking conflict (overlapping confirmed stays) or unknown (an unrecognised booking covers today). On arrival day a guest counts as arriving until OI marks them `in_stay`.
- **Readiness** is never shown as ready, because no turnover checklist is tracked yet: a villa is *blocked* by an open maintenance or housekeeping ticket, otherwise *not assessed*.

Items tagged **Demo** are two scripted scenarios kept for walkthroughs (an anniversary request, and a basin leak whose repair photos are checked before the ticket closes); photo evidence and the Workflow explorer exist only there for now. "Reset demo scenarios" restarts them without touching live data. An operator's number that is also a guest's booking number is treated as the guest.

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
app/portfolio.py  The console's shared rules: booking status, occupancy, readiness, what needs attention
app/ops_view.py   Live data for the ops console: the portfolio snapshot it polls, and a conversation, ticket or operator on demand
app/property_view.py  The Properties register (server-side search, filters, sort, paging) and one property's profile
app/operators.py  Field operators: routing tickets, telling them on WhatsApp, their DONE / ONSITE / OFFSITE replies
app/static/ops/   Ops console (React + htm from a CDN, no build step): console.js (shell, Overview, Workflows), properties.js,
                  conversation.js, operations.js, ui.js (shared pieces), live.js (API and formatting), data.js (demo scenarios)
scripts/chat.py   Terminal chat for testing without WhatsApp
```

## Notes for going beyond the demo

- Model: `llama-3.3-70b-versatile` on Groq for fast WhatsApp replies (`GIA_MODEL` in `.env`).
- WhatsApp only allows free-form messages within 24 hours of the guest's last message. UC-OPS-01 uses templates outside that window; ticket status updates (UC-OPS-05) still need their own template.
- Database: set `DATABASE_URL` to a Postgres connection string (for example Neon's pooled one) and the app uses Postgres, creating its tables on first start. Without it, it uses a SQLite file at `DB_PATH` (default `gia.db`), which on Railway needs a volume (for example `DB_PATH=/data/gia.db`) or every redeploy starts empty. The checks always use a throwaway database; set `TEST_DATABASE_URL` to run them against an empty Postgres database instead.
- On Railway, set the health check path to `/health` (`/` is the password-protected console). The console is served by the backend itself at the Railway URL.
- To serve the console from Vercel instead, make a Vercel project with root directory `app/static/ops` (framework preset Other, no build command), and set the Railway URL in `app/static/ops/vercel.json`: Vercel forwards `/api/*` to Railway, so the browser sees one site and the same password applies.
- Not built yet: photo evidence and vision checks, automatic SLA breach escalation, a turnover/readiness checklist, bathroom counts and other facilities not in the villa record, manual ticket creation, trip scoring, voice notes.
- Access: the console has one shared admin password, so everyone who signs in sees the whole portfolio. Limiting villa managers and service operators to their own villas needs per-user accounts, which this demo doesn't have; every console API checks the password on the server.

## UC-OPS-01 Initiate concierge chat

**Trigger.** OI calls `POST /oi/events/booking` with header `X-OI-Secret` and a body like
`{"event": "confirmed", "booking": {"booking_id": "LH-30001", "guest_name": "Zara Khan", "guest_phone": "919800000009", "villa_id": "LNV-TGR-03", "check_in": "2026-11-20", "check_out": "2026-11-22", "language": "en"}}`.
`modified` (new dates) moves the steps that haven't gone out; `cancelled` cancels them. The console has a form that sends the same events, and the sample bookings count as confirmed the first time the service starts.

**Steps.** Each booking gets a row per step (`journey_steps`): welcome, T-7, T-7 reminder (only after T-7 goes unanswered) and T-1. Status: scheduled → sent → delivered → read (from WhatsApp delivery receipts), or failed / skipped / cancelled, with the reason in the note. A step is marked sent before it's sent, so overlapping runs can't send it twice. A failed send is retried once after 15 minutes; a second failure raises a ticket for the control tower.

**Template or free text.** If the guest has written in the last 24 hours, Gia writes the step's message herself; otherwise the approved template goes out (`app/wa_templates.py`). Once the guest replies, Gia carries the conversation in free text: arrival details, services (as tickets) and preferences.

**Per-villa settings** (console → Villas & staff, for one villa or a filtered group with checkboxes): on/off, T-7 and T-1 offsets, send window, reminder on/off and delay, no-reply flag on/off. Caretakers and managers are assigned the same way. The caretaker is the contact Gia gives guests at T-1, and caretaker and manager get the no-reply ticket by email (cc) and WhatsApp.

**Mock OI tickets.** `app/tickets.py` saves every ticket and handoff and emails it, with the booking and the recent conversation, to `TICKET_EMAIL_TO` (one address, or several separated by commas) through [Resend](https://resend.com). Set `RESEND_API_KEY` and `RESEND_FROM` (an address on a domain verified in Resend) in `.env`; without a key, emails are logged in the console instead of sent. Emails go through an outbox, so a failed send is retried. Replace `raise_ticket` and `raise_handoff` with OI's endpoint when it's ready.

**Automated check.** `python -m tests.uc_ops_01_check` runs every UC-OPS-01 rule against a frozen clock and a throwaway database, with WhatsApp faked and Resend mocked, so nothing is sent. `python -m tests.properties_check` checks the Properties workspace and the portfolio rules behind it (occupancy, booking status, readiness, attention), escalation, resolution notes, message delivery states, and a 320-villa register. `python -m tests.ops_console_check` does the same for the ops console's API: ticket status changes, takeover and hand-back, ops replies (including outside WhatsApp's 24-hour window), handoff resolution, and field operators (routing, onsite first, WhatsApp commands, field-app done, time to resolve, reassignment).

**Templates to submit to Meta** (category Utility, English): `gia_welcome`, `gia_welcome_pre_arrival`, `gia_pre_arrival`, `gia_pre_arrival_reminder`, `gia_arrival_t1`, `gia_staff_alert`, with the exact bodies and buttons in `app/wa_templates.py`. Set `WA_TEMPLATES_LIVE=true` once they're approved; until then `hello_world` goes out and the real text is logged.
