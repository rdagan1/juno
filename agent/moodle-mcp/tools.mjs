// tools.mjs — MCP tool definitions for the Moodle server.
//
// Every tool is READ-ONLY. Nothing here submits assignments, posts to
// forums, or changes completion state — studying needs the data, not write
// access. Output is compact JSON so the agent can reason over it without
// burning context on Moodle's verbose payloads.

import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

const DAY = 86400;

export function stripHtml(html = "") {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function clip(text, max) {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function makeDateFormatter(timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  // Moodle timestamps are unix seconds; 0 means "not set".
  return (ts) => {
    if (!ts) return undefined;
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${p.weekday})`;
  };
}

function safeName(s) {
  return String(s).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
}

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".py", ".java", ".c", ".cpp", ".h", ".js", ".ts", ".tex", ".m", ".r", ".sql"]);

async function extractText(filePath, contentType, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm" || contentType.includes("text/html")) {
    return stripHtml(buffer.toString("utf8"));
  }
  if (TEXT_EXT.has(ext) || contentType.startsWith("text/")) return buffer.toString("utf8");
  if (ext === ".pdf" || contentType.includes("pdf")) {
    try {
      const { stdout } = await exec("pdftotext", ["-layout", filePath, "-"], { maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch {
      return null; // pdftotext missing — caller falls back to the saved path
    }
  }
  return null;
}

export function buildTools(client, { filesDir, timeZone } = {}) {
  const when = makeDateFormatter(timeZone);
  const now = () => Math.floor(Date.now() / 1000);
  const json = (x) => JSON.stringify(x, null, 2);

  async function userId() {
    return (await client.getSiteInfo()).userid;
  }

  async function enrolledCourseIds() {
    const courses = await client.call("core_enrol_get_users_courses", { userid: await userId() });
    return courses.map((c) => c.id);
  }

  return [
    {
      name: "moodle_site_info",
      description: "Check the Moodle connection: site name, logged-in student, and Moodle version. Call this first if other moodle_* tools fail.",
      schema: { type: "object", properties: {} },
      run: async () => {
        const s = await client.getSiteInfo();
        return json({ site: s.sitename, url: s.siteurl, user: s.fullname, userid: s.userid, release: s.release, lang: s.lang });
      },
    },
    {
      name: "moodle_courses",
      description: "List the courses the student is enrolled in (id, short/full name, progress, last access). Course ids feed every other moodle_* tool. Past courses (end date passed) are hidden unless include_past=true.",
      schema: {
        type: "object",
        properties: { include_past: { type: "boolean", description: "Include courses whose end date has passed" } },
      },
      run: async (a) => {
        const courses = await client.call("core_enrol_get_users_courses", { userid: await userId() });
        const t = now();
        return json(
          courses
            .filter((c) => a.include_past || !c.enddate || c.enddate > t)
            .map((c) => ({
              id: c.id,
              shortname: c.shortname,
              fullname: c.fullname,
              progress: c.progress ?? undefined,
              starts: when(c.startdate),
              ends: when(c.enddate),
              last_access: when(c.lastaccess),
              favourite: c.isfavourite || undefined,
            })),
        );
      },
    },
    {
      name: "moodle_course_contents",
      description: "Get a course's structure: sections (weeks/topics) and their activities and resources — lecture slides, PDFs, pages, links, assignments, quizzes. Each file includes a file_url to pass to moodle_get_file. Use `section` to narrow to one section number.",
      schema: {
        type: "object",
        properties: {
          course_id: { type: "number" },
          section: { type: "number", description: "Optional section number (0 = general section)" },
        },
        required: ["course_id"],
      },
      run: async (a) => {
        const sections = await client.call("core_course_get_contents", { courseid: a.course_id });
        return json(
          sections
            .filter((s) => a.section === undefined || s.section === a.section)
            .map((s) => ({
              section: s.section,
              name: s.name,
              summary: clip(stripHtml(s.summary), 400),
              modules: (s.modules || [])
                .filter((m) => m.uservisible !== false)
                .map((m) => ({
                  cmid: m.id,
                  instance: m.instance,
                  type: m.modname,
                  name: m.name,
                  url: m.url,
                  description: clip(stripHtml(m.description), 300),
                  files: (m.contents || [])
                    .filter((f) => f.type === "file")
                    .map((f) => ({
                      filename: f.filename,
                      file_url: f.fileurl,
                      size: f.filesize,
                      mimetype: f.mimetype,
                      modified: when(f.timemodified),
                    })),
                  link: (m.contents || []).find((f) => f.type === "url")?.fileurl,
                })),
            })),
        );
      },
    },
    {
      name: "moodle_get_file",
      description: "Download a Moodle file (from a file_url returned by another moodle_* tool), save it under data/moodle/files/, and return its extracted text when possible (PDF via pdftotext, HTML, plain text/code). Long text is paged: pass offset to continue reading.",
      schema: {
        type: "object",
        properties: {
          file_url: { type: "string" },
          course_id: { type: "number", description: "Optional — groups the saved file by course" },
          offset: { type: "number", description: "Character offset into the extracted text (default 0)" },
          max_chars: { type: "number", description: "Max characters of text to return (default 20000)" },
        },
        required: ["file_url"],
      },
      run: async (a) => {
        const { buffer, contentType } = await client.download(a.file_url);
        const filename = safeName(decodeURIComponent(new URL(a.file_url).pathname.split("/").pop() || "file"));
        const dir = path.join(filesDir, String(a.course_id ?? "misc"));
        await mkdir(dir, { recursive: true });
        const saved = path.join(dir, filename);
        await writeFile(saved, buffer);
        const text = await extractText(saved, contentType, buffer);
        const offset = a.offset || 0;
        const max = a.max_chars || 20000;
        const out = { saved_to: saved, bytes: buffer.length, content_type: contentType };
        if (text === null) {
          out.note = "No text extraction for this file type (for PDFs, install poppler's pdftotext). Read the saved file directly if needed.";
        } else {
          out.total_chars = text.length;
          out.offset = offset;
          out.text = text.slice(offset, offset + max);
          if (offset + max < text.length) out.next_offset = offset + max;
        }
        return json(out);
      },
    },
    {
      name: "moodle_upcoming",
      description: "Upcoming deadlines and events across all courses (assignment due dates, quiz closes, etc.) from the Moodle timeline, soonest first. Includes overdue items from the past `overdue_days`.",
      schema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Look-ahead window in days (default 14)" },
          overdue_days: { type: "number", description: "Also include items due in the past N days (default 0)" },
          limit: { type: "number", description: "Max events (default 50)" },
        },
      },
      run: async (a) => {
        const t = now();
        const res = await client.call("core_calendar_get_action_events_by_timesort", {
          timesortfrom: t - (a.overdue_days || 0) * DAY,
          timesortto: t + (a.days || 14) * DAY,
          limitnum: a.limit || 50,
        });
        return json(
          (res.events || []).map((e) => ({
            name: e.name,
            course: e.course?.fullname,
            course_id: e.course?.id,
            type: e.modulename,
            instance: e.instance,
            due: when(e.timesort ?? e.timestart),
            overdue: (e.timesort ?? e.timestart) < t || undefined,
            action: e.action?.name,
            actionable: e.action?.actionable,
            url: e.url,
          })),
        );
      },
    },
    {
      name: "moodle_assignments",
      description: "List assignments with due dates, cut-off dates, and instructions (plus attached instruction files). Defaults to all enrolled courses. Use moodle_assignment_status for submission/grading state of one assignment.",
      schema: {
        type: "object",
        properties: {
          course_ids: { type: "array", items: { type: "number" }, description: "Optional — restrict to these courses" },
          upcoming_only: { type: "boolean", description: "Only assignments not yet due (default false)" },
        },
      },
      run: async (a) => {
        const courseids = a.course_ids?.length ? a.course_ids : await enrolledCourseIds();
        const res = await client.call("mod_assign_get_assignments", { courseids });
        const t = now();
        const out = [];
        for (const c of res.courses || []) {
          for (const as of c.assignments || []) {
            if (a.upcoming_only && as.duedate && as.duedate < t) continue;
            out.push({
              assign_id: as.id,
              cmid: as.cmid,
              course: c.fullname,
              course_id: c.id,
              name: as.name,
              opens: when(as.allowsubmissionsfromdate),
              due: when(as.duedate),
              cutoff: when(as.cutoffdate),
              instructions: clip(stripHtml(as.intro), 1500),
              files: (as.introattachments || []).map((f) => ({ filename: f.filename, file_url: f.fileurl })),
            });
          }
        }
        out.sort((x, y) => (x.due || "9").localeCompare(y.due || "9"));
        return json(out);
      },
    },
    {
      name: "moodle_assignment_status",
      description: "Submission and grading status for one assignment (by assign_id from moodle_assignments): submitted or not, last modified, grade, and teacher feedback.",
      schema: { type: "object", properties: { assign_id: { type: "number" } }, required: ["assign_id"] },
      run: async (a) => {
        const r = await client.call("mod_assign_get_submission_status", { assignid: a.assign_id });
        const sub = r.lastattempt?.submission || r.lastattempt?.teamsubmission;
        const fb = r.feedback;
        return json({
          submission_status: sub?.status,
          grading_status: r.lastattempt?.gradingstatus,
          last_modified: when(sub?.timemodified),
          can_submit: r.lastattempt?.cansubmit,
          extension_due: when(r.lastattempt?.extensionduedate),
          grade: fb?.gradefordisplay ? stripHtml(fb.gradefordisplay) : undefined,
          graded_on: when(fb?.gradeddate),
          feedback: (fb?.plugins || [])
            .flatMap((p) => p.editorfields || [])
            .map((f) => stripHtml(f.text))
            .filter(Boolean)
            .join("\n\n") || undefined,
        });
      },
    },
    {
      name: "moodle_grades",
      description: "The student's grade report for one course: every grade item with grade, range, percentage, weight, and feedback.",
      schema: { type: "object", properties: { course_id: { type: "number" } }, required: ["course_id"] },
      run: async (a) => {
        const r = await client.call("gradereport_user_get_grade_items", { courseid: a.course_id, userid: await userId() });
        const g = r.usergrades?.[0];
        if (!g) return json({ course_id: a.course_id, items: [] });
        return json({
          course_id: a.course_id,
          items: (g.gradeitems || []).map((i) => ({
            name: i.itemname || (i.itemtype === "course" ? "Course total" : i.itemtype),
            type: i.itemmodule || i.itemtype,
            grade: i.gradeformatted,
            range: i.rangeformatted,
            percentage: i.percentageformatted,
            weight: i.weightformatted,
            feedback: clip(stripHtml(i.feedback), 500),
            graded: when(i.gradedategraded),
          })),
        });
      },
    },
    {
      name: "moodle_quizzes",
      description: "List quizzes/exams with open and close times, time limit, and attempts allowed. Defaults to all enrolled courses.",
      schema: {
        type: "object",
        properties: { course_ids: { type: "array", items: { type: "number" } } },
      },
      run: async (a) => {
        const courseids = a.course_ids?.length ? a.course_ids : await enrolledCourseIds();
        const r = await client.call("mod_quiz_get_quizzes_by_courses", { courseids });
        return json(
          (r.quizzes || []).map((q) => ({
            quiz_id: q.id,
            cmid: q.coursemodule,
            course_id: q.course,
            name: q.name,
            opens: when(q.timeopen),
            closes: when(q.timeclose),
            time_limit_min: q.timelimit ? Math.round(q.timelimit / 60) : undefined,
            attempts_allowed: q.attempts === 0 ? "unlimited" : q.attempts,
            description: clip(stripHtml(q.intro), 600),
          })),
        );
      },
    },
    {
      name: "moodle_forums",
      description: "List a course's forums (including the Announcements / news forum, type 'news'). Pass a forum_id to moodle_forum_discussions to read posts.",
      schema: { type: "object", properties: { course_id: { type: "number" } }, required: ["course_id"] },
      run: async (a) => {
        const r = await client.call("mod_forum_get_forums_by_courses", { courseids: [a.course_id] });
        return json(r.map((f) => ({ forum_id: f.id, name: f.name, type: f.type, discussions: f.numdiscussions, intro: clip(stripHtml(f.intro), 200) })));
      },
    },
    {
      name: "moodle_forum_discussions",
      description: "Read the latest discussions in a forum (e.g. course announcements): subject, author, date, and message text.",
      schema: {
        type: "object",
        properties: {
          forum_id: { type: "number" },
          limit: { type: "number", description: "Discussions to return (default 10)" },
          page: { type: "number", description: "Page number for older discussions (default 0)" },
        },
        required: ["forum_id"],
      },
      run: async (a) => {
        const r = await client.call("mod_forum_get_forum_discussions", {
          forumid: a.forum_id,
          page: a.page || 0,
          perpage: a.limit || 10,
        });
        return json(
          (r.discussions || []).map((d) => ({
            discussion_id: d.discussion,
            subject: d.subject || d.name,
            author: d.userfullname,
            posted: when(d.created),
            replies: d.numreplies,
            pinned: d.pinned || undefined,
            message: clip(stripHtml(d.message), 2000),
            files: (d.attachments || []).map((f) => ({ filename: f.filename, file_url: f.fileurl })),
          })),
        );
      },
    },
    {
      name: "moodle_call",
      description: "Escape hatch: call any READ-ONLY Moodle web-service function directly (name must contain '_get_' or '_search_', e.g. 'mod_page_get_pages_by_courses', 'core_course_search_courses'). Params use the function's documented shape. Returns raw JSON.",
      schema: {
        type: "object",
        properties: {
          wsfunction: { type: "string" },
          params: { type: "object", description: "Function parameters, e.g. {\"courseids\": [12]}" },
        },
        required: ["wsfunction"],
      },
      run: async (a) => {
        if (!/^[a-z0-9]+_[a-z0-9_]+$/.test(a.wsfunction) || !/_(get|search)_/.test(a.wsfunction)) {
          throw new Error(`moodle_call only allows read functions containing _get_ or _search_ (got '${a.wsfunction}')`);
        }
        return json(await client.call(a.wsfunction, a.params || {}));
      },
    },
  ];
}
