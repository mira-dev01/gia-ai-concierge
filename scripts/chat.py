"""Chat with Gia in the terminal, no WhatsApp needed.

    python -m scripts.chat               # as the in-stay guest (LH-24009)
    python -m scripts.chat 919800000001  # as another sample guest's number
"""

import asyncio
import sys

from app import agent, store


async def main() -> None:
    store.init()
    phone = sys.argv[1] if len(sys.argv) > 1 else "919800000002"
    b = store.find_booking(phone)
    print(f"Chatting as {b['guest_name'] + ' / ' + b['booking_id'] if b else 'an unknown number'}. Ctrl+C to quit.\n")
    while True:
        text = input("guest> ").strip()
        if text:
            print("gia>  " + (await agent.reply(phone, text)).replace("\n", "\n      ") + "\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, EOFError):
        pass
