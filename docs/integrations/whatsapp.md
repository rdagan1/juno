# Integration: WhatsApp

`agent/whatsapp-channel/` lets you chat with Merlin over WhatsApp. It also delivers Merlin's own messages there: deadline pings, digest pointers and alerts. It replaces the companion app as your channel, so there's no Apple developer account, Supabase project or app build to deal with.

It connects as a **linked device**, the same way WhatsApp Web or Desktop does, using the open-source [Baileys](https://github.com/WhiskeySockets/Baileys) library.

> **Read this first.** Linked-device automation is **unofficial**. WhatsApp's terms don't allow it, and WhatsApp can ban the linked number. Personal-volume use (one person talking to their own assistant) rarely triggers anything, but nobody can guarantee that. Lower the risk:
> - **Use a spare number** for Merlin (a second SIM, eSIM, or a virtual number that can receive one SMS to register WhatsApp). Your main WhatsApp is then never at stake.
> - Never use it to message anyone but yourself. The channel enforces this: it only talks to `WHATSAPP_OWNER`, and it ignores groups and every other contact.

## Two ways to set it up

| | Dedicated number (recommended) | Self-chat |
|---|---|---|
| What you link | Merlin's spare WhatsApp account | **Your own** WhatsApp account |
| Where you chat | A normal chat with "Merlin" in your contact list | WhatsApp's **"Message yourself"** chat |
| Notifications | Yes, like any contact | WhatsApp doesn't notify you for messages in your own self-chat, so you'll miss proactive pings unless you open it |
| Ban risk | Only the spare number | Your main number |

The daemon detects the mode by itself: if the linked account's number equals `WHATSAPP_OWNER`, it's self-chat.

## Setup

1. **Install** (`scripts/bootstrap.sh` does this too):
   ```bash
   (cd agent/whatsapp-channel && npm install)
   ```

2. **Set your number** in `.env` as digits with the country code, no `+` (for an Israeli `050-123-4567` that's `972501234567`):
   ```
   WHATSAPP_OWNER=972501234567
   ```
   This is **your** number, the one Merlin should talk to. It's not the spare number.

3. **Link the device.** Run this on the host, with WhatsApp open on the phone that holds the account you're linking (the spare number, or yours for self-chat):
   ```bash
   node agent/whatsapp-channel/daemon.mjs --link
   ```
   Scan the QR code it prints: WhatsApp → **Settings → Linked devices → Link a device**.
   If you can't scan, for example over SSH, use a pairing code instead:
   ```bash
   node agent/whatsapp-channel/daemon.mjs --link --pair <number-being-linked>
   ```
   Then choose **"Link with phone number instead"** on the phone and type the 8-character code.
   It prints `Linked.` and exits. The session is saved in `data/whatsapp-auth/` (gitignored), so you only do this once.

4. **Restart Merlin** (process-manager). The `whatsapp-channel` daemon starts automatically whenever `WHATSAPP_OWNER` is set. Check it:
   ```bash
   curl -s 127.0.0.1:9097/health      # {"connected":true, "mode":"dedicated", ...}
   bin/whatsapp-send "hello from Merlin"
   ```

5. **Save Merlin as a contact** on your phone (dedicated mode) and message it.

## How it fits together

```
your phone ──WhatsApp──▶ whatsapp-channel daemon ──POST :9094/dispatch──▶ chat agent
                              ▲  (source "whatsapp")                        │
                              │                                            │ mcp__whatsapp__reply
                              └──────────── POST 127.0.0.1:9097/send ◀──────┘
                                                ▲
             bin/whatsapp-send (jobs, digests) ─┘   chat-supervisor safety net ─┘
                 bin/hum-ping (hum pings) ──────┘
```

- **One connection.** WhatsApp allows a single session per linked device, so only the daemon connects. The `whatsapp` MCP server (`agent/whatsapp-channel/mcp.mjs`) and `bin/whatsapp-send` are thin clients of its localhost API (`127.0.0.1:9097`, never exposed on the network).
- **Photos and files.** When you send a photo (say, of a homework question) or a PDF, it's saved to `data/whatsapp/media/` and the agent reads it. Voice notes aren't transcribed yet. The agent will ask you to type instead.
- **Formatting.** Markdown in replies is converted to WhatsApp style (`*bold*`, `_italic_`, `~strike~`). Long answers are split into several messages.
- **When Merlin is down.** If the chat agent can't be reached, the daemon replies "Merlin is offline right now", so you're not left waiting.
- **Proactive messages.** The study digest pointer, hum pings and alerts go through `bin/whatsapp-send` whenever `WHATSAPP_OWNER` is set. See the WhatsApp notes in `agent/ops-agent/CLAUDE.md` (long-form delivery rule) and `bin/hum-ping`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/health` shows `"lastError": "not linked …"` | Run step 3. |
| `"loggedOut": true` | The device was unlinked from the phone, or the number was banned. Credentials were cleared; re-link with step 3. |
| Messages to Merlin get no reply | Check `agent/logs/whatsapp-channel.log`. If there's no "inbound" line, the sender didn't match `WHATSAPP_OWNER` (check the digits and country code). |
| Merlin's replies don't notify you | You're in self-chat mode. Use a dedicated number. |
| Connection flaps after a WhatsApp update | Update Baileys: `(cd agent/whatsapp-channel && npm install baileys@latest)`, then restart. |

Logs: `agent/logs/whatsapp-channel.log`. Set `WHATSAPP_LOG_LEVEL=debug` for protocol detail.
