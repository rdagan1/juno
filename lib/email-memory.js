// email-memory.js — email-classification memories for triage.
//
// Each row is a short decision the user confirmed ("Ignore everything from
// noreply@example.com", "SMH K-1 already handled") tagged with labels and
// sender domains. The ops agent consults them on every email
// (`email-mem test --from --subject`, agent/ops-agent/CLAUDE.md Step 1) and
// records new decisions with `email-mem add`.
//
// Storage: data/email-memory.db (node:sqlite), FTS5 over text + tags.
// Path overridable with EMAIL_MEMORY_DB for tests.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { sanitizeFtsQuery } = require("./memory-store.js");

const MERLIN_HOME = process.env.MERLIN_HOME || path.resolve(__dirname, "..");
const DB_PATH = process.env.EMAIL_MEMORY_DB || path.join(MERLIN_HOME, "data/email-memory.db");

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT
    )
  `);
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text, tags,
      content=memories,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END
  `);
  return _db;
}

// expires_at is a YYYY-MM-DD (or ISO) date; a memory is live through that day.
const LIVE = "(expires_at IS NULL OR expires_at >= ?)";
const today = () => new Date().toISOString().slice(0, 10);

function add({ text, tags = "", expiresAt = null }) {
  if (!text || !String(text).trim()) throw new Error("email-memory.add: text required");
  const r = db()
    .prepare("INSERT INTO memories (text, tags, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(String(text).trim(), String(tags || ""), new Date().toISOString(), expiresAt);
  return Number(r.lastInsertRowid);
}

function update(id, { text, tags, expiresAt } = {}) {
  const row = db().prepare("SELECT * FROM memories WHERE id = ?").get(id);
  if (!row) return false;
  db()
    .prepare("UPDATE memories SET text = ?, tags = ?, expires_at = ? WHERE id = ?")
    .run(text ?? row.text, tags ?? row.tags, expiresAt === undefined ? row.expires_at : expiresAt, id);
  return true;
}

function remove(id) {
  return db().prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}

// Newest first. `tag` matches one comma-separated tag exactly.
function list({ tag = undefined, limit = 1000 } = {}) {
  const rows = db()
    .prepare(`SELECT * FROM memories WHERE ${LIVE} ORDER BY id DESC`)
    .all(today());
  const filtered = tag
    ? rows.filter((r) => (r.tags || "").split(",").map((t) => t.trim()).includes(tag))
    : rows;
  return filtered.slice(0, limit);
}

function search(query, { limit = 20 } = {}) {
  const fts = sanitizeFtsQuery(String(query || ""));
  if (!fts) return [];
  try {
    return db()
      .prepare(`
        SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
        WHERE memories_fts MATCH ? AND ${LIVE.replace(/expires_at/g, "m.expires_at")}
        ORDER BY bm25(memories_fts) LIMIT ?
      `)
      .all(fts, today(), limit);
  } catch {
    return [];
  }
}

// Memories relevant to one email: anything mentioning the sender address or
// domain (in text or tags), plus FTS hits on subject/snippet words. Sender
// matches rank first — they're the strongest signal of a prior decision.
function searchForEmail({ from = "", subject = "", snippet = "" }, { limit = 10 } = {}) {
  const addr = (String(from).match(/<([^>]+)>/)?.[1] || String(from)).trim().toLowerCase();
  const domain = addr.includes("@") ? addr.split("@").pop() : "";
  const seen = new Map();
  if (addr || domain) {
    const needles = [addr, domain].filter(Boolean);
    for (const r of list({ limit: 100000 })) {
      const hay = `${r.text} ${r.tags}`.toLowerCase();
      if (needles.some((n) => hay.includes(n))) seen.set(r.id, r);
    }
  }
  for (const r of search(`${subject} ${snippet}`, { limit })) {
    if (!seen.has(r.id)) seen.set(r.id, r);
  }
  return [...seen.values()].slice(0, limit);
}

// Markdown block for a triage prompt; "" when nothing matches.
function formatForPrompt(email) {
  const rows = searchForEmail(email);
  if (rows.length === 0) return "";
  const lines = rows.map((r) => `- #${r.id}: ${r.text}${r.tags ? ` [${r.tags}]` : ""}`);
  return `Prior classification decisions that may apply to this email:\n${lines.join("\n")}`;
}

module.exports = { db, add, update, remove, list, search, searchForEmail, formatForPrompt, DB_PATH };
