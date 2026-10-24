import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMoodleClient, encodeParams } from "../client.mjs";
import { buildTools, stripHtml } from "../tools.mjs";

const NOW = Math.floor(Date.now() / 1000);
const calls = [];
let server, base, filesDir;

// Minimal fake Moodle: token.php, REST server.php, and pluginfile.php.
const FIXTURES = {
  core_webservice_get_site_info: () => ({ sitename: "Test U", siteurl: base, fullname: "Stu Dent", userid: 42, release: "4.3" }),
  core_enrol_get_users_courses: (p) => {
    assert.equal(p.get("userid"), "42");
    return [
      { id: 7, shortname: "CS101", fullname: "Intro CS", startdate: NOW - 86400 * 30, enddate: NOW + 86400 * 60, progress: 40 },
      { id: 3, shortname: "OLD", fullname: "Old course", enddate: NOW - 86400 },
    ];
  },
  core_course_get_contents: () => [
    {
      section: 1, name: "Week 1", summary: "<p>Intro&nbsp;week</p>",
      modules: [{
        id: 100, instance: 5, modname: "resource", name: "Lecture 1",
        contents: [{ type: "file", filename: "notes.txt", fileurl: `${base}/pluginfile.php/1/mod_resource/content/0/notes.txt?forcedownload=1`, filesize: 11, timemodified: NOW }],
      }],
    },
    { section: 2, name: "Week 2", modules: [] },
  ],
  mod_assign_get_assignments: (p) => {
    assert.equal(p.get("courseids[0]"), "7");
    return { courses: [{ id: 7, fullname: "Intro CS", assignments: [
      { id: 9, cmid: 101, name: "HW1", duedate: NOW + 3600, intro: "<b>Do</b> it", introattachments: [] },
      { id: 8, cmid: 102, name: "HW0", duedate: NOW - 3600, intro: "" },
    ] }] };
  },
  core_calendar_get_action_events_by_timesort: () => ({ events: [
    { name: "HW1 is due", course: { id: 7, fullname: "Intro CS" }, modulename: "assign", instance: 9, timesort: NOW + 3600, action: { name: "Add submission", actionable: true }, url: "x" },
  ] }),
  mod_forum_get_forum_discussions: () => ({ discussions: [{ discussion: 1, subject: "Exam moved", userfullname: "Prof", created: NOW, numreplies: 0, message: "<p>Now on <i>Friday</i></p>" }] }),
};

before(async () => {
  filesDir = await mkdtemp(path.join(tmpdir(), "moodle-mcp-test-"));
  server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === "/webservice/pluginfile.php/1/mod_resource/content/0/notes.txt") {
      if (u.searchParams.get("token") !== "tok") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ error: "Invalid token", errorcode: "invalidtoken" }));
      }
      res.setHeader("content-type", "text/plain");
      return res.end("hello notes");
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/login/token.php") {
        return res.end(JSON.stringify(p.get("password") === "pw" ? { token: "tok" } : { error: "Invalid login", errorcode: "invalidlogin" }));
      }
      if (p.get("wstoken") !== "tok") return res.end(JSON.stringify({ exception: "x", errorcode: "invalidtoken", message: "Invalid token" }));
      const fn = p.get("wsfunction");
      calls.push(fn);
      const f = FIXTURES[fn];
      if (!f) return res.end(JSON.stringify({ exception: "x", errorcode: "nofunc", message: `no ${fn}` }));
      try { res.end(JSON.stringify(f(p))); }
      catch (err) { res.statusCode = 500; res.end(JSON.stringify({ assert: err.message })); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(filesDir, { recursive: true, force: true });
});

function toolsFor(opts = { token: "tok" }) {
  const client = createMoodleClient({ url: base, ...opts });
  return Object.fromEntries(buildTools(client, { filesDir, timeZone: "UTC" }).map((t) => [t.name, t]));
}

