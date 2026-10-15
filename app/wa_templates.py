"""WhatsApp message templates Gia uses for UC-OPS-01.

All six are approved in WhatsApp Manager (category Utility, language English "en"); the bodies and buttons
here are copied from the approved versions. The bodies are also used to log the exact text the guest received
against the booking, so if a template is edited in Meta, update it here too.
"""

from dataclasses import dataclass

from . import config, whatsapp


@dataclass(frozen=True)
class Template:
    name: str
    meta_id: str                     # the approved template's ID in WhatsApp Manager (sends go by name + language)
    body: str
    params: tuple[str, ...]          # what fills {{1}}, {{2}}... (documentation and a length check)
    buttons: tuple[str, ...] = ()    # quick replies; the guest's tap arrives as a normal message


WELCOME = Template(
    name="gia_welcome",
    meta_id="4399533433642339",
    body=("Hi {{1}}, your stay at {{2}} from {{3}} to {{4}} is confirmed.\n\n"
          "I'm Gia, Lohono Stays' AI concierge. I'll help coordinate your stay, from arrival plans to any services "
          "you'd like arranged.\n\n"
          "Message me here whenever you need assistance. If you'd prefer a person, just let me know and I'll connect "
          "you with our team."),
    params=("guest first name", "villa name", "check-in date", "check-out date"),
)

WELCOME_PRE_ARRIVAL = Template(  # booking made less than 7 days before arrival: T-7 merged into the welcome
    name="gia_welcome_pre_arrival",
    meta_id="2816989592083900",
    body=("Hi {{1}}, your stay at *{{2}}* from *{{3}}* to *{{4}}* is confirmed.\n\n"
          "I'm Gia, Lohono Stays' AI concierge. Let's get your stay ready. Please share:\n\n"
          "• Your *arrival time* and *travel plans*\n"
          "• Any *services* you'd like arranged, such as a chef or airport transfer\n"
          "• Dietary needs, allergies or special occasions\n\n"
          "I'll coordinate the next steps with our villa team. *Prefer a person? I'm happy to connect you.*"),
    params=("guest first name", "villa name", "check-in date", "check-out date"),
)

PRE_ARRIVAL = Template(  # T-7
    name="gia_pre_arrival",
    meta_id="4790204744540841",
    body=("Hi {{1}}, your stay at *{{2}}* begins on *{{3}}*.\n\n"
          "I'm preparing your arrival with the Lohono team. Could you share:\n\n"
          "• Your arrival time and travel plans\n"
          "• Any services you'd like arranged\n"
          "• Dietary needs, allergies or special occasions\n\n"
          "I'll coordinate your requests with the villa team and keep you updated. You can also ask to speak with a "
          "person anytime."),
    params=("guest first name", "villa name", "check-in date"),
    buttons=("Share my plans", "- Talk to a person"),
)

PRE_ARRIVAL_REMINDER = Template(  # no reply 24 hours after T-7
    name="gia_pre_arrival_reminder",
    meta_id="1082427721281525",
    body=("Hi {{1}}, your stay at *{{2}}* on *{{3}}* is coming up.\n\n"
          "I haven't received your arrival details yet. Share your expected arrival time and any services you'd "
          "like arranged, and I'll coordinate with our villa team.\n\n"
          "Need help from a person? Just let me know."),
    params=("guest first name", "villa name", "check-in date"),
)

ARRIVAL = Template(  # T-1
    name="gia_arrival_t1",
    meta_id="1629784595193276",
    body=("Hi {{1}}, we're looking forward to welcoming you to *{{2}}* tomorrow, *{{3}}*.\n\n"
          "Check-in: *{{4}}*\n"
          "Directions: *{{5}}*\n"
          "Map: *{{6}}*\n\n"
          "Villa contact: *{{7}} * · *{{8}}*\n\n"
          "Please confirm your *expected arrival time* and let me know *if you'd like anything prepared before you "
          "arrive*. I'll coordinate with the villa team.\n\n"
          "I'm Gia, your AI concierge. You can request a person anytime."),
    params=("guest first name", "villa name", "check-in date", "check-in time", "directions", "map link",
            "caretaker or host name", "caretaker or host phone"),
    buttons=("Confirm arrival time", "Talk to a person"),
)

STAFF_ALERT = Template(  # to the villa's caretaker and manager, e.g. no guest reply by T-1
    name="gia_staff_alert",
    meta_id="1124158853564904",
    body=("*Gia | Guest Operations Alert*\n\n"
          "Action required: *{{1}}*\n\n"
          "Villa: *{{2}}*\n"
          "Guest: *{{3}}*\n"
          "Booking: *{{4}}*\n"
          "Check-in: *{{5}}*\n"
          "OI Ticket: *{{6}}*\n\n"
          "Please contact the guest, resolve any outstanding arrival requirements and record the outcome in OI. "
          "Update the ticket once follow-up is complete."),
    params=("what happened", "villa name", "guest name", "booking ID", "check-in date", "ticket reference"),
)

ALL = (WELCOME, WELCOME_PRE_ARRIVAL, PRE_ARRIVAL, PRE_ARRIVAL_REMINDER, ARRIVAL, STAFF_ALERT)


def clean(values: list) -> list[str]:
    """Meta rejects template parameters that are empty or contain newlines, tabs or runs of spaces."""
    return [" ".join(str(v or "").split()) or "-" for v in values]


def render(template: Template, values: list[str]) -> str:
    if len(values) != len(template.params):
        raise ValueError(f"{template.name} takes {len(template.params)} parameters, got {len(values)}")
    text = template.body
    for i, v in enumerate(values, start=1):
        text = text.replace("{{%d}}" % i, v)
    return text


async def send(to: str, template: Template, values: list, language: str = "en") -> tuple[dict, str, str]:
    """Send a template. Returns (Meta's response, the text the guest sees, the template actually sent).

    Until WA_TEMPLATES_LIVE is on, Meta's hello_world goes out instead (test numbers accept only that),
    while the real text is still returned so it can be logged.
    """
    values = clean(values)
    text = render(template, values)
    if not config.WA_TEMPLATES_LIVE:
        return await whatsapp.send_template(to, "hello_world", "en_US"), text, "hello_world"
    lang = language if language in config.TEMPLATE_LANGS else "en"
    return await whatsapp.send_template(to, template.name, lang, values), text, template.name
