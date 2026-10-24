// moodle-recordings.test.mjs — end-to-end test of bin/moodle-recordings
// against a mock Moodle served locally and a headless Chromium exposing CDP
// (standing in for the automation Chrome on :9222).
//
// Covers: bootstrap baseline, new-recording detection, caption path (Hebrew
// VTT → no Whisper), audio path (ffmpeg download → transcriber), Claude digest
// (mocked), Moodle-login detection, delivery marking.
//
// Needs playwright(-core) + Chromium + ffmpeg; skips cleanly without them.
// Run: node --test agent/test/moodle-recordings.test.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin/moodle-recordings");
const require = createRequire(path.join(ROOT, "bin/package.json"));

let chromium = null;
for (const m of ["playwright-core", "playwright"]) { try { chromium = require(m).chromium; break; } catch {} }
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const skip = !chromium || !hasFfmpeg ? "playwright or ffmpeg unavailable" : false;

const HEB_LINES = [
  "בוקר טוב, היום נדבר על גבולות של פונקציות",
  "ההגדרה הפורמלית היא הגדרת אפסילון דלתא",
  "שימו לב, ההגדרה הזאת יופיע במבחן בוודאות",
  "תרגיל בית שלוש צריך להגיש עד יום ראשון",
];

function vtt(n = 40) {
  const cues = [];
  for (let i = 0; i < n; i++) {
    const t = (s) => `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000`;
    cues.push(`${t(i * 10)} --> ${t(i * 10 + 8)}\n${HEB_LINES[i % HEB_LINES.length]}`);
  }
  return "WEBVTT\n\n" + cues.join("\n\n");
}

describe("moodle-recordings CLI", { skip }, () => {
  let tmp, server, port, browser, cdpPort, env, mp4;
  const activities = [
    { cmid: 1, mod: "kalvidres", name: "הרצאה 1 - מבוא" },
    { cmid: 2, mod: "resource", name: "סילבוס הקורס" },
  ];

  const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>חדו"א 1 | Moodle</title></head><body>${body}</body></html>`;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moodle-rec-"));
    mp4 = path.join(tmp, "lecture.mp4");
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=90", "-c:a", "aac", "-movflags", "+faststart", mp4]);

    server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const send = (code, body, type = "text/html; charset=utf-8") => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
      if (u.pathname === "/course/view.php") {
        if (u.searchParams.get("id") === "999") { res.writeHead(302, { Location: "/login/index.php" }); return res.end(); }
        const lis = activities.map((a) => `<li class="activity modtype_${a.mod}"><a class="aalink" href="/mod/${a.mod}/view.php?id=${a.cmid}"><span class="instancename">${a.name}<span class="accesshide"> Kaltura</span></span></a></li>`).join("");
        return send(200, page(`<ul><li class="section"><h3 class="sectionname">שבוע 1</h3><ul>${lis}</ul></li></ul>`));
      }
      if (u.pathname === "/login/index.php") return send(200, page("login"));
      if (u.pathname.startsWith("/mod/kalvidres/view.php")) return send(200, page(`<iframe src="/player/${u.searchParams.get("id")}?captions=1" width="600" height="400"></iframe>`));
      if (u.pathname.startsWith("/mod/url/view.php")) return send(200, page(`<div class="urlworkaround">Click <a href="/player/${u.searchParams.get("id")}">here</a></div>`));
      if (u.pathname.startsWith("/player/")) {
        const withCaps = u.searchParams.get("captions") === "1";
        return send(200, page(`<button class="vjs-big-play-button" onclick="go()">play</button><div id="v"></div>
          <script>function go(){document.getElementById('v').innerHTML='<video src="/media/lecture.mp4" muted>${withCaps ? '<track src="/captions/he.vtt" kind="captions">' : ""}</video>';
          ${withCaps ? "fetch('/captions/he.vtt');" : ""} fetch('/media/lecture.mp4');}</script>`));
      }
      if (u.pathname === "/captions/he.vtt") return send(200, vtt(), "text/vtt");
      if (u.pathname === "/media/lecture.mp4") return send(200, fs.readFileSync(mp4), "video/mp4");
      send(404, "nf");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;

    cdpPort = 9400 + Math.floor(Math.random() * 400);
    browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });

    // Mock claude -p: echoes a digest that keeps one exam highlight.
    const fakeClaude = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  if(!d.includes("Transcript")) process.exit(9);
  const digest={title:"גבולות",tldr:"הגדרת גבול",exam_relevance:"high",
    highlights:[{type:"exam",timestamp:"00:00:20",quote:"יופיע במבחן",note:"ההגדרה למבחן",date:null}],
    sections:[{heading:"גבולות",bullets:["אפסילון דלתא"]}],key_concepts:[],action_items:[{text:"תרגיל 3",due:"2026-10-25"}]};
  console.log(JSON.stringify({type:"result",is_error:false,result:"Sure:\\n"+JSON.stringify(digest)}));
});`);
    fs.chmodSync(fakeClaude, 0o755);

    // Fake transcriber invoked as "<python> bin/lecture-transcribe <audio> --out <dir> ...".
    const fakeTx = path.join(tmp, "fake-transcribe.cjs");
    fs.writeFileSync(fakeTx, `#!/usr/bin/env node
