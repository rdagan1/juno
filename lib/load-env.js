"use strict";
// load-env.js — shared loader for .env (KEY=VALUE lines).
// Used by process-manager, email-send, phone-channel, and any tool that needs
// secrets from .env. Subset of dotenv syntax: KEY=VALUE per line, # comment
// lines and trailing " # comments" on unquoted values, optional single/double
// quotes, blank lines ignored. Empty values (KEY=) count as unset. Does NOT
// override existing process.env values.

const fs = require("node:fs");
const path = require("node:path");
const MERLIN_HOME = process.env.MERLIN_HOME || path.resolve(__dirname, "..");

const DEFAULT_ENV_PATH = path.join(MERLIN_HOME, ".env");

// "abc"  → abc   'a # b' → a # b   abc   # note → abc   # just a comment → ""
function parseValue(raw) {
  const q = raw.match(/^(["'])(.*)\1(\s+#.*)?$/);
  if (q) return q[2];
  return raw.replace(/(^|\s+)#.*$/, "").trim();
}

function loadEnv(envPath = DEFAULT_ENV_PATH) {
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m || process.env[m[1]]) continue;
      const value = parseValue(m[2]);
      if (value !== "") process.env[m[1]] = value;
    }
  } catch {
    // Missing .env is not an error — tools may run without any secrets set.
  }
}

module.exports = { loadEnv, parseValue, DEFAULT_ENV_PATH };
