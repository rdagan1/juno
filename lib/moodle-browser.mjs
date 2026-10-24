// moodle-browser — browser-automation layer for the moodle-recordings pipeline.
//
// Moodle has no MCP/API path we can use (institution SSO, no tokens), so we
// drive the same automation Chrome the ops-agent's chrome-devtools MCP uses
// (CDP on :9222, see agent/scripts/chrome-cdp-watch.sh). The user logs in to
// Moodle once in that Chrome profile; we reuse its cookies.
//
// Two operations:
//   scanCourses()  — list recording-like activities on each course page (and
//                    on configured "listing" pages such as Zoom/Panopto/Kaltura
//                    galleries, which often live inside LTI iframes).
//   sniffMedia()   — open a recording page, press play, and capture the media
//                    (HLS/MP4/audio) and caption (VTT/SRT) URLs the player
//                    requests, plus the cookies needed to download them.
//
// The caller passes in a Playwright `chromium` object so this file has no
// hard dependency on where playwright-core is installed.

import crypto from "node:crypto";

export class AuthRequiredError extends Error {
  constructor(url) {
    super(`Moodle session expired (redirected to ${url})`);
    this.code = "AUTH_REQUIRED";
    this.url = url;
  }
}

export class CdpUnavailableError extends Error {
  constructor(cdpUrl, cause) {
    super(`Chrome DevTools not reachable at ${cdpUrl}: ${cause?.message || cause}`);
    this.code = "CDP_UNAVAILABLE";
  }
}

// Activity types that are recordings by construction. Anything else in
// `recording_modules` (url, resource, lti, page, folder) must ALSO match a
// name pattern, otherwise every PDF and link in the course would qualify.
export const VIDEO_MODULES = new Set(["kalvidres", "kalvidpres", "zoom", "videofile", "panopto", "videotime", "echo360"]);

export const DEFAULTS = {
  cdp_url: "http://localhost:9222",
  recording_modules: ["kalvidres", "kalvidpres", "zoom", "videofile", "panopto", "videotime", "echo360", "url", "resource", "lti", "page"],
  name_patterns: ["הקלט", "הרצא", "שיעור", "תרגול", "סרטון", "וידאו", "זום", "recording", "lecture", "video", "zoom", "panopto", "kaltura"],
  login_url_patterns: ["/login/", "/auth/", "saml", "sso", "idp", "adfs", "login.microsoftonline.com"],
  nav_timeout_ms: 45000,
  media_timeout_ms: 45000,
};

const PLAY_SELECTORS = [
  ".vjs-big-play-button",
  ".playkit-pre-playback-play-button",
  ".playkit-control-play-pause",
  "button[aria-label*='Play' i]",
  "button[title*='Play' i]",
  "button[aria-label*='הפעל']",
  "#playButton",
  ".play-button",
  ".ytp-large-play-button",
  "[data-testid='play-button']",
];

export function stableId(prefix, s) {
  return `${prefix}:${crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12)}`;
}

export function isLoginUrl(url, cfg) {
  const u = String(url).toLowerCase();
  return (cfg.login_url_patterns || DEFAULTS.login_url_patterns).some((p) => u.includes(p.toLowerCase()));
}

export function looksLikeRecording({ modtype, name }, cfg) {
  const modules = new Set(cfg.recording_modules || DEFAULTS.recording_modules);
  if (!modules.has(modtype)) return false;
  if (VIDEO_MODULES.has(modtype)) return true;
  const n = String(name || "").toLowerCase();
  return (cfg.name_patterns || DEFAULTS.name_patterns).some((p) => n.includes(p.toLowerCase()));
}

export async function connect(chromium, cfg) {
  const cdpUrl = cfg.cdp_url || DEFAULTS.cdp_url;
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10000 });
  } catch (e) {
    throw new CdpUnavailableError(cdpUrl, e);
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  return { browser, context };
}

async function gotoChecked(page, url, cfg) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.nav_timeout_ms || DEFAULTS.nav_timeout_ms });
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
  if (isLoginUrl(page.url(), cfg)) throw new AuthRequiredError(page.url());
}

// Runs in the page. Collects Moodle course-module links with their module
// type and visible name. Moodle 3.x/4.x both render `/mod/<type>/view.php?id=N`.
function collectActivitiesInPage() {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href*='/mod/'][href*='view.php?id=']")) {
    const m = a.href.match(/\/mod\/([a-z0-9_]+)\/view\.php\?id=(\d+)/i);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    const li = a.closest("li.activity, .activity-item, [data-for='cmitem']");
    const inst = (li || a).querySelector(".instancename, .activityname, [data-activityname]");
    let name = "";
    if (inst) {
      const clone = inst.cloneNode(true);
      clone.querySelectorAll(".accesshide, .sr-only").forEach((n) => n.remove());
      name = clone.textContent;
    } else {
      name = a.textContent;
    }
    const section = a.closest("li.section, .course-section, [data-for='section']");
    const sectionName = section?.querySelector(".sectionname, h3, [data-for='section_title']")?.textContent || "";
    const dateText = (li?.querySelector(".activity-dates, .activity-information, .dimmed_text")?.textContent || "").trim();
    out.push({
      cmid: m[2],
      modtype: m[1].toLowerCase(),
      url: a.href,
      name: name.replace(/\s+/g, " ").trim(),
      section: sectionName.replace(/\s+/g, " ").trim(),
      date_text: dateText.replace(/\s+/g, " ").slice(0, 200),
    });
  }
  return out;
}

