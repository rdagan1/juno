// google-api.test.mjs — OAuth refresh, REST calls and helpers in
// lib/google-api.mjs, against a fake fetch (no network).
//
// Run: node --test agent/test/google-api.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _setFetch, getAccessToken, listEvents, listTasks, addTask, searchContacts,
  busyNow, classifyTasks, localDate, GoogleAuthError,
} from "../../lib/google-api.mjs";

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

function fakeGoogle(routes) {
  const calls = [];
  _setFetch(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) return handler(String(url), init);
    }
    return json(404, { error: { message: "no route" } });
  });
  return calls;
}

const tokenOk = ["oauth2.googleapis.com/token", () => json(200, { access_token: "at-1", expires_in: 3600 })];

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "rt";
  delete process.env.GOOGLE_CALENDAR_ID;
});

describe("getAccessToken", () => {
  it("refreshes once and caches the token", async () => {
    const calls = fakeGoogle([tokenOk]);
    assert.equal(await getAccessToken(), "at-1");
    assert.equal(await getAccessToken(), "at-1");
    assert.equal(calls.length, 1);
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "rt");
  });

  it("raises GoogleAuthError on invalid_grant", async () => {
    fakeGoogle([["oauth2.googleapis.com/token", () => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })]]);
    await assert.rejects(getAccessToken(), GoogleAuthError);
  });

  it("raises GoogleAuthError when not configured", async () => {
    fakeGoogle([tokenOk]);
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "";
    await assert.rejects(getAccessToken(), /not configured/);
  });
});

describe("listEvents", () => {
  it("queries the primary calendar with expanded, ordered events", async () => {
    const calls = fakeGoogle([tokenOk, ["/calendars/primary/events", () => json(200, { items: [{ id: "e1" }] })]]);
    const items = await listEvents({ from: "2026-10-24T08:00:00Z", to: "2026-10-26T08:00:00Z", max: 30 });
    assert.deepEqual(items, [{ id: "e1" }]);
    const u = new URL(calls[1].url);
    assert.equal(u.searchParams.get("singleEvents"), "true");
    assert.equal(u.searchParams.get("orderBy"), "startTime");
    assert.equal(u.searchParams.get("maxResults"), "30");
    assert.equal(u.searchParams.get("timeMin"), "2026-10-24T08:00:00.000Z");
    assert.equal(calls[1].init.headers.Authorization, "Bearer at-1");
  });

  it("honors GOOGLE_CALENDAR_ID", async () => {
    process.env.GOOGLE_CALENDAR_ID = "me@example.com";
    const calls = fakeGoogle([tokenOk, ["/events", () => json(200, { items: [] })]]);
    await listEvents({ from: 0, to: 1 });
    assert.match(calls[1].url, /calendars\/me%40example\.com\/events/);
  });

  it("maps 401 to GoogleAuthError", async () => {
    fakeGoogle([tokenOk, ["/events", () => json(401, { error: { message: "Invalid Credentials" } })]]);
    await assert.rejects(listEvents({}), GoogleAuthError);
  });
});

describe("tasks", () => {
  it("lists the default list without resolving it", async () => {
    const calls = fakeGoogle([tokenOk, ["/lists/%40default/tasks", () => json(200, { items: [{ id: "t1" }] })]]);
    assert.deepEqual(await listTasks(), [{ id: "t1" }]);
    assert.equal(calls.length, 2);
  });

  it("resolves a list by title", async () => {
    fakeGoogle([
      tokenOk,
      ["/users/@me/lists", () => json(200, { items: [{ id: "L9", title: "School" }] })],
      ["/lists/L9/tasks", () => json(200, { items: [] })],
    ]);
    assert.deepEqual(await listTasks({ list: "School" }), []);
  });

  it("adds a task with a date-only due", async () => {
    const calls = fakeGoogle([tokenOk, ["/lists/%40default/tasks", (_u, init) => json(200, { id: "new", ...JSON.parse(init.body) })]]);
    const t = await addTask({ title: "Algorithms: HW3", due: "2026-11-02", notes: "From lecture 5" });
    assert.equal(t.due, "2026-11-02T00:00:00.000Z");
    assert.equal(calls[1].init.method, "POST");
  });

  it("rejects a malformed due date before calling Google", async () => {
    const calls = fakeGoogle([tokenOk]);
    await assert.rejects(addTask({ title: "x", due: "Nov 2" }), /YYYY-MM-DD/);
    assert.equal(calls.length, 0);
  });
});

describe("searchContacts", () => {
  it("warms up, then returns the people", async () => {
    const calls = fakeGoogle([tokenOk, ["people:searchContacts", (u) =>
      json(200, new URL(u).searchParams.get("query") ? { results: [{ person: { resourceName: "people/c1" } }] } : {})]]);
    assert.deepEqual(await searchContacts("alice"), [{ resourceName: "people/c1" }]);
    assert.equal(calls.filter((c) => c.url.includes("searchContacts")).length, 2);
  });
});

describe("busyNow", () => {
  const now = Date.parse("2026-10-24T10:30:00Z");
  const ev = (start, end, extra = {}) => ({ start: { dateTime: start }, end: { dateTime: end }, ...extra });

  it("counts opaque timed events in progress", () => {
    const events = [
      ev("2026-10-24T10:00:00Z", "2026-10-24T11:00:00Z"),
      ev("2026-10-24T10:00:00Z", "2026-10-24T11:00:00Z", { transparency: "transparent" }),
      ev("2026-10-24T11:00:00Z", "2026-10-24T12:00:00Z"),
      ev("2026-10-24T09:00:00Z", "2026-10-24T10:30:00Z"),
      { start: { date: "2026-10-24" }, end: { date: "2026-10-25" } },
    ];
    assert.equal(busyNow(events, now).length, 1);
  });
});

describe("classifyTasks", () => {
  it("splits overdue and due-today, skipping completed and undated", () => {
    const { overdue, dueToday } = classifyTasks([
      { id: "a", title: "old", due: "2026-10-20T00:00:00.000Z", status: "needsAction" },
      { id: "b", title: "today", due: "2026-10-24T00:00:00.000Z", status: "needsAction" },
      { id: "c", title: "done", due: "2026-10-20T00:00:00.000Z", status: "completed" },
      { id: "d", title: "later", due: "2026-10-30T00:00:00.000Z", status: "needsAction" },
      { id: "e", title: "no date", status: "needsAction" },
    ], "2026-10-24");
    assert.deepEqual(overdue.map((t) => t.id), ["a"]);
    assert.deepEqual(dueToday.map((t) => t.id), ["b"]);
  });
});

describe("localDate", () => {
  it("uses the given zone", () => {
    assert.equal(localDate(new Date("2026-10-24T22:30:00Z"), "Asia/Jerusalem"), "2026-10-25");
    assert.equal(localDate(new Date("2026-10-24T22:30:00Z"), "UTC"), "2026-10-24");
  });
});