test("encodeParams flattens arrays and objects PHP-style", () => {
  const p = encodeParams({ courseids: [3, 7], options: [{ name: "x", value: true }] });
  assert.equal(p.toString(), "courseids%5B0%5D=3&courseids%5B1%5D=7&options%5B0%5D%5Bname%5D=x&options%5B0%5D%5Bvalue%5D=1");
});

test("stripHtml", () => {
  assert.equal(stripHtml("<p>a&nbsp;&amp;b</p><ul><li>x</li></ul>"), "a &b\n• x");
});

test("username/password is exchanged for a token", async () => {
  const t = toolsFor({ username: "s", password: "pw" });
  const info = JSON.parse(await t.moodle_site_info.run({}));
  assert.equal(info.user, "Stu Dent");
});

test("bad login surfaces a clear error", async () => {
  const t = toolsFor({ username: "s", password: "nope" });
  await assert.rejects(t.moodle_site_info.run({}), /Login failed: Invalid login/);
});

test("moodle_courses hides past courses unless asked", async () => {
  const t = toolsFor();
  assert.deepEqual(JSON.parse(await t.moodle_courses.run({})).map((c) => c.id), [7]);
  assert.deepEqual(JSON.parse(await t.moodle_courses.run({ include_past: true })).map((c) => c.id), [7, 3]);
});

test("moodle_course_contents filters by section and exposes file urls", async () => {
  const t = toolsFor();
  const s = JSON.parse(await t.moodle_course_contents.run({ course_id: 7, section: 1 }));
  assert.equal(s.length, 1);
  assert.equal(s[0].summary, "Intro week");
  assert.equal(s[0].modules[0].files[0].filename, "notes.txt");
});

test("moodle_get_file rewrites to webservice pluginfile, saves, and extracts text", async () => {
  const t = toolsFor();
  const url = `${base}/pluginfile.php/1/mod_resource/content/0/notes.txt?forcedownload=1`;
  const r = JSON.parse(await t.moodle_get_file.run({ file_url: url, course_id: 7 }));
  assert.equal(r.text, "hello notes");
  assert.equal(await readFile(r.saved_to, "utf8"), "hello notes");
  assert.equal(path.dirname(r.saved_to), path.join(filesDir, "7"));
});

test("moodle_get_file refuses to send the token to another host", async () => {
  const t = toolsFor();
  await assert.rejects(t.moodle_get_file.run({ file_url: "https://evil.example/pluginfile.php/1/x.pdf" }), /foreign host/);
});

test("moodle_assignments defaults to enrolled courses and sorts by due date", async () => {
  const t = toolsFor();
  const all = JSON.parse(await t.moodle_assignments.run({}));
  assert.deepEqual(all.map((a) => a.name), ["HW0", "HW1"]);
  assert.equal(all[1].instructions, "Do it");
  const upcoming = JSON.parse(await t.moodle_assignments.run({ upcoming_only: true }));
  assert.deepEqual(upcoming.map((a) => a.name), ["HW1"]);
});

test("moodle_upcoming and forum discussions", async () => {
  const t = toolsFor();
  const ev = JSON.parse(await t.moodle_upcoming.run({}));
  assert.equal(ev[0].course, "Intro CS");
  assert.match(ev[0].due, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(\w{3}\)$/);
  const d = JSON.parse(await t.moodle_forum_discussions.run({ forum_id: 1 }));
  assert.equal(d[0].message, "Now on Friday");
});

test("Moodle exceptions become errors", async () => {
  const t = toolsFor();
  await assert.rejects(t.moodle_call.run({ wsfunction: "mod_page_get_pages_by_courses" }), /no mod_page_get_pages_by_courses/);
});

test("moodle_call rejects non-read functions", async () => {
  const t = toolsFor();
  await assert.rejects(t.moodle_call.run({ wsfunction: "mod_assign_submit_for_grading" }), /only allows read functions/);
  assert.ok(!calls.includes("mod_assign_submit_for_grading"));
});
