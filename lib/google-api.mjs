// google-api.mjs — minimal Google Calendar / Tasks / Contacts client for
// Merlin's own scripts (hum harvesters, watchdog, tools-mcp, bin/google).
//
// Replaces the private `gog` CLI. The agents reach Google Calendar through
// the claude.ai connector (mcp__claude_ai_Google_Calendar__*); this client is
// for code that runs outside a Claude session (cron, harvesters) and for the
// Tasks/Contacts tools the connector doesn't cover.
//
// Auth: one OAuth refresh token for the owner's Google account, minted once
// with `bin/google auth` and stored in .env:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
// Optional: GOOGLE_CALENDAR_ID (default "primary").
//
// No dependencies: plain fetch against the REST endpoints.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnv } = require("./load-env.js");

export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts.readonly",
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL = "https://www.googleapis.com/calendar/v3";
const TASKS = "https://tasks.googleapis.com/tasks/v1";
const PEOPLE = "https://people.googleapis.com/v1";
const TIMEOUT_MS = 15_000;
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";

/** Thrown when the refresh token is missing, revoked or expired. */
export class GoogleAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

let fetchImpl = (...args) => fetch(...args);
let cachedToken = null; // { token, expires }

/** Test hook: swap the fetch implementation and drop the token cache. */
export function _setFetch(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
  cachedToken = null;
}

function creds() {
  loadEnv();
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!id || !secret || !refresh) {
    throw new GoogleAuthError(
      "Google not configured: set GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN in .env (run bin/google auth; see docs/integrations/google.md)",
    );
  }
  return { id, secret, refresh };
}

export async function getAccessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const { id, secret, refresh } = creds();
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const why = data.error_description || data.error || `HTTP ${res.status}`;
    if (data.error === "invalid_grant" || data.error === "invalid_client" || data.error === "unauthorized_client") {
      throw new GoogleAuthError(`Google refresh token rejected (${why}) — rerun bin/google auth`);
    }
    throw new Error(`Google token refresh failed: ${why}`);
  }
  cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function api(method, url, { query, body } = {}) {
  const token = await getAccessToken();
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const res = await fetchImpl(u.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const why = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new GoogleAuthError(`Google API unauthorized: ${why}`);
    throw new Error(`Google API ${method} ${u.pathname} failed: ${why}`);
  }
  return data;
}

// ── Calendar (read-only; agents write through the claude.ai connector) ──

/** Events on the configured calendar overlapping [from, to), expanded and sorted. */
export async function listEvents({ from, to, max = 50, calendarId } = {}) {
  const cal = encodeURIComponent(calendarId || process.env.GOOGLE_CALENDAR_ID || "primary");
  const data = await api("GET", `${CAL}/calendars/${cal}/events`, {
    query: {
      timeMin: new Date(from ?? Date.now()).toISOString(),
      timeMax: to ? new Date(to).toISOString() : undefined,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: max,
    },
  });
  return data?.items || [];
}

/** Timed, busy (non-transparent) events in progress at `now`. */
export function busyNow(events, now = Date.now()) {
  return events.filter((e) => {
    if (!e?.start?.dateTime || !e?.end?.dateTime) return false;
    if (e.transparency === "transparent") return false;
    return new Date(e.start.dateTime).getTime() <= now && new Date(e.end.dateTime).getTime() > now;
  });
}

// ── Tasks ──

async function resolveList(list) {
  if (!list || list === "@default") return "@default";
  const data = await api("GET", `${TASKS}/users/@me/lists`, { query: { maxResults: 100 } });
  const hit = (data?.items || []).find((l) => l.id === list || l.title === list);
  if (!hit) throw new Error(`Google Tasks list not found: ${list}`);
  return hit.id;
}

/** Open tasks (plus completed ones when showCompleted) in a list. */
export async function listTasks({ list = "@default", showCompleted = false, max = 100 } = {}) {
  const id = await resolveList(list);
  const data = await api("GET", `${TASKS}/lists/${encodeURIComponent(id)}/tasks`, {
    query: { showCompleted, showHidden: showCompleted, maxResults: max },
  });
  return data?.items || [];
}

/** Create a task. `due` is YYYY-MM-DD (Google Tasks stores the date only). */
export async function addTask({ list = "@default", title, due, notes } = {}) {
  if (!title) throw new Error("addTask: title is required");
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("addTask: due must be YYYY-MM-DD");
  const id = await resolveList(list);
  return api("POST", `${TASKS}/lists/${encodeURIComponent(id)}/tasks`, {
    body: { title, notes: notes || undefined, due: due ? `${due}T00:00:00.000Z` : undefined },
  });
}

/** Mark a task completed. */
export async function completeTask({ list = "@default", taskId } = {}) {
  if (!taskId) throw new Error("completeTask: taskId is required");
  const id = await resolveList(list);
  return api("PATCH", `${TASKS}/lists/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`, {
    body: { status: "completed" },
  });
}

/** Local calendar date (YYYY-MM-DD) for `d` in `tz` (default: host zone). */
export function localDate(d = new Date(), tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Split open tasks into overdue / due-today relative to `today` (YYYY-MM-DD). */
export function classifyTasks(tasks, today) {
  const overdue = [];
  const dueToday = [];
  for (const t of tasks || []) {
    if (t.status === "completed" || !t.due) continue;
    const due = String(t.due).slice(0, 10);
    const row = { id: t.id, title: t.title, due };
    if (due < today) overdue.push(row);
    else if (due === today) dueToday.push(row);
  }
  return { overdue, dueToday };
}

// ── Contacts (read-only) ──

export async function searchContacts(query, { max = 10 } = {}) {
  // The People API wants an empty warm-up search before the first real one.
  await api("GET", `${PEOPLE}/people:searchContacts`, { query: { query: "", readMask: PERSON_FIELDS } }).catch(() => {});
  const data = await api("GET", `${PEOPLE}/people:searchContacts`, {
    query: { query, readMask: PERSON_FIELDS, pageSize: max },
  });
  return (data?.results || []).map((r) => r.person);
}

export async function getContact(resourceName) {
  if (!/^people\/[\w-]+$/.test(resourceName || "")) throw new Error("getContact: expected resourceName like people/c123");
  return api("GET", `${PEOPLE}/${resourceName}`, { query: { personFields: PERSON_FIELDS } });
}

export async function listContacts({ max = 200, pageToken } = {}) {
  const data = await api("GET", `${PEOPLE}/people/me/connections`, {
    query: { personFields: PERSON_FIELDS, pageSize: max, pageToken, sortOrder: "FIRST_NAME_ASCENDING" },
  });
  return { contacts: data?.connections || [], nextPageToken: data?.nextPageToken || null };
}
