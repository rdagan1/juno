#!/usr/bin/env node
// moodle-deadlines — surface Moodle work that is due soon and still needs
// action (not submitted / quiz not attempted), soonest first.
//
// Urgency escalates as the deadline approaches; the dedup key carries the
// urgency bucket so the same deadline can re-surface once per escalation
// (48h → 24h → 6h) instead of every tick.

import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";
import { moodleClient } from "./_moodle.mjs";

const LOOKAHEAD_H = 72;

export function bucket(hoursLeft) {
  if (hoursLeft < 0) return { name: "overdue", urgency: 0.6 };
  if (hoursLeft <= 6) return { name: "6h", urgency: 0.85 };
  if (hoursLeft <= 24) return { name: "24h", urgency: 0.65 };
  if (hoursLeft <= 48) return { name: "48h", urgency: 0.45 };
  return { name: "72h", urgency: 0.25 };
}

export function pickCandidate(events, nowSec) {
  const pending = (events || [])
    .filter((e) => e.action?.actionable)
    .map((e) => ({ ...e, hours: ((e.timesort ?? e.timestart) - nowSec) / 3600 }))
    .filter((e) => e.hours > -24 && e.hours <= LOOKAHEAD_H)
    .sort((a, b) => a.hours - b.hours);
  if (!pending.length) return null;
  const top = pending[0];
  const b = bucket(top.hours);
  const left = top.hours < 0
    ? `was due ${Math.round(-top.hours)}h ago`
    : top.hours < 1 ? "due in under an hour" : `due in ${Math.round(top.hours)}h`;
  const more = pending.length > 1 ? ` (+${pending.length - 1} more due within ${LOOKAHEAD_H}h)` : "";
  return {
    topic: "moodle-deadlines",
    signal: `${top.name} — ${top.course?.fullname || "course"} — ${left}, still needs: ${top.action?.name || "action"}${more}`,
    urgency: b.urgency,
    freshness_min: 0,
    dedup_key: `moodle-deadlines:${top.id}:${b.name}`,
    supporting_data: {
      items: pending.slice(0, 6).map((e) => ({
        name: e.name, course: e.course?.fullname, hours_left: Math.round(e.hours), action: e.action?.name, url: e.url,
      })),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await readStdinJson();
  try {
    const client = moodleClient();
    if (!client) { emitNull("MOODLE_URL not set"); process.exit(0); }
    const now = Math.floor(Date.now() / 1000);
    const r = await client.call("core_calendar_get_action_events_by_timesort", {
      timesortfrom: now - 86400, timesortto: now + LOOKAHEAD_H * 3600, limitnum: 30,
    });
    const cand = pickCandidate(r.events, now);
    stampRun("moodle-deadlines", !!cand);
    cand ? emit(cand) : emitNull("nothing pending");
  } catch (e) {
    emitNull(`moodle failed: ${e.message}`);
  }
}
