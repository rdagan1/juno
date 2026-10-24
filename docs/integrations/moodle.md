# Integration: Moodle

`agent/moodle-mcp/` is a **read-only** MCP server that gives both agents access to your Moodle: enrolled courses, course materials (slides, PDFs, pages), deadlines, assignments and their submission status, quizzes, grades, and course announcements.

It talks to Moodle's Web Services REST API, the same API the official Moodle mobile app uses. Most university Moodles have that enabled for students, so you usually don't need anything from the site admins.

## 1. Get a token

The server authenticates with a web-service token. Which route works depends on how you log in to Moodle.

**A. You log in with a Moodle username + password** (a form on the Moodle site itself):

```bash
bin/moodle-token login https://moodle.example.edu your-username
# prompts for the password, prints the token
```

**B. Your university uses SSO** (you get redirected to a Microsoft/Google/Shibboleth page). Password exchange won't work here. Use the mobile-app launch flow instead:

```bash
bin/moodle-token sso https://moodle.example.edu
# prints a launch.php URL
```

1. Open that URL in a desktop browser with DevTools → **Network** open (tick "Preserve log").
2. Log in as usual. The browser ends on a failed `moodlemobile://token=…` redirect.
3. Copy that URL from the Network tab, then run `bin/moodle-token decode 'moodlemobile://token=…'`. It prints the token.

**C. Some sites show it directly:** Moodle → your profile menu → **Preferences → Security keys**. If a "Moodle mobile web service" key is listed, use that.

If every route fails with "web services disabled" or "mobile app not enabled", the site has turned off the API. Ask the IT helpdesk whether students can use the Moodle mobile app.

## 2. Configure `.env`

```
MOODLE_URL=https://moodle.example.edu
MOODLE_TOKEN=<token from step 1>
MOODLE_TIMEZONE=Asia/Jerusalem        # optional, IANA zone for rendered dates
```

If you went with option A, you can set `MOODLE_USERNAME` + `MOODLE_PASSWORD` instead of `MOODLE_TOKEN`. The server then exchanges them for a token at startup. A stored token is the better choice, because it keeps your password out of `.env`.

Tokens usually last months, but they can be revoked (for example on a password change). If tools start returning `Invalid token`, repeat step 1.

## 3. Install + verify

```bash
(cd agent/moodle-mcp && npm install)      # bootstrap.sh does this too
(cd agent/moodle-mcp && npm test)         # offline tests against a fake Moodle
```

The server is registered in `agent/supervisor/mcp-config.json` (ops) and `chat-mcp-config.json` (chat), and allowlisted as `mcp__moodle__*` in `agent/config/agents.json`. Restart the supervisors to pick it up, then ask the agent to "run moodle_site_info". It should come back with your name and the site.

For PDF text extraction, install poppler (`brew install poppler` / `apt install poppler-utils`). Without it, `moodle_get_file` still saves the PDF but returns no text.

## Tools

| Tool | What it returns |
|---|---|
| `moodle_site_info` | Connection check: site, student name, Moodle version |
| `moodle_courses` | Enrolled courses (`include_past` for finished ones) |
| `moodle_course_contents` | Sections → activities/resources → files with `file_url` |
| `moodle_get_file` | Downloads a file to `data/moodle/files/<course_id>/`, returns extracted text (paged via `offset`) |
| `moodle_upcoming` | Timeline of deadlines/events across all courses |
| `moodle_assignments` | Assignments with due/cut-off dates, instructions, attachments |
| `moodle_assignment_status` | Submitted? graded? grade + teacher feedback |
| `moodle_grades` | Full grade report for a course |
| `moodle_quizzes` | Quizzes/exams with open/close times, time limit, attempts |
| `moodle_forums` / `moodle_forum_discussions` | Forums (incl. Announcements) and their latest posts |
| `moodle_call` | Escape hatch for any other read-only `*_get_*` / `*_search_*` web-service function |

## Safety

- **Read-only.** No tool submits, posts, or changes anything. `moodle_call` rejects any function name that doesn't contain `_get_` or `_search_`.
- **The token never leaves your Moodle host.** `moodle_get_file` refuses URLs on any other host, so it can't leak the token through a link someone planted in course content.
- Downloaded files live under `data/`, which is gitignored.
- Course text and forum posts count as untrusted input under the prompt-injection rules in `agent/CLAUDE.md`.
