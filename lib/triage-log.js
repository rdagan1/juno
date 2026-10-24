"use strict";
// triage-log.js — append-only email-triage event log at $MERLIN_HOME/logs/triage.log.
//
// Written by the ops supervisor's Gmail source (agent/supervisor/gmail-source.mjs)
// and the legacy gmail-channel MCP server; read by `merlin status`,
// `merlin triage status|stats|recent|pending` and lib/merlin-context.js.
//
// Line format (readers split on "|"):
//   <ISO-8601 UTC> | <ACTION> | <detail>
//
// Two call shapes:
//   triageLog("EMAIL-RECEIVED", { emailAddress, historyId })  → detail is the fields as JSON
//   triageLog("skip phantom messageId abc ...")               → ACTION is NOTE, detail is the text
//
// Never throws: a logging failure must not take down triage intake.

const fs = require("node:fs");
const path = require("node:path");

const MERLIN_HOME = process.env.MERLIN_HOME || path.join(process.env.HOME, "Dev/merlin");
const TRIAGE_LOG = path.join(MERLIN_HOME, "logs/triage.log");

// "|" and newlines would break the line-oriented, pipe-split format.
function clean(s) {
  return String(s).replace(/[\r\n]+/g, " ").replace(/\|/g, "/");
}

function triageLog(action, fields) {
  try {
    let detail = "";
    if (fields !== undefined) {
      detail = typeof fields === "string" ? fields : JSON.stringify(fields);
    } else if (/\s/.test(String(action))) {
      detail = action;
      action = "NOTE";
    }
    const line = `${new Date().toISOString()} | ${clean(action)}${detail ? ` | ${clean(detail)}` : ""}\n`;
    fs.mkdirSync(path.dirname(TRIAGE_LOG), { recursive: true });
    fs.appendFileSync(TRIAGE_LOG, line);
  } catch (err) {
    try { process.stderr.write(`[triage-log] write failed: ${err.message}\n`); } catch {}
  }
}

module.exports = { triageLog, TRIAGE_LOG };
