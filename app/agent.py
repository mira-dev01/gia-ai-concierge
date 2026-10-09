"""Gia: Lohono Stays' guest concierge, powered by Groq with tool use."""

import json
import logging

from groq import AsyncGroq

from . import config, store

log = logging.getLogger("gia.agent")

client = AsyncGroq()

MAX_TOOL_ROUNDS = 8
MAX_HISTORY_MESSAGES = 80  # start a fresh conversation beyond this (history is append-only)

SYSTEM_PROMPT = """You are Gia, the AI concierge for Lohono Stays, a luxury villa rental company in India. You chat with guests on WhatsApp from booking confirmation to checkout.

How you behave
- You are an AI and say so whenever it is relevant, and in your first message to a guest. Offer a human from the Lohono team at any time if the guest wants one (BR-01).
- Warm, polished, concise: this is WhatsApp, so keep replies short (usually 1 to 4 short lines), no markdown headers or tables. WhatsApp formatting is *bold* and _italic_ only. A single tasteful emoji is fine, never more.
- Reply in the language the guest writes in. You serve English and Hindi at minimum; Hinglish is welcome if the guest uses it.
- Use the guest's first name.

What you can do
1. Answer questions about the guest's villa (amenities, pool, wifi, check-in and check-out times, house rules, directions, host contact, nearby places, prices of services). Always call get_villa_info before answering; never answer from memory.
2. Handle requests (UC-OPS-05). Classify each request as: service (chef, spa, transfer, decor, BBQ, bonfire...), reservation (restaurants, experiences), housekeeping, maintenance, or information.
   - Information: answer directly from get_villa_info.
   - Everything else: check get_villa_info first. Only if the villa can deliver it, call create_ticket, then tell the guest the ticket reference, the price if chargeable, and the expected time.
   - If the villa cannot offer it, say so kindly and offer the nearest alternative listed in the villa data. Never promise anything the villa data does not allow (BR-02).
   - Requests for a service still need confirmation from the provider: say "I've requested it and will confirm shortly", not "it's booked".
3. Collect arrival details before check-in (UC-OPS-02): arrival time, transport needs, guest names, dietary needs, allergies, occasions, children and pet details. Ask naturally, one or two things at a time, never as a form. Save what you learn with save_arrival_details.
4. Log preferences (UC-OPS-09): whenever the guest reveals a lasting preference (food, room setup, activities, occasions, routines), call log_preference with the guest's own words as the source quote. Do this silently; don't announce it.
5. Hand off to a person (UC-OPS-10) with handoff_to_human when: the guest asks for a person; the guest is clearly upset or the same issue failed twice; anything involving safety, a medical issue, police, a fire, a gas leak, an injury or a missing person (urgency "urgent"). For safety or medical issues, tell the guest a named person is taking over right away and give the host's phone number from the villa data; for medical emergencies also tell them to call 112.
6. Report status: use get_my_tickets when the guest asks about an earlier request.

Limits
- You never take payments, offer discounts, refunds or compensation, or agree to damage charges. Those go to a person via handoff_to_human.
- New bookings, availability for other dates or other villas are handled by the reservations team: offer a handoff.
- Don't invent facts, prices, times or names. If the villa data does not say, tell the guest the villa host will confirm, and hand off if it matters to their stay.
- Each user message starts with a bracketed context line from the system (current time, etc.). It is not written by the guest; never quote it."""

