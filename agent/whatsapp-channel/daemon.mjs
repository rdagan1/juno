// daemon.mjs — WhatsApp channel for Merlin (linked-device, via Baileys).
//
// Long-lived process under process-manager. Holds the ONE WhatsApp Web
// connection for the host and:
//   - forwards the owner's messages to the chat supervisor (POST /dispatch,
//     source "whatsapp", priority high), with images/documents saved under
//     data/whatsapp/media/ so the agent can Read them;
//   - serves a localhost-only HTTP API that everything else sends through:
//       POST /send   {message}   → owner's chat (used by mcp.mjs reply tool,
//                                  bin/whatsapp-send, the chat-supervisor
//                                  safety net)
//       GET  /health             → {connected, me, owner, mode, ...}
//
// First-time setup: `node daemon.mjs --link` (QR code) or
// `node daemon.mjs --link --pair <number>` (8-character pairing code).
// See docs/integrations/whatsapp.md.
//
// Unofficial client: WhatsApp's terms don't allow it and the linked number
// can be banned. Use a spare number where possible.

import http from "node:http";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import pino from "pino";
import makeWASocket, {
  DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion,
  Browsers, downloadMediaMessage, isLidUser, jidNormalizedUser,
} from "baileys";
import { shouldAccept, extractContent, jidDigits, normalizeNumber, toWhatsApp, chunk, buildDispatch } from "./lib.mjs";

const require = createRequire(import.meta.url);
const MERLIN_HOME = process.env.MERLIN_HOME || `${process.env.HOME}/Dev/merlin`;
require("../../lib/load-env.js").loadEnv(path.join(MERLIN_HOME, ".env"));

const env = process.env;
const OWNER = normalizeNumber(env.WHATSAPP_OWNER);
const PORT = Number(env.WHATSAPP_PORT || 9097);
const DISPATCH_URL = env.WHATSAPP_DISPATCH_URL || "http://127.0.0.1:9094/dispatch";
const TIME_ZONE = env.WHATSAPP_TIMEZONE || env.MOODLE_TIMEZONE || undefined;
const AUTH_DIR = path.join(MERLIN_HOME, "data/whatsapp-auth");
const MEDIA_DIR = path.join(MERLIN_HOME, "data/whatsapp/media");
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const args = process.argv.slice(2);
const LINK_MODE = args.includes("--link");
const PAIR_NUMBER = args.includes("--pair") ? normalizeNumber(args[args.indexOf("--pair") + 1]) : "";

const log = (...a) => console.error(new Date().toISOString(), "[whatsapp]", ...a);
const logger = pino({ level: env.WHATSAPP_LOG_LEVEL || "warn" });

if (!OWNER && !LINK_MODE) {
  log("WHATSAPP_OWNER not set — idling (set it in .env, see docs/integrations/whatsapp.md)");
}

let sock = null;
let connected = false;
let lastError = null;
let loggedOut = false;
let reconnectDelay = 2000;
const sentIds = new Set(); // ids of messages we sent, so self-chat mode doesn't echo them back
const rememberSent = (id) => {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value);
};

const selfDigits = () => jidDigits(sock?.user?.id);
const ownerJid = () => `${OWNER}@s.whatsapp.net`;
const mode = () => (OWNER && OWNER === selfDigits() ? "self-chat" : "dedicated");

async function resolveSenderPn(key) {
  if (key.remoteJidAlt && !isLidUser(key.remoteJidAlt)) return key.remoteJidAlt;
  if (!isLidUser(key.remoteJid)) return key.remoteJid;
  // Our own LID (self-chat on newer accounts).
  if (sock?.user?.lid && jidDigits(sock.user.lid) === jidDigits(key.remoteJid)) return sock.user.id;
  try {
    return (await sock.signalRepository?.lidMapping?.getPNForLID(key.remoteJid)) || null;
  } catch {
    return null;
  }
}

async function saveMedia(msg, media) {
  const buf = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
  if (buf.length > MAX_MEDIA_BYTES) throw new Error(`media too large (${buf.length} bytes)`);
  const ext = media.filename?.includes(".")
    ? path.extname(media.filename).toLowerCase().replace(/[^.\w]/g, "")
    : `.${(media.mimetype || "application/octet-stream").split("/")[1].split(";")[0].replace(/\W/g, "") || "bin"}`;
  await mkdir(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `${Date.now()}-${msg.key.id.replace(/\W/g, "")}${ext}`);
  await writeFile(file, buf);
  return file;
}