function collectLinksInFrame(selector) {
  return [...document.querySelectorAll(selector)].map((a) => ({
    url: a.href,
    name: (a.getAttribute("title") || a.textContent || "").replace(/\s+/g, " ").trim(),
  })).filter((x) => x.url);
}

/** Discover enrolled courses from the dashboard / "My courses" page. */
export async function discoverCourses(context, cfg) {
  const page = await context.newPage();
  try {
    const found = new Map();
    for (const path of ["/my/courses.php", "/my/"]) {
      await gotoChecked(page, new URL(path, cfg.base_url).href, cfg);
      try { await page.waitForSelector("a[href*='/course/view.php?id=']", { timeout: 10000 }); } catch {}
      const links = await page.$$eval("a[href*='/course/view.php?id=']", (as) =>
        as.map((a) => ({ href: a.href, name: (a.querySelector(".multiline, .coursename")?.textContent || a.textContent || "").replace(/\s+/g, " ").trim() })));
      for (const l of links) {
        const id = l.href.match(/[?&]id=(\d+)/)?.[1];
        if (id && !found.has(id) && l.name) found.set(id, { id: Number(id), name: l.name });
      }
      if (found.size) break;
    }
    return [...found.values()];
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Scan every configured course (plus listing pages) for recording items.
 * Returns [{id, course_id, course, name, url, modtype, section, date_text, source}].
 */
export async function scanCourses(context, cfg, log = () => {}) {
  let courses = cfg.courses || [];
  if (cfg.auto_discover_courses || !courses.length) {
    const discovered = await discoverCourses(context, cfg);
    const exclude = new Set((cfg.exclude_courses || []).map(Number));
    const byId = new Map(courses.map((c) => [Number(c.id), c]));
    for (const d of discovered) if (!byId.has(d.id) && !exclude.has(d.id)) byId.set(d.id, d);
    courses = [...byId.values()];
  }
  const host = new URL(cfg.base_url).host;
  const page = await context.newPage();
  const items = [];
  try {
    for (const course of courses) {
      const courseUrl = new URL(`/course/view.php?id=${course.id}`, cfg.base_url).href;
      log(`scan course ${course.id} ${course.name || ""}`);
      await gotoChecked(page, courseUrl, cfg);
      const courseName = course.name || (await page.title()).split(/[|:]/)[0].trim();
      const acts = await page.evaluate(collectActivitiesInPage);
      const listings = [...(course.listings || [])];
      for (const act of acts) {
        if (!looksLikeRecording(act, cfg)) continue;
        // A Zoom activity is a container: the actual recordings live on its
        // recordings tab, one per meeting. Scan that instead of the activity.
        if (act.modtype === "zoom") {
          listings.push({ url: new URL(`/mod/zoom/recordings.php?id=${act.cmid}`, cfg.base_url).href, link_selector: "a[href*='zoom.us/rec/'], a[href*='/mod/zoom/loadrecording.php']", name_prefix: act.name });
          continue;
        }
        items.push({
          id: `${host}:cm:${act.cmid}`,
          course_id: course.id,
          course: courseName,
          name: act.name,
          url: act.url,
          modtype: act.modtype,
          section: act.section,
          date_text: act.date_text,
          source: "course",
        });
      }
      for (const listing of listings) {
        log(`scan listing ${listing.url}`);
        try {
          await gotoChecked(page, listing.url, cfg);
        } catch (e) {
          if (e instanceof AuthRequiredError) throw e;
          log(`listing failed: ${e.message}`);
          continue;
        }
        // LTI tools (Panopto, Kaltura, Echo360) render inside iframes; walk all frames.
        await page.waitForTimeout(listing.settle_ms ?? 3000);
        const selector = listing.link_selector || "a[href*='Viewer.aspx?id='], a[href*='/media/t/'], a[href*='zoom.us/rec/']";
        const seen = new Set();
        for (const frame of page.frames()) {
          let links = [];
          try { links = await frame.evaluate(collectLinksInFrame, selector); } catch { continue; }
          for (const l of links) {
            if (seen.has(l.url)) continue;
            seen.add(l.url);
            items.push({
              id: stableId(`${host}:ext`, l.url.replace(/[#].*$/, "")),
              course_id: course.id,
              course: courseName,
              name: [listing.name_prefix, l.name].filter(Boolean).join(" · ") || l.url,
              url: l.url,
              modtype: "listing",
              section: "",
              date_text: "",
              source: listing.url,
            });
          }
        }
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
  return items;
}

const MEDIA_URL_RE = /\.(m3u8|mp4|m4a|m4v|mp3|aac|webm|mpd)(\?|$)|\/playManifest\/|\/hls\/|\/manifest(\.|\?|$)/i;
const CAPTION_URL_RE = /\.(vtt|srt)(\?|$)|\/caption(s)?\/|captionasset|GetCaptions/i;
const MEDIA_CT_RE = /^(video|audio)\/|mpegurl|dash\+xml/i;
const CAPTION_CT_RE = /text\/vtt|application\/x-subrip/i;

export function classifyMediaResponse(url, contentType) {
  if (/^(blob|data):/.test(url)) return null;
  // Skip HLS/DASH segments; we want the playlist/manifest or a whole file.
  if (/\.(ts|m4s|aac)(\?|$)/i.test(url) && !/\.m3u8/i.test(url)) return null;
  if (CAPTION_CT_RE.test(contentType || "") || CAPTION_URL_RE.test(url)) return "caption";
  if (MEDIA_CT_RE.test(contentType || "") || MEDIA_URL_RE.test(url)) {
    if (/\.(ts|m4s)(\?|$)/i.test(url)) return null;
    return /\.m3u8|mpegurl/i.test(url + (contentType || "")) ? "hls" : /\.mpd|dash/i.test(url + (contentType || "")) ? "dash" : "file";
  }
  return null;
}

/**
 * Open a recording page, try to start playback, and capture media/caption URLs.
 * Returns {page_url, media: [{url, kind}], captions: [{url, text}], headers}.
 */
export async function sniffMedia(context, url, cfg, log = () => {}) {
  const page = await context.newPage();
  const media = [];
  const captionUrls = [];
  const seen = new Set();
  const onResponse = (resp) => {
    const u = resp.url();
    if (seen.has(u)) return;
    const kind = classifyMediaResponse(u, resp.headers()["content-type"]);
    if (!kind) return;
    seen.add(u);
    if (kind === "caption") captionUrls.push(u);
    else media.push({ url: u, kind });
  };
  page.on("response", onResponse);
  try {
    await gotoChecked(page, url, cfg);
    // Moodle "url"/"resource" activities often just link out (or auto-redirect).
    // If the page shows Moodle's "click here to open" workaround link, follow it once.
    const deadline = Date.now() + (cfg.media_timeout_ms || DEFAULTS.media_timeout_ms);
    let clicked = false;
    const outbound = await page.$eval(".urlworkaround a, .resourceworkaround a", (a) => a.href).catch(() => null);
    if (outbound && !media.length) {
      log(`following outbound link ${outbound}`);
      await gotoChecked(page, outbound, cfg);
    }
    while (Date.now() < deadline && !media.length) {
      for (const frame of page.frames()) {
        try {
          const direct = await frame.evaluate(() =>
            [...document.querySelectorAll("video, audio, video source, audio source")]
              .map((v) => v.currentSrc || v.src).filter((s) => s && !s.startsWith("blob:")));
          for (const d of direct) if (!seen.has(d)) { seen.add(d); media.push({ url: d, kind: /\.m3u8/i.test(d) ? "hls" : "file" }); }
          const tracks = await frame.evaluate(() => [...document.querySelectorAll("track[src]")].map((t) => t.src));
          for (const t of tracks) if (!seen.has(t)) { seen.add(t); captionUrls.push(t); }
        } catch {}
        if (!clicked) {
          for (const sel of PLAY_SELECTORS) {
            try {
              const el = await frame.$(sel);
              if (el && (await el.isVisible())) { await el.click({ timeout: 2000 }); clicked = true; log(`clicked ${sel}`); break; }
            } catch {}
          }
        }
      }
      if (!clicked) {
        // Some players autoplay only after any user gesture.
        try { await page.mouse.click(10, 10); } catch {}
      }
      await page.waitForTimeout(1500);
    }
    // Give caption tracks a moment to load once playback starts.
    await page.waitForTimeout(media.length ? 2500 : 0);

    const captions = [];
    for (const cu of captionUrls) {
      try {
        const r = await context.request.get(cu, { headers: { Referer: page.url() }, timeout: 20000 });
        if (r.ok()) captions.push({ url: cu, text: await r.text() });
      } catch {}
    }
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
    const target = media[0]?.url;
    let cookieHeader = "";
    if (target) {
      const cookies = await context.cookies(target);
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    return {
      page_url: page.url(),
      media: rankMedia(media),
      captions,
      headers: { "User-Agent": ua, Referer: page.url(), ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    };
  } finally {
    page.off("response", onResponse);
    await page.close().catch(() => {});
  }
}

// Prefer a master HLS playlist, then whole files, then DASH. Within HLS,
// prefer URLs that look like masters over variant playlists.
export function rankMedia(media) {
  const score = (m) => {
    let s = { hls: 30, file: 20, dash: 10 }[m.kind] || 0;
    if (/master|index\.m3u8|playlist\.m3u8|playManifest/i.test(m.url)) s += 5;
    if (/audio/i.test(m.url)) s += 2;
    return s;
  };
  return [...media].sort((a, b) => score(b) - score(a));
}

/** Cookie/Referer headers for a manually supplied media URL. */
export async function headersFor(context, mediaUrl, referer) {
  const cookies = await context.cookies(mediaUrl);
  return {
    Referer: referer || mediaUrl,
    ...(cookies.length ? { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } : {}),
  };
}
