"""WhatsApp message templates Gia uses for UC-OPS-01.

Submit each one in WhatsApp Manager exactly as written here: category Utility, language English ("en"),
body text with the {{n}} placeholders, and the quick-reply buttons listed. The bodies are also used to log
the exact text the guest received against the booking, so keep this file and Meta in step.
"""

from dataclasses import dataclass

from . import config, whatsapp


@dataclass(frozen=True)
class Template:
    name: str
    body: str
    params: tuple[str, ...]          # what fills {{1}}, {{2}}... (documentation and a length check)
    buttons: tuple[str, ...] = ()    # quick replies; the guest's tap arrives as a normal message


WELCOME = Template(
    name="gia_welcome",
    body=("Hi {{1}}, your stay at {{2}} from {{3}} to {{4}} is confirmed.\n\n"
          "I'm Gia, Lohono Stays' AI concierge. I'll help you plan your stay and look after you while you're "
          "there. Message me here any time, and if you'd rather speak to a person from our team, just say so."),
    params=("guest first name", "villa name", "check-in date", "check-out date"),
)

WELCOME_PRE_ARRIVAL = Template(  # booking made less than 7 days before arrival: T-7 merged into the welcome
    name="gia_welcome_pre_arrival",
    body=("Hi {{1}}, your stay at {{2}} from {{3}} to {{4}} is confirmed.\n\n"
          "I'm Gia, Lohono Stays' AI concierge. As your stay is coming up soon, could you tell me:\n"
          "• your arrival time and how you're travelling\n"
          "• anything you'd like arranged, such as a chef or an airport transfer\n"
          "• any dietary needs, allergies or special occasions\n\n"
          "A person from our team is always available if you'd prefer."),
    params=("guest first name", "villa name", "check-in date", "check-out date"),
    buttons=("Share my plans", "Talk to a person"),
)

PRE_ARRIVAL = Template(  # T-7
    name="gia_pre_arrival",
    body=("Hi {{1}}, your stay at {{2}} begins on {{3}}. To get everything ready, could you tell me:\n"
          "• your arrival time and how you're travelling\n"
          "• anything you'd like arranged, such as a chef or an airport transfer\n"
          "• any dietary needs, allergies or special occasions"),
    params=("guest first name", "villa name", "check-in date"),
    buttons=("Share my plans", "Talk to a person"),
)

PRE_ARRIVAL_REMINDER = Template(  # no reply 24 hours after T-7
    name="gia_pre_arrival_reminder",
    body=("Hi {{1}}, just following up about your stay at {{2}} on {{3}}. Whenever you have a moment, reply "
          "with your arrival time and anything you'd like us to arrange, and I'll take care of it."),
    params=("guest first name", "villa name", "check-in date"),
    buttons=("Share my plans",),
)

ARRIVAL = Template(  # T-1
    name="gia_arrival_t1",
    body=("Hi {{1}}, we look forward to welcoming you at {{2}} on {{3}}. Check-in is from {{4}}.\n\n"
          "Directions: {{5}}\n"
          "Map: {{6}}\n"
          "Your contact at the villa: {{7}}, {{8}}\n\n"
          "Could you confirm your arrival time, and let me know if there's anything you'd like ready when you "
          "arrive?"),
    params=("guest first name", "villa name", "check-in date", "check-in time", "directions", "map link",
            "caretaker or host name", "caretaker or host phone"),
    buttons=("Confirm arrival time", "Talk to a person"),
)

STAFF_ALERT = Template(  # to the villa's caretaker and manager, e.g. no guest reply by T-1
    name="gia_staff_alert",
    body=("Gia alert: {{1}}\n\n"
          "Villa: {{2}}\n"
          "Guest: {{3}}, booking {{4}}, check-in {{5}}\n"
          "Ticket: {{6}}\n\n"
          "The details are with the Lohono ops team. Please follow up and update the ticket."),
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