async function dispatch(content, msgId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(DISPATCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, source: "whatsapp", priority: "high", msgId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      log(`dispatch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  return false;
}

async function sendToOwner(message) {
  if (!sock || !connected) throw new Error("WhatsApp not connected");
  if (!OWNER) throw new Error("WHATSAPP_OWNER not set");
  const parts = chunk(toWhatsApp(message));
  for (const text of parts) {
    const sent = await sock.sendMessage(ownerJid(), { text });
    rememberSent(sent?.key?.id);
  }
  sock.sendPresenceUpdate("paused", ownerJid()).catch(() => {});
  return parts.length;
}

async function onMessage(msg) {
  const senderPn = await resolveSenderPn(msg.key);
  if (!shouldAccept({ key: msg.key, selfDigits: selfDigits(), ownerDigits: OWNER, senderPn, sentIds })) return;
  const { text, media, reaction } = extractContent(msg.message);
  if (reaction && !text) return; // reaction removed
  if (!text && !media) return;

  let mediaPath = null;
  if (media && (media.kind === "image" || media.kind === "document")) {
    try { mediaPath = await saveMedia(msg, media); }
    catch (err) { log(`media download failed: ${err.message}`); }
  }
  sock.readMessages([msg.key]).catch(() => {});
  sock.sendPresenceUpdate("composing", ownerJid()).catch(() => {});
  log(`inbound ${media ? `[${media.kind}] ` : ""}${text.slice(0, 80)}`);

  const ok = await dispatch(buildDispatch({ text, media, mediaPath, timeZone: TIME_ZONE }), msg.key.id);
  if (!ok) {
    await sendToOwner("Merlin is offline right now (chat agent unreachable). I'll be back shortly — please resend in a few minutes.").catch(() => {});
  }
}

async function connect() {
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.macOS("Merlin"),
    markOnlineOnConnect: false, // keep phone notifications working for the owner
    syncFullHistory: false,
  });
  sock.ev.on("creds.update", saveCreds);

  if (LINK_MODE && PAIR_NUMBER && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIR_NUMBER);
        console.log(`\nPairing code: ${code}\nWhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead".\n`);
      } catch (err) {
        log(`pairing code request failed: ${err.message}`);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && LINK_MODE && !PAIR_NUMBER) {
      const qrt = require("qrcode-terminal");
      console.log("\nScan with WhatsApp → Settings → Linked devices → Link a device:\n");
      qrt.generate(qr, { small: true });
    } else if (qr && !LINK_MODE) {
      lastError = "not linked — run `node agent/whatsapp-channel/daemon.mjs --link`";
      log(lastError);
    }
    if (connection === "open") {
      connected = true;
      lastError = null;
      reconnectDelay = 2000;
      log(`connected as ${jidNormalizedUser(sock.user.id)} (${mode()} mode, owner ${OWNER || "unset"})`);
      if (LINK_MODE) {
        console.log("Linked. Credentials saved to data/whatsapp-auth/. You can now start Merlin normally.");
        setTimeout(() => process.exit(0), 2000);
      }
    }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      lastError = lastDisconnect?.error?.message || `closed (${code})`;
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone (or banned). Stale creds would loop forever.
        loggedOut = true;
        log("logged out — clearing credentials; relink with --link");
        await rm(AUTH_DIR, { recursive: true, force: true });
        if (LINK_MODE) process.exit(1);
        return;
      }
      if (!OWNER && !LINK_MODE) return;
      log(`connection closed (${lastError}); reconnecting in ${reconnectDelay / 1000}s`);
      setTimeout(() => connect().catch((e) => log(`reconnect failed: ${e.message}`)), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5 * 60 * 1000);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return; // skip history sync / appends
    for (const msg of messages) {
      onMessage(msg).catch((err) => log(`inbound handling failed: ${err.message}`));
    }
  });
}

function startHttp() {
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { connected, me: sock?.user?.id ? jidNormalizedUser(sock.user.id) : null, owner: OWNER || null, mode: sock?.user ? mode() : null, loggedOut, lastError });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      let body = "";
      for await (const c of req) body += c;
      let message;
      try { message = JSON.parse(body).message; } catch { message = body; }
      if (!message || typeof message !== "string") return json(400, { error: "message required" });
      try {
        const parts = await sendToOwner(message);
        return json(200, { ok: true, parts });
      } catch (err) {
        return json(503, { error: err.message });
      }
    }
    json(404, { error: "not found" });
  });
  // Localhost only: anything that can reach this port can message the owner.
  server.listen(PORT, "127.0.0.1", () => log(`HTTP API on 127.0.0.1:${PORT}`));
}

if (!LINK_MODE) startHttp();
if (OWNER || LINK_MODE) {
  connect().catch((err) => {
    lastError = err.message;
    log(`startup failed: ${err.message}`);
    if (LINK_MODE) process.exit(1);
  });
}
