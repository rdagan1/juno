// context-memory.js — the cross-source context index behind `context_search`.
//
// One compact "recall card" per item from each wired-in source (wiki pages,
// email memories, project files, docs, notes, messages, watchlist, Drive),
// written by bin/context-sync and searched by bin/context-search. A card is a
// pointer, not the content: summary + tags + metadata telling the agent which
// tool to call for the full item.
//
// Storage: data/context-memory.db (node:sqlite), FTS5 over summary + tags.
// Path overridable with CONTEXT_MEMORY_DB for tests.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { sanitizeFtsQuery } = require("./memory-store.js");

const MERLIN_HOME = process.env.MERLIN_HOME || path.resolve(__dirname, "..");
const DB_PATH = process.env.CONTEXT_MEMORY_DB || path.join(MERLIN_HOME, "data/context-memory.db");

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags TEXT DEFAULT '',
      metadata_json TEXT,
      expires_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id)
    )
  `);
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      summary, tags,
      content=entries,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, summary, tags) VALUES (new.id, new.summary, new.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, summary, tags) VALUES ('delete', old.id, old.summary, old.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, summary, tags) VALUES ('delete', old.id, old.summary, old.tags);
      INSERT INTO entries_fts(rowid, summary, tags) VALUES (new.id, new.summary, new.tags);
    END
  `);
  return _db;
}

// Insert or replace the card for (source, sourceId).
function upsert({ source, sourceId, summary, tags = "", metadata = null, expiresAt = null }) {
  if (!source || sourceId === undefined || sourceId === null) throw new Error("context-memory.upsert: source and sourceId required");
  db()
    .prepare(`
      INSERT INTO entries (source, source_id, summary, tags, metadata_json, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_id) DO UPDATE SET
        summary = excluded.summary, tags = excluded.tags, metadata_json = excluded.metadata_json,
        expires_at = excluded.expires_at, updated_at = excluded.updated_at
    `)
    .run(
      source,
      String(sourceId),
      String(summary ?? ""),
      String(tags ?? ""),
      metadata == null ? null : JSON.stringify(metadata),
      expiresAt,
      new Date().toISOString(),
    );
}

// Delete every card of `source` whose id is not in keepIds. Returns the count.
function removeStale(source, keepIds) {
  const keep = new Set((keepIds || []).map(String));
  const rows = db().prepare("SELECT id, source_id FROM entries WHERE source = ?").all(source);
  const del = db().prepare("DELETE FROM entries WHERE id = ?");
  let removed = 0;
  for (const r of rows) {
    if (!keep.has(r.source_id)) { del.run(r.id); removed++; }
  }
  return removed;
}

// [{source, count}] for non-expired cards, largest first.
function stats() {
  return db()
    .prepare(`
      SELECT source, COUNT(*) AS count FROM entries
      WHERE expires_at IS NULL OR expires_at > ?
      GROUP BY source ORDER BY count DESC
    `)
    .all(new Date().toISOString());
}

// Ranked FTS search. Returns rows {source, source_id, summary, tags, metadata_json, updated_at}.
function search(query, { source = undefined, limit = 15 } = {}) {
  const fts = sanitizeFtsQuery(String(query || ""));
  if (!fts) return [];
  const params = [fts, new Date().toISOString()];
  let where = "entries_fts MATCH ? AND (e.expires_at IS NULL OR e.expires_at > ?)";
  if (source) { where += " AND e.source = ?"; params.push(source); }
  params.push(limit);
  try {
    return db()
      .prepare(`
        SELECT e.source, e.source_id, e.summary, e.tags, e.metadata_json, e.updated_at
        FROM entries_fts f JOIN entries e ON e.id = f.rowid
        WHERE ${where}
        ORDER BY bm25(entries_fts)
        LIMIT ?
      `)
      .all(...params);
  } catch {
    return [];
  }
}

module.exports = { db, upsert, removeStale, stats, search, DB_PATH };
