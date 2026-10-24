#!/usr/bin/env node
import { listTasks, classifyTasks, localDate } from "../../../lib/google-api.mjs";
import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson(); void sit; void context;

try {
  const today = localDate();
  const { overdue, dueToday } = classifyTasks(await listTasks({ list: "@default" }), today);
  const count = overdue.length + dueToday.length;
  if (count === 0) { stampRun("tasks", false); emitNull("no due"); process.exit(0); }

  const urgency = overdue.length >= 3 ? 0.7 : (overdue.length >= 1 ? 0.5 : 0.3);
  const line = (t) => `${t.due} ${t.title}`.slice(0, 120);
  stampRun("tasks", true);
  emit({
    topic: "tasks",
    signal: `${overdue.length} overdue, ${dueToday.length} due today`,
    urgency,
    freshness_min: 0,
    dedup_key: `tasks:${today}:${overdue.length}:${dueToday.length}`,
    supporting_data: { overdue: overdue.slice(0, 5).map(line), due_today: dueToday.slice(0, 5).map(line) },
  });
} catch (e) {
  emitNull(`google tasks failed: ${e.message}`);
}