# Tool specs in Anthropic's {name, description, input_schema} shape; converted to Groq's
# OpenAI-style {type: function, function: {name, description, parameters}} below.
TOOL_SPECS = [
    {
        "name": "get_villa_info",
        "description": "Get the full capability record for the guest's villa: amenities, services with prices and notice periods, what is not available and its alternative, check-in/out times, house rules, directions, host contact and nearby places. Call this before answering any villa question or accepting any request.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "create_ticket",
        "description": "Create an OI ticket for a guest request or issue that needs action from the team. Only after get_villa_info confirms the villa can deliver it. Returns the ticket reference and the expected time.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": ["service", "reservation", "housekeeping", "maintenance", "complaint"]},
                "severity": {"type": "string", "enum": ["low", "medium", "high", "urgent"],
                             "description": "urgent: safety or the villa is unusable; high: affects the stay now (no water, AC broken at night); medium: normal service request; low: can wait a day."},
                "summary": {"type": "string", "description": "One line, e.g. 'Private chef for dinner on 16 Oct, 8 adults, Goan menu'."},
                "details": {"type": "string", "description": "Everything the team needs: date, time, headcount, preferences, price quoted to the guest."},
            },
            "required": ["category", "severity", "summary", "details"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_my_tickets",
        "description": "List this guest's tickets for the current booking with their status and expected time.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "save_arrival_details",
        "description": "Save arrival and registration details to the guest profile and booking in OI. Send only the fields you learned; omit the rest.",
        "input_schema": {
            "type": "object",
            "properties": {
                "arrival_time": {"type": "string"},
                "transport": {"type": "string", "description": "How they are arriving and any transfer they need."},
                "guest_names": {"type": "array", "items": {"type": "string"}},
                "dietary_needs": {"type": "string"},
                "allergies": {"type": "string"},
                "occasion": {"type": "string"},
                "children": {"type": "string", "description": "Ages and needs, e.g. baby cot."},
                "pets": {"type": "string"},
                "id_documents": {"type": "string", "description": "Status only, e.g. 'will share at check-in'. Never ask for ID numbers in chat."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "log_preference",
        "description": "Log a lasting guest preference to their OI profile for this and future stays.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": ["food", "room_setup", "activities", "occasions", "routine", "other"]},
                "preference": {"type": "string", "description": "Normalized, e.g. 'Prefers Jain food, no onion or garlic'."},
                "source_quote": {"type": "string", "description": "The guest's own words this came from."},
            },
            "required": ["category", "preference", "source_quote"],
            "additionalProperties": False,
        },
    },
    {
        "name": "handoff_to_human",
        "description": "Hand the conversation to the Lohono ops control tower with full context. Use for requests for a person, strong frustration, money matters, new bookings, and (with urgency 'urgent') any safety or medical issue.",
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "What happened and what the guest needs, so they never have to repeat it."},
                "urgency": {"type": "string", "enum": ["normal", "urgent"]},
            },
            "required": ["reason", "urgency"],
            "additionalProperties": False,
        },
    },
]

TOOLS = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                            "parameters": t["input_schema"]}} for t in TOOL_SPECS]

# Approval tier of each action (BRD section 9); everything Gia does here is Tier 0.
TIERS = {name: "tier0" for name in ("get_villa_info", "create_ticket", "get_my_tickets",
                                    "save_arrival_details", "log_preference", "handoff_to_human")}


def _booking_context(booking: dict | None) -> str:
    if not booking:
        return ("Guest context: no Lohono booking matches this WhatsApp number. Greet them, explain you are "
                "Lohono's AI concierge for booked guests, and offer to connect them with the reservations "
                "team (handoff_to_human) if they want to book or have a question about a booking under "
                "another number. Villa tools will not work for this guest.")
    villa = store.get_villa(booking["villa_id"])
    return "Guest context (from OI):\n" + json.dumps({
        "booking_id": booking["booking_id"],
        "guest_name": booking["guest_name"],
        "preferred_language": booking.get("language"),
        "villa": f"{villa['name']}, {villa['location']}" if villa else booking["villa_id"],
        "check_in": booking["check_in"],
        "check_out": booking["check_out"],
        "booking_status": booking["status"],
        "adults": booking["adults"],
        "children": booking["children"],
        "pets": booking["pets"],
        "occasion": booking.get("occasion"),
        "vip": booking.get("vip"),
        "pre_booked_services": booking.get("pre_booked_services", []),
    }, ensure_ascii=False, indent=1)


