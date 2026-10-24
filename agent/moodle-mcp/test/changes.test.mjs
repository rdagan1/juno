import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkChanges } from "../changes.mjs";
import { pickCandidate as pickDeadline, bucket } from "../../scripts/hum-harvesters/moodle-deadlines.mjs";
import { pickCandidate as pickUpdate } from "../../scripts/hum-harvesters/moodle-updates.mjs";

const NOW = Math.floor(Date.now() / 1000);

// In-memory fake: mutate `world` between checkChanges calls to simulate Moodle changing.
function fakeClient(world) {
  return {
    getSiteInfo: async () => ({ userid: 1 }),
    call: async (fn, p) => {
      switch (fn) {
        case "core_enrol_get_users_courses": return world.courses;
        case "core_course_get_contents": return world.contents[p.courseid] || [];
        case "mod_assign_get_assignments": return { courses: [{ id: 7, assignments: world.assignments }] };
        case "mod_forum_get_forums_by_courses": return [{ id: 50, course: 7, type: "news" }, { id: 51, course: 7, type: "general" }];
        case "mod_forum_get_forum_discussions":
          assert.equal(p.forumid, 50, "only the news forum is polled");
          return { discussions: world.announcements };
        case "gradereport_user_get_grade_items":
          if (world.gradesBlocked) throw new Error("access denied");
          return { usergrades: [{ gradeitems: world.grades }] };
        default: throw new Error(`unexpected ${fn}`);
      }
    },
  };
}

function baseWorld() {
  return {
    courses: [{ id: 7, fullname: "Intro CS" }, { id: 3, fullname: "Old", enddate: NOW - 10 }],
    contents: {
      7: [{ name: "Week 1", modules: [{ id: 100, name: "Lecture 1", modname: "resource", contents: [{ type: "file", filename: "l1.pdf", fileurl: "https://m/pluginfile.php/1/l1.pdf?forcedownload=1", timemodified: 100 }] }] }],
    },
    assignments: [{ id: 9, name: "HW1", duedate: NOW + 86400 }],
    announcements: [{ discussion: 1, subject: "Welcome", userfullname: "Prof", created: NOW - 999, message: "<p>hi</p>" }],
    grades: [{ id: 1, itemname: "HW0", itemtype: "mod", gradeformatted: "-" }],
  };
}

test("first check records a baseline, then reports only what changed", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "moodle-changes-"));
  try {
    const world = baseWorld();
    const client = fakeClient(world);
    const first = await checkChanges(client, { stateDir, cursor: "digest" });
    assert.equal(first.baseline, true);
    assert.equal(first.tracking.files, 1);

    const quiet = await checkChanges(client, { stateDir, cursor: "digest" });
    assert.equal(quiet.total, 0);

    // Moodle changes: new lecture file, slides re-uploaded, new quiz, due date moved, announcement, grade.
    world.contents[7][0].modules[0].contents[0].timemodified = 200;
    world.contents[7].push({ name: "Week 2", modules: [
      { id: 101, name: "Lecture 2", modname: "resource", contents: [{ type: "file", filename: "l2.pdf", fileurl: "https://m/pluginfile.php/1/l2.pdf", timemodified: 300 }] },
      { id: 102, name: "Quiz 1", modname: "quiz" },
    ] });
    world.assignments[0].duedate = NOW + 3 * 86400;
    world.announcements.unshift({ discussion: 2, subject: "Exam moved", userfullname: "Prof", created: NOW, message: "<p>Now <b>Friday</b></p>" });
    world.grades[0].gradeformatted = "95.00";

    const peek = await checkChanges(client, { stateDir, cursor: "digest", markSeen: false });
    assert.equal(peek.total, 6);
    const d = await checkChanges(client, { stateDir, cursor: "digest" });
    assert.deepEqual(d.new_files.map((f) => f.filename), ["l2.pdf"]);
    assert.deepEqual(d.updated_files.map((f) => f.filename), ["l1.pdf"]);
    assert.deepEqual(d.new_activities.map((a) => a.name), ["Quiz 1"]);
    assert.equal(d.due_date_changes[0].name, "HW1");
    assert.equal(d.new_announcements[0].message, "Now Friday");
    assert.equal(d.new_grades[0].grade, "95.00");
    assert.equal(d.grades_available, true);

    // Cursors are independent: "hum" has never looked, so it gets a baseline.
    assert.equal((await checkChanges(client, { stateDir, cursor: "hum" })).baseline, true);
    // And "digest" advanced (mark_seen default) so it's quiet again.
    assert.equal((await checkChanges(client, { stateDir, cursor: "digest" })).total, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("blocked grade report is tolerated", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "moodle-changes-"));
  try {
    const world = { ...baseWorld(), gradesBlocked: true };
    const r = await checkChanges(fakeClient(world), { stateDir });
    assert.equal(r.grades_available, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("invalid cursor names are rejected", async () => {
  await assert.rejects(checkChanges(fakeClient(baseWorld()), { stateDir: "/tmp", cursor: "../x" }), /invalid cursor/);
});

test("deadline harvester picks the soonest actionable item and escalates", () => {
  assert.equal(bucket(3).name, "6h");
  assert.equal(bucket(30).name, "48h");
  const events = [
    { id: 1, name: "HW2 due", timesort: NOW + 40 * 3600, action: { actionable: true, name: "Add submission" }, course: { fullname: "Intro CS" } },
    { id: 2, name: "HW1 due", timesort: NOW + 5 * 3600, action: { actionable: true, name: "Add submission" }, course: { fullname: "Intro CS" } },
    { id: 3, name: "Done", timesort: NOW + 3600, action: { actionable: false } },
  ];
  const c = pickDeadline(events, NOW);
  assert.match(c.signal, /^HW1 due — Intro CS — due in 5h/);
  assert.match(c.signal, /\+1 more/);
  assert.equal(c.dedup_key, "moodle-deadlines:2:6h");
  assert.equal(c.urgency, 0.85);
  assert.equal(pickDeadline([events[2]], NOW), null);
});

test("updates harvester ranks due-date changes above new files", () => {
  const empty = { total: 0, new_files: [], updated_files: [], new_activities: [], new_assignments: [], due_date_changes: [], new_announcements: [], new_grades: [] };
  assert.equal(pickUpdate({ baseline: true }), null);
  assert.equal(pickUpdate(empty), null);
  const files = pickUpdate({ ...empty, total: 1, since: "t", new_files: [{ course: "Intro CS", filename: "l2.pdf" }] });
  assert.equal(files.urgency, 0.2);
  const moved = pickUpdate({ ...empty, total: 2, since: "t", new_files: [{ course: "Intro CS", filename: "l2.pdf" }], due_date_changes: [{ assign_id: 9, name: "HW1", course: "Intro CS", new_due: 5 }] });
  assert.equal(moved.urgency, 0.7);
  assert.match(moved.signal, /due date moved: HW1/);
});
