# Gia on WhatsApp: Lohono Stays concierge demo

Gia is Lohono's AI guest concierge from the *AI-Native Guest Operations BRD*. This demo is the first use case: a guest chats with Gia on WhatsApp and Gia answers villa questions, turns requests into tracked tickets, and keeps the guest updated.

| BRD item | What the demo does |
|---|---|
| UC-OPS-05 Handle a guest request | Classifies each message; answers information from the villa capability data; creates an OI-style ticket for service, reservation, housekeeping and maintenance requests, with an SLA time |
| UC-OPS-05 step 5 | Changing a ticket's status in the ops console messages the guest on WhatsApp automatically |
| UC-OPS-01 Initiate concierge chat | "Send welcome" in the ops console sends the welcome template to a booking's guest |
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

**1. Try Gia in the terminal first** (only `ANTHROPIC_API_KEY` needed):

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

- Model: `claude-opus-5-5` at `low` effort for fast WhatsApp replies (`GIA_MODEL`, `GIA_EFFORT` in `.env`). Server-side refusal fallbacks are on.
- WhatsApp only allows free-form messages within 24 hours of the guest's last message. Outside that window (T-7, T-1 and late ticket updates) you need approved templates.
- Not built yet: T-7/T-1 scheduling from OI events, photo evidence and vision checks, SLA breach escalation, trip scoring, voice notes.