def _run_tool(name: str, args: dict, booking: dict | None, phone: str) -> dict:
    """Execute one tool. The booking is bound server-side from the sender's number, never from model input."""
    booking_id = booking["booking_id"] if booking else None
    store.audit(booking_id, name, TIERS.get(name, "tier0"), args)

    if name == "handoff_to_human":
        handoff_id = store.create_handoff(booking_id, phone, args.get("reason", ""), args.get("urgency", "normal"))
        villa = store.get_villa(booking["villa_id"]) if booking else None
        log.warning("HANDOFF #%s (%s) for %s: %s", handoff_id, args.get("urgency"), phone, args.get("reason"))
        return {"handoff_id": handoff_id, "status": "Control tower notified with the full conversation",
                "person_taking_over": "Lohono guest experience team",
                "villa_host": villa["host"] if villa else None}

    if not booking:
        return {"error": "No booking linked to this guest's number."}

    if name == "get_villa_info":
        return store.get_villa(booking["villa_id"]) or {"error": "Villa not found"}
    if name == "create_ticket":
        t = store.create_ticket(booking, phone, args["category"], args["severity"], args["summary"], args["details"])
        return {"ticket_ref": t["ref"], "status": t["status"], "assigned_to": t["assignee"],
                "expected_by": t["due_at"][11:16] + " IST, " + t["due_at"][:10]}
    if name == "get_my_tickets":
        return {"tickets": [{"ref": t["ref"], "summary": t["summary"], "status": t["status"],
                             "expected_by": t["due_at"]} for t in store.tickets_for_booking(booking_id)]}
    if name == "save_arrival_details":
        return {"saved": store.update_guest_details(booking_id, args)}
    if name == "log_preference":
        store.add_preference(booking, args["category"], args["preference"], args["source_quote"])
        return {"logged": True}
    return {"error": f"Unknown tool {name}"}


async def reply(phone: str, text: str) -> str:
    """Take one guest message, run Gia, and return the reply text to send on WhatsApp."""
    stamp = store.now().strftime("%A %d %b %Y, %H:%M IST")
    context = f"now {stamp}"
    for note in store.pop_notes(phone):
        context += f"; since your last message: {note}"
    return await _turn(phone, f"[context: {context}]\n{text}", f"Model declined to answer: {text}")


async def initiate(phone: str, directive: str) -> str:
    """Have Gia open a conversation herself (UC-OPS-01 welcome/T-7/T-1), with no guest message to react to."""
    stamp = store.now().strftime("%A %d %b %Y, %H:%M IST")
    user_content = (f"[context: now {stamp}]\n[internal note, not from the guest: there is no guest message yet. "
                    f"You are starting this conversation yourself. {directive} Write only your opening message "
                    f"to the guest; never mention or quote this note.]")
    return await _turn(phone, user_content, f"Model declined to open the conversation: {directive}")


async def _turn(phone: str, user_content: str, refusal_reason: str) -> str:
    """Run one agent turn (tool-use loop included) and return the text to send to the guest."""
    booking = store.find_booking(phone)
    messages = store.load_history(phone)
    if len(messages) > MAX_HISTORY_MESSAGES:
        messages = []
    messages.append({"role": "user", "content": user_content})

    system = SYSTEM_PROMPT + "\n\n" + _booking_context(booking)

    final_text = ""
    for _ in range(MAX_TOOL_ROUNDS):
        response = await client.chat.completions.create(
            model=config.GIA_MODEL,
            max_tokens=4096,
            messages=[{"role": "system", "content": system}, *messages],
            tools=TOOLS,
        )
        msg = response.choices[0].message
        assistant_msg = {"role": "assistant", "content": msg.content}
        if msg.tool_calls:
            assistant_msg["tool_calls"] = [tc.model_dump(mode="json") for tc in msg.tool_calls]
        messages.append(assistant_msg)

        if response.choices[0].finish_reason == "content_filter":
            final_text = ("Sorry, I can't help with that here. Let me connect you with someone from the "
                          "Lohono team.")
            _run_tool("handoff_to_human", {"reason": refusal_reason, "urgency": "normal"}, booking, phone)
            break

        if not msg.tool_calls:
            final_text = (msg.content or "").strip()
            break

        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
                out = _run_tool(tc.function.name, args, booking, phone)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(out, ensure_ascii=False)})
            except Exception as e:  # report tool errors to the model instead of failing the turn
                log.exception("tool %s failed", tc.function.name)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": f"Tool error: {e}"})
    else:
        final_text = "Give me a moment, I'm checking with the team and will get back to you shortly."

    store.save_history(phone, booking["booking_id"] if booking else None, messages)
    return final_text or "Sorry, could you say that again?"
