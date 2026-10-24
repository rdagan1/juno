# Integration: Google Calendar, Tasks, Contacts

Merlin reaches your Google account by two routes, and you need both.

| Who | Route | What it covers |
|---|---|---|
| **The agents** (chat + ops) reading and writing your calendar | The **Google Calendar connector** on your Claude account, exposed as `mcp__claude_ai_Google_Calendar__*` | Reading events, creating/moving/deleting events, free/busy |
| **Everything else**: hum harvesters, the hum busy gate, the watchdog, and the agents' Tasks/Contacts tools | **Your own OAuth token** in `.env`, used by `lib/google-api.mjs` (CLI: `bin/google`, tools: `tasks_*` / `contacts_*` in `mcp__tools__`) | Calendar (read-only), Google Tasks (read/write), Contacts (read-only) |

The connector can only be called from inside a Claude session. Cron scripts and harvesters run outside one, so they need their own token. Tasks and Contacts aren't covered by the connector at all.

## 1. Calendar connector (for the agents)

1. On claude.ai, go to **Settings → Connectors** and connect **Google Calendar**. Use the Claude account the `claude` CLI on the Merlin host is signed in with.
2. Restart the supervisors.
3. Ask Merlin "what's on my calendar today?" to check it works.

No Google credentials are stored on the host for this route.

## 2. OAuth token (for scripts and Tasks/Contacts)

### Create an OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project. The Gmail project from [`gmail.md`](gmail.md) works.
2. **APIs & Services → Library**: enable **Google Calendar API**, **Google Tasks API** and **People API**.
3. **APIs & Services → OAuth consent screen**: type *External*, add your own Google address as a **test user**. Add these scopes:
   - `.../auth/calendar.readonly`
   - `.../auth/tasks`
   - `.../auth/contacts.readonly`
4. **Credentials → Create credentials → OAuth client ID**, application type **Desktop app**. Note the client ID and secret.

### Mint the refresh token

On the Merlin host (it needs a browser that can reach `127.0.0.1`):

```bash
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... bin/google auth
```

Open the printed URL, sign in as yourself, approve. The command prints three lines; add them to `.env`:

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REFRESH_TOKEN=...
# GOOGLE_CALENDAR_ID=primary   # optional; calendar the harvesters read
```

If the host is headless, run `bin/google auth` on any machine with a browser and copy the three lines over.

### Verify

```bash
bin/google check                      # {"ok": true}
bin/google calendar list --days 1     # today's events as JSON
bin/google tasks list                 # open tasks in your default list
bin/google contacts search alice
```

Then restart the supervisors so `tools-mcp` picks up the token.

### Token lifetime

While the consent screen is in **Testing**, Google expires refresh tokens after **7 days**. For a token that lasts, set the app to **In production** on the consent screen. You'll get an "unverified app" warning when you approve; that's fine for an app only you use.

A token is also revoked when you change your Google password or remove the app's access. The watchdog runs `bin/google check` and pings you (at most once a day) when the token is rejected. Fix it by rerunning `bin/google auth` and replacing `GOOGLE_OAUTH_REFRESH_TOKEN`.

## What uses what

| Piece | Uses |
|---|---|
| Morning digest: calendar section | Connector |
| Morning digest: tasks section | `tasks_list` tool |
| Study digest: free blocks for tomorrow | Connector |
| "Block it" / any event create or update | Connector (through the `calendar-scheduling` skill; no attendees unless you ask) |
| Email triage P1 tasks, lecture-recording deadline tasks | `tasks_add` tool |
| Contact lookups | `contacts_search` tool |
| Hum `calendar` harvester (conflicts, events starting soon) | `lib/google-api.mjs` |
| Hum `tasks` harvester (overdue / due today) | `lib/google-api.mjs` |
| Hum busy gate (`trigger-hum.sh`: no pings during a meeting) | `bin/google calendar busy-now` |
| Watchdog auth check | `bin/google check` |

Without the OAuth token, the harvesters emit nothing, the busy gate lets hum through, and the `tasks_*` / `contacts_*` tools return an error saying Google isn't configured. Nothing else breaks.

## Safety

- Calendar access through the token is **read-only**. Only the agents write events, through the connector, under the no-attendees rule in `agent/CLAUDE.md`.
- Contacts are read-only. Tasks are read/write so Merlin can file deadlines.
- The token lives in `.env`, which is gitignored.
