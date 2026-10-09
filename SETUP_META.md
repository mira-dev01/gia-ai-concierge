# Connect Gia to your Meta developer account

This wires the demo to the WhatsApp Business Cloud API through your existing Meta app. Every value goes into `.env` on your machine; none of it needs to be shared anywhere else.

Menu names below are as of 2026 and Meta moves them occasionally; the field names stay the same.

## 1. Add WhatsApp to your app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and open your app. It must be a **Business** type app.
2. If WhatsApp isn't in the left menu, click **Add product** and set up **WhatsApp**. Pick (or create) the Meta Business portfolio it should belong to. Meta creates a WhatsApp Business Account and a free **test phone number**.

## 2. Copy the IDs and a token into `.env`

Open **WhatsApp > API Setup**:

| Field on the page | `.env` variable |
|---|---|
| Temporary access token (click *Generate*) | `WHATSAPP_TOKEN` |
| Phone number ID (under the "From" number; not the number itself) | `WHATSAPP_PHONE_NUMBER_ID` |

Then from **App settings > Basic**, click *Show* on **App secret** and put it in `META_APP_SECRET`. The service uses it to reject webhook calls that don't come from Meta.

Make up any long random string for `WHATSAPP_VERIFY_TOKEN` (for example the output of `python -c "import secrets; print(secrets.token_urlsafe(24))"`). You'll paste the same string into Meta in step 4.

Also set `GROQ_API_KEY` and `ADMIN_PASSWORD`.

## 3. Add your phone as a test recipient

Still on **API Setup**, in the **To** field choose *Manage phone number list* and add the phones you'll demo from (up to 5). Each gets a WhatsApp code to confirm. The test number can only message these numbers.

## 4. Give Meta a public URL for the webhook

Start the service, then expose it with a tunnel:

```bash
uvicorn app.main:app --port 8000
# in a second terminal, either:
cloudflared tunnel --url http://localhost:8000      # free, no account needed
ngrok http 8000                                     # needs a free ngrok account
```

Copy the `https://...` URL it prints. Then in Meta, open **WhatsApp > Configuration**:

1. Under **Webhook**, click **Edit**.
2. **Callback URL**: `https://<your-tunnel-host>/webhook`
3. **Verify token**: the same `WHATSAPP_VERIFY_TOKEN` value from `.env`.
4. Click **Verify and save**. Meta calls `GET /webhook`; you should see a `200` in the uvicorn log.
5. Under **Webhook fields**, click **Manage** and **Subscribe** to `messages`.

Quick tunnels change URL every time they restart, so repeat this step if you restart the tunnel.

## 5. Say hi

From your phone, send "Hi" to the test number. Gia should reply within a few seconds, and the message shows up at `http://localhost:8000/admin`.

If nothing comes back, check in this order:

| Symptom | Likely cause |
|---|---|
| No `POST /webhook` in the uvicorn log | `messages` field not subscribed, or the tunnel URL changed |
| `401` on `POST /webhook` | `META_APP_SECRET` is wrong |
| `POST /webhook` 200 but no reply, and a `WhatsApp API error 401` in the log | Token expired (temporary tokens last about 24 hours) |
| `WhatsApp API error` with code `131030` | Your phone isn't in the recipient list (step 3) |
| `WhatsApp API error` with code `131047` | More than 24 hours since the guest's last message; send a template instead |

## 6. Before demo day: a token that doesn't expire

The temporary token dies after about 24 hours. For the demo, create a permanent one:

1. Go to [business.facebook.com](https://business.facebook.com) > **Settings > Users > System users**, and add a system user with the **Admin** role.
2. **Assign assets**: give it your app (full control) and your WhatsApp account (full control).
3. **Generate token** for your app with the permissions `whatsapp_business_messaging` and `whatsapp_business_management`, expiry **Never**.
4. Replace `WHATSAPP_TOKEN` in `.env` and restart the service.

## 7. Optional: the real welcome message (UC-OPS-01)

"Send welcome" in the console uses Meta's built-in `hello_world` template until you make your own:

1. **WhatsApp Manager > Message templates > Create template**, category **Utility**, name `gia_welcome`, language English.
2. Body, for example: *Hi {{1}}, I'm Gia, Lohono Stays' AI concierge for your upcoming stay. Message me here any time for villa details, chefs, transfers or anything else. A person from our team is always a message away.*
3. Once it's approved, set `WELCOME_TEMPLATE=gia_welcome` and `WELCOME_TEMPLATE_LANG=en` in `.env`. The guest's first name fills `{{1}}`.

## 8. Optional: Lohono's own number and name

The test number shows as "Test Number". To show "Lohono Stays" to guests you'd add a real phone number under **WhatsApp > API Setup > Add phone number**, set the display name (Meta reviews it), and complete business verification for the portfolio. That's a step for Lohono's own account, not needed for the demo.

## 9. Optional: a stable URL instead of a tunnel

For a demo that runs while your laptop is closed, deploy the service to any host that runs Python (Render, Railway, Fly.io, a small VM), set the same environment variables there, and point the Meta callback URL at it. Note that the SQLite file resets on most free hosts when they redeploy.
