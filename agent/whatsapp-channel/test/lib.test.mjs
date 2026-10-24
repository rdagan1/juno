import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldAccept, extractContent, jidDigits, toWhatsApp, chunk, buildDispatch } from "../lib.mjs";

const OWNER = "972501234567";
const BOT = "972509999999";

test("jidDigits strips device suffix and domain", () => {
  assert.equal(jidDigits("972501234567:12@s.whatsapp.net"), OWNER);
  assert.equal(jidDigits(null), "");
});

test("dedicated number: only the owner's messages get through", () => {
  const base = { selfDigits: BOT, ownerDigits: OWNER, sentIds: new Set() };
  assert.equal(shouldAccept({ ...base, key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: false, id: "a" } }), true);
  assert.equal(shouldAccept({ ...base, key: { remoteJid: "972500000000@s.whatsapp.net", fromMe: false } }), false, "stranger");
  assert.equal(shouldAccept({ ...base, key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true } }), false, "our own outgoing");
  assert.equal(shouldAccept({ ...base, key: { remoteJid: "123-456@g.us", participant: `${OWNER}@s.whatsapp.net` } }), false, "groups ignored");
  // LID-addressed chat resolved to the owner's phone number by the caller
  assert.equal(shouldAccept({ ...base, key: { remoteJid: "88888@lid", fromMe: false }, senderPn: `${OWNER}@s.whatsapp.net` }), true);
  assert.equal(shouldAccept({ ...base, key: { remoteJid: "88888@lid", fromMe: false }, senderPn: null }), false, "unresolved LID");
});

test("self-chat: accept the owner's notes to self, never our own replies", () => {
  const sentIds = new Set(["bot-reply"]);
  const base = { selfDigits: OWNER, ownerDigits: OWNER, sentIds };
  assert.equal(shouldAccept({ ...base, key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: "u1" } }), true);
  assert.equal(shouldAccept({ ...base, key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: "bot-reply" } }), false);
  assert.equal(shouldAccept({ ...base, key: { remoteJid: "972500000000@s.whatsapp.net", fromMe: true, id: "u2" } }), false, "owner texting a friend");
  assert.equal(shouldAccept({ ...base, key: { remoteJid: "972500000000@s.whatsapp.net", fromMe: false, id: "u3" } }), false, "friend texting owner");
});

test("extractContent unwraps envelopes and identifies media", () => {
  assert.equal(extractContent({ conversation: "hi" }).text, "hi");
  assert.equal(extractContent({ ephemeralMessage: { message: { extendedTextMessage: { text: "eph" } } } }).text, "eph");
  const img = extractContent({ imageMessage: { caption: "q3?", mimetype: "image/jpeg" } });
  assert.deepEqual([img.text, img.media.kind], ["q3?", "image"]);
  const doc = extractContent({ documentWithCaptionMessage: { message: { documentMessage: { fileName: "hw.pdf", mimetype: "application/pdf" } } } });
  assert.equal(doc.media.filename, "hw.pdf");
  assert.equal(extractContent({ audioMessage: { ptt: true } }).media.kind, "voice");
});

test("markdown is converted to WhatsApp formatting", () => {
  assert.equal(toWhatsApp("## Due\n**HW1** ~~old~~\n- a\n[link](https://x.y)"), "*Due*\n*HW1* ~old~\n• a\nlink: https://x.y");
});

test("chunk splits on paragraph boundaries", () => {
  const parts = chunk(`${"a".repeat(30)}\n\n${"b".repeat(30)}`, 40);
  assert.deepEqual(parts, ["a".repeat(30), "b".repeat(30)]);
  assert.ok(chunk("x".repeat(100), 40).every((p) => p.length <= 40));
});

test("dispatch content tells the agent how to reply", () => {
  const c = buildDispatch({ text: "what's due?", media: { kind: "image" }, mediaPath: "/m/1.jpeg", timeZone: "Asia/Jerusalem", now: new Date("2026-10-24T10:00:00Z") });
  assert.match(c, /what's due\?/);
  assert.match(c, /saved at \/m\/1\.jpeg/);
  assert.match(c, /13:00/);
  assert.match(c, /mcp__whatsapp__reply/);
});

test("daemon without WHATSAPP_OWNER serves health and refuses sends", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "wa-test-"));
  const port = 19000 + Math.floor(Math.random() * 500);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(dir, "../daemon.mjs")], {
    env: { PATH: process.env.PATH, HOME: home, MERLIN_HOME: home, WHATSAPP_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    let health;
    for (let i = 0; i < 50 && !health; i++) {
      await new Promise((r) => setTimeout(r, 100));
      health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    }
    assert.equal(health.connected, false);
    assert.equal(health.owner, null);
    const res = await fetch(`http://127.0.0.1:${port}/send`, { method: "POST", body: JSON.stringify({ message: "x" }) });
    assert.equal(res.status, 503);
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
