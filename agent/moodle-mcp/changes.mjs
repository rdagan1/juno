// changes.mjs — "what's new on Moodle since I last looked?"
//
// Takes a compact snapshot of the student's active courses (files,
// activities, assignment due dates, announcements, grades) and diffs it
// against the last snapshot saved for a named cursor. Each consumer keeps
// its own cursor (data/moodle/state-<cursor>.json) so the hum harvester
// marking something seen doesn't hide it from the evening study digest.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { stripHtml } from "./tools.mjs";

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

// File URLs carry volatile query strings (forcedownload, token); key on path.
const fileKey = (url) => {
  try { return new URL(url).pathname.replace("/webservice/pluginfile.php/", "/pluginfile.php/"); }
  catch { return url; }
};

export async function activeCourses(client) {
  const { userid } = await client.getSiteInfo();
  const t = Math.floor(Date.now() / 1000);
  const courses = await client.call("core_enrol_get_users_courses", { userid });
  return courses.filter((c) => !c.enddate || c.enddate > t);
}

export async function collectSnapshot(client) {
  const courses = await activeCourses(client);
  const { userid } = await client.getSiteInfo();
  const snap = { taken_at: new Date().toISOString(), courses: {}, files: {}, activities: {}, assignments: {}, announcements: {}, grades: {}, grades_available: true };
  const courseIds = courses.map((c) => c.id);
  for (const c of courses) snap.courses[c.id] = c.fullname;
  if (!courseIds.length) return snap;

  for (const c of courses) {
    const sections = await client.call("core_course_get_contents", { courseid: c.id });
    for (const s of sections) {
      for (const m of s.modules || []) {
        if (m.uservisible === false) continue;
        snap.activities[m.id] = { course_id: c.id, section: s.name, name: m.name, type: m.modname, url: m.url };
        for (const f of m.contents || []) {
          if (f.type !== "file") continue;
          snap.files[fileKey(f.fileurl)] = {
            course_id: c.id, section: s.name, activity: m.name, filename: f.filename,
            file_url: f.fileurl, modified: f.timemodified || 0,
          };
        }
      }
    }
  }

  const assigns = await client.call("mod_assign_get_assignments", { courseids: courseIds });
  for (const c of assigns.courses || []) {
    for (const a of c.assignments || []) {
      snap.assignments[a.id] = { course_id: c.id, name: a.name, due: a.duedate || 0 };
    }
  }

  const forums = await client.call("mod_forum_get_forums_by_courses", { courseids: courseIds });
  for (const f of forums.filter((x) => x.type === "news")) {
    const r = await client.call("mod_forum_get_forum_discussions", { forumid: f.id, page: 0, perpage: 10 });
    for (const d of r.discussions || []) {
      snap.announcements[d.discussion] = {
        course_id: f.course, subject: d.subject || d.name, author: d.userfullname,
        posted: d.created, message: clip(stripHtml(d.message), 1000),
      };
    }
  }

  // Some sites restrict the grade report for students.
  // One refusal means "not available here" — don't retry every course.
  for (const c of courses) {
    try {
      const r = await client.call("gradereport_user_get_grade_items", { courseid: c.id, userid });
      for (const i of r.usergrades?.[0]?.gradeitems || []) {
        if (i.itemtype === "course" || !i.gradeformatted || i.gradeformatted === "-") continue;
        snap.grades[`${c.id}:${i.id}`] = { course_id: c.id, name: i.itemname, grade: i.gradeformatted, range: i.rangeformatted };
      }
    } catch {
      snap.grades_available = false;
      break;
    }
  }
  return snap;
}

export function diffSnapshots(prev, next) {
  const name = (id) => next.courses[id] || prev.courses?.[id] || String(id);
  const out = {
    since: prev.taken_at,
    new_files: [], updated_files: [], new_activities: [],
    new_assignments: [], due_date_changes: [], new_announcements: [], new_grades: [],
    new_courses: Object.keys(next.courses).filter((id) => !(id in (prev.courses || {}))).map(name),
  };
  const fresh = (id) => id in (prev.courses || {}); // ignore everything in a just-enrolled course except the course itself

  for (const [k, f] of Object.entries(next.files)) {
    if (!fresh(f.course_id)) continue;
    const old = prev.files?.[k];
    const row = { course: name(f.course_id), course_id: f.course_id, section: f.section, activity: f.activity, filename: f.filename, file_url: f.file_url };
    if (!old) out.new_files.push(row);
    else if (f.modified > old.modified) out.updated_files.push(row);
  }
  for (const [id, m] of Object.entries(next.activities)) {
    if (!fresh(m.course_id) || prev.activities?.[id] || m.type === "resource") continue;
    out.new_activities.push({ course: name(m.course_id), section: m.section, name: m.name, type: m.type, url: m.url });
  }
  for (const [id, a] of Object.entries(next.assignments)) {
    if (!fresh(a.course_id)) continue;
    const old = prev.assignments?.[id];
    if (!old) out.new_assignments.push({ course: name(a.course_id), assign_id: Number(id), name: a.name, due: a.due });
    else if (old.due !== a.due) out.due_date_changes.push({ course: name(a.course_id), assign_id: Number(id), name: a.name, old_due: old.due, new_due: a.due });
  }
  for (const [id, d] of Object.entries(next.announcements)) {
    if (!fresh(d.course_id) || prev.announcements?.[id]) continue;
    out.new_announcements.push({ course: name(d.course_id), discussion_id: Number(id), ...d });
  }
  for (const [k, g] of Object.entries(next.grades)) {
    if (!fresh(g.course_id)) continue;
    const old = prev.grades?.[k];
    if (!old || old.grade !== g.grade) out.new_grades.push({ course: name(g.course_id), name: g.name, grade: g.grade, range: g.range, previous: old?.grade });
  }
  out.total = Object.values(out).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  return out;
}

export async function checkChanges(client, { stateDir, cursor = "default", markSeen = true }) {
  if (!/^[a-z0-9_-]{1,40}$/.test(cursor)) throw new Error(`invalid cursor '${cursor}'`);
  const file = path.join(stateDir, `state-${cursor}.json`);
  let prev = null;
  try { prev = JSON.parse(await readFile(file, "utf8")); } catch {}
  const next = await collectSnapshot(client);
  const save = async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(next));
    await rename(`${file}.tmp`, file);
  };
  if (!prev) {
    await save(); // first run: establish a baseline rather than reporting the whole semester as "new"
    return {
      baseline: true, cursor,
      tracking: { courses: Object.keys(next.courses).length, files: Object.keys(next.files).length, assignments: Object.keys(next.assignments).length, announcements: Object.keys(next.announcements).length },
      grades_available: next.grades_available,
    };
  }
  const diff = diffSnapshots(prev, next);
  if (markSeen) await save();
  return { cursor, grades_available: next.grades_available, ...diff };
}
