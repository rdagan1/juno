// lib.mjs — pure helpers for the WhatsApp channel (no socket, no I/O), so
// the message-routing rules are unit-testable without a WhatsApp account.

// "972501234567@s.whatsapp.net" / "972501234567:12@s.whatsapp.net" → "972501234567"
export function jidDigits(jid) {
  if (!jid) return "";
  return String(jid).split("@")[0].split(":")[0].replace(/\D/g, "");
}

export function normalizeNumber(n) {
  return String(n || "").replace(/\D/g, "");
}

export const isLid = (jid) => String(jid || "").endsWith("@lid");
export const isGroupOrBroadcast = (jid) => /@(g\.us|broadcast|newsletter)$/.test(String(jid || ""));

// WhatsApp wraps content in several envelopes (disappearing messages,
// view-once, documents with captions). Peel them to the inner message.
export function unwrapMessage(m) {
  let cur = m;
  for (let i = 0; i < 5 && cur; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message ||
      cur.editedMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur || {};
}

// Returns { text, media } where media is null or { kind, mimetype, filename }.
export function extractContent(message) {
  const m = unwrapMessage(message);
  if (m.conversation) return { text: m.conversation, media: null };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, media: null };
  if (m.imageMessage) return { text: m.imageMessage.caption || "", media: { kind: "image", mimetype: m.imageMessage.mimetype } };
  if (m.documentMessage) {
    return { text: m.documentMessage.caption || "", media: { kind: "document", mimetype: m.documentMessage.mimetype, filename: m.documentMessage.fileName } };
  }
  if (m.audioMessage) return { text: "", media: { kind: m.audioMessage.ptt ? "voice" : "audio", mimetype: m.audioMessage.mimetype } };
  if (m.videoMessage) return { text: m.videoMessage.caption || "", media: { kind: "video", mimetype: m.videoMessage.mimetype } };
  if (m.reactionMessage) return { text: m.reactionMessage.text || "", media: null, reaction: true };
  return { text: "", media: null };
}

// Decide whether an incoming message should reach the agent.
//
// Two setups are supported:
//   - dedicated number: the agent is linked to its own WhatsApp account and
//     the owner chats with it like any contact. Accept only non-fromMe
//     messages whose sender resolves to the owner's number.
//   - self-chat: the agent is linked to the owner's own account and the owner
//     uses WhatsApp's "Message yourself" chat. Accept fromMe messages in the
//     self chat, except the ones the agent itself just sent (sentIds).
//
// `senderPn` is the sender's phone-number JID if already resolved (from
// key.remoteJidAlt or the LID mapping); the caller does the async lookup.
export function shouldAccept({ key, selfDigits, ownerDigits, senderPn, sentIds }) {
  if (!key?.remoteJid || isGroupOrBroadcast(key.remoteJid)) return false;
  if (key.id && sentIds?.has(key.id)) return false;
  const chatDigits = jidDigits(senderPn || key.remoteJid);
  const selfChat = ownerDigits === selfDigits;
  if (selfChat) return !!key.fromMe && chatDigits === selfDigits;
  return !key.fromMe && chatDigits === ownerDigits;
}

// Markdown → WhatsApp formatting (*bold*, _italic_, ~strike~, ```mono```).
export function toWhatsApp(md) {
  return String(md)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

// Split long text on paragraph/line boundaries so each WhatsApp bubble
// stays readable. WhatsApp's hard limit is far higher; this is for phones.
export function chunk(text, max = 3500) {
  const out = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function buildDispatch({ text, media, mediaPath, timeZone, now = new Date() }) {
  let when = "";
  try {
    when = now.toLocaleString("en-US", {
      timeZone: timeZone || undefined, weekday: "long", year: "numeric", month: "long",
      day: "numeric", hour: "numeric", minute: "2-digit", hour12: false, timeZoneName: "short",
    });
  } catch {
    when = now.toISOString();
  }
  const lines = ["New WhatsApp message from the user:", ""];
  if (text) lines.push(text, "");
  if (media) {
    if (mediaPath) lines.push(`[Attached ${media.kind}${media.filename ? ` "${media.filename}"` : ""} saved at ${mediaPath} — use Read to view it]`, "");
    else lines.push(`[The user sent a ${media.kind} message that could not be processed — ask them to send it as text]`, "");
  }
  lines.push(`[Current time: ${when}]`);
  lines.push("[Reply ONLY via the mcp__whatsapp__reply tool — plain text is not delivered]");
  return lines.join("\n");
}