const fs=require("fs"),path=require("path");const a=process.argv.slice(2);const out=a[a.indexOf("--out")+1];
if(!fs.existsSync(a[1])) process.exit(4);
const segs=${JSON.stringify(HEB_LINES)}.flatMap((t,i)=>[0,1].map(j=>({start:(i*2+j)*20,end:(i*2+j)*20+10,text:t})));
fs.writeFileSync(path.join(out,"transcript.json"),JSON.stringify({language:"he",segments:segs}));`);
    fs.chmodSync(fakeTx, 0o755);

    fs.writeFileSync(path.join(tmp, "moodle-config.json"), JSON.stringify({
      base_url: `http://127.0.0.1:${port}`,
      cdp_url: `http://127.0.0.1:${cdpPort}`,
      courses: [{ id: 101, name: "חדו\"א 1" }],
      media_timeout_ms: 15000,
      transcribe: { python: fakeTx },
    }));
    env = { ...process.env, MOODLE_RECORDINGS_DATA: tmp, MERLIN_CLAUDE_BIN: fakeClaude };
  });

  after(async () => {
    await browser?.close();
    server?.close();
    if (tmp && !process.env.KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (...a) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...a], { env });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
  });

  it("bootstraps existing recordings as baseline (no backlog spam)", async () => {
    const r = await run("scan", "--json");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.bootstrapped, true);
    assert.equal(r.json.found, 1, "resource without a recording-like name must be ignored");
    assert.equal(r.json.fresh.length, 0);
  });

  it("detects a new recording and digests it from Hebrew captions", async () => {
    activities.push({ cmid: 3, mod: "kalvidres", name: "הרצאה 2 - גבולות" });
    const r = await run("run", "--json");
    assert.equal(r.code, 0, r.err);
    const id = `127.0.0.1:${port}:cm:3`;
    assert.deepEqual(r.json.new, [id]);
    assert.deepEqual(r.json.processed, [{ id, status: "digested" }], r.err);
    assert.equal(r.json.dispatch, true);
    const item = (await run("show", id, "--json")).json;
    assert.equal(item.fetched_from, "captions");
    assert.equal(item.exam_relevance, "high");
    assert.match(item.email_subject, /^\[מבחן\] /);
    const html = fs.readFileSync(item.digest_html, "utf8");
    assert.match(html, /dir="rtl"/);
    const cands = JSON.parse(fs.readFileSync(path.join(path.dirname(item.digest_json), "candidates.json"), "utf8"));
    assert.ok(cands.some((c) => c.category === "exam"));
  });

  it("downloads audio via ffmpeg when there are no captions", async () => {
    activities.push({ cmid: 4, mod: "url", name: "הקלטת תרגול 2" });
    const r = await run("run", "--json");
    const id = `127.0.0.1:${port}:cm:4`;
    assert.deepEqual(r.json.processed, [{ id, status: "digested" }], r.err);
    const item = (await run("show", id, "--json")).json;
    assert.equal(item.fetched_from, "file");
    assert.ok(item.duration > 60);
    assert.ok(!fs.existsSync(item.audio), "audio is deleted after transcription by default");
  });

  it("marks delivered and stops asking for dispatch", async () => {
    for (const cm of [3, 4]) assert.equal((await run("mark", `127.0.0.1:${port}:cm:${cm}`, "delivered")).code, 0);
    const r = await run("run", "--json", "--no-scan");
    assert.equal(r.json.dispatch, false);
  });

  it("raises a one-shot login alert when Moodle redirects to SSO", async () => {
    const cfgPath = path.join(tmp, "moodle-config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.courses.push({ id: 999, name: "x" });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = await run("run", "--json");
    assert.equal(r.json.auth_required, true);
    assert.equal(r.json.dispatch, true);
    assert.equal((await run("alert", "--ack")).code, 0);
    const again = await run("run", "--json");
    assert.equal(again.json.auth_required, false, "acked alert must not re-dispatch");
  });
});
