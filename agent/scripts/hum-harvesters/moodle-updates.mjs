#!/usr/bin/env node
// moodle-updates — surface new course announcements, grades, and due-date
// changes (plus, at low urgency, new materials) since the last hum check.
// Uses its own "hum" cursor, so the evening study digest still sees
// everything independently.

import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";
import { moodleClient, MOODLE_STATE_DIR } from "./_moodle.mjs";
import { checkChanges } from "../../moodle-mcp/changes.mjs";

export function pickCandidate(diff) {
  if (!diff || diff.baseline || !diff.total) return null;
  const parts = [];
  let urgency = 0;
  const ids = [];
  if (diff.due_date_changes.length) {
    urgency = Math.max(urgency, 0.7);
    parts.push(`due date moved: ${diff.due_date_changes.map((d) => `${d.name} (${d.course})`).join(", ")}`);
    ids.push(...diff.due_date_changes.map((d) => `d${d.assign_id}:${d.new_due}`));
  }
  if (diff.new_announcements.length) {
    urgency = Math.max(urgency, 0.55);
    parts.push(`announcement: ${diff.new_announcements.map((a) => `"${a.subject}" (${a.course})`).join(", ")}`);
    ids.push(...diff.new_announcements.map((a) => `a${a.discussion_id}`));
  }
  if (diff.new_grades.length) {
    urgency = Math.max(urgency, 0.5);
    parts.push(`grade posted: ${diff.new_grades.map((g) => `${g.name} (${g.course})`).join(", ")}`);
    ids.push(...diff.new_grades.map((g) => `g${g.name}:${g.grade}`));
  }
  if (diff.new_assignments.length) {
    urgency = Math.max(urgency, 0.4);
    parts.push(`new assignment: ${diff.new_assignments.map((a) => `${a.name} (${a.course})`).join(", ")}`);
    ids.push(...diff.new_assignments.map((a) => `n${a.assign_id}`));
  }
  const files = diff.new_files.length + diff.updated_files.length;
  if (files) {
    urgency = Math.max(urgency, 0.2);
    const courses = [...new Set([...diff.new_files, ...diff.updated_files].map((f) => f.course))];
    parts.push(`${files} new/updated file(s) in ${courses.join(", ")}`);
    ids.push(`f${files}:${diff.since}`);
  }
  if (!parts.length) return null;
  return {
    topic: "moodle-updates",
    signal: `Moodle — ${parts.join("; ")}`,
    urgency,
    freshness_min: 0,
    dedup_key: `moodle-updates:${ids.sort().join(",").slice(0, 200)}`,
    supporting_data: {
      announcements: diff.new_announcements.slice(0, 3).map((a) => ({ course: a.course, subject: a.subject, author: a.author, message: a.message?.slice(0, 400) })),
      due_date_changes: diff.due_date_changes,
      grades: diff.new_grades,
      new_assignments: diff.new_assignments,
      files: [...diff.new_files, ...diff.updated_files].slice(0, 8).map((f) => ({ course: f.course, filename: f.filename })),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await readStdinJson();
  try {
    const client = moodleClient();
    if (!client) { emitNull("MOODLE_URL not set"); process.exit(0); }
    const diff = await checkChanges(client, { stateDir: MOODLE_STATE_DIR, cursor: "hum" });
    const cand = pickCandidate(diff);
    stampRun("moodle-updates", !!cand);
    cand ? emit(cand) : emitNull(diff.baseline ? "baseline recorded" : "no changes");
  } catch (e) {
    emitNull(`moodle failed: ${e.message}`);
  }
}
