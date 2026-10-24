// client.mjs — thin Moodle Web Services (REST) client.
//
// Talks to the same API the official Moodle mobile app uses:
//   POST <site>/webservice/rest/server.php  (wstoken + wsfunction + params)
//   POST <site>/login/token.php             (username/password → token)
//   GET  <site>/webservice/pluginfile.php/… (file downloads, ?token=…)
//
// Auth precedence: MOODLE_TOKEN if set, else exchange MOODLE_USERNAME +
// MOODLE_PASSWORD for a token on first use (kept in memory only). SSO sites
// can't do the password exchange — see docs/integrations/moodle.md for how
// to obtain a token there.

export class MoodleError extends Error {
  constructor(message, { errorcode, exception } = {}) {
    super(message);
    this.name = "MoodleError";
    this.errorcode = errorcode;
    this.exception = exception;
  }
}

// Moodle's REST layer expects PHP-style form encoding for nested params:
//   { courseids: [3, 7] }                 → courseids[0]=3&courseids[1]=7
//   { options: [{ name: "x", value: 1 }]} → options[0][name]=x&options[0][value]=1
export function encodeParams(params, prefix = "", out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") encodeParams(value, name, out);
    else if (typeof value === "boolean") out.append(name, value ? "1" : "0");
    else out.append(name, String(value));
  }
  return out;
}

export function createMoodleClient({
  url,
  token,
  username,
  password,
  service = "moodle_mobile_app",
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  if (!url) throw new MoodleError("MOODLE_URL is not set");
  const base = url.replace(/\/+$/, "");
  let cachedToken = token || null;
  let siteInfo = null;

  async function post(path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new MoodleError(`HTTP ${res.status} from ${path}`);
    return res.json();
  }

  async function getToken() {
    if (cachedToken) return cachedToken;
    if (!username || !password) {
      throw new MoodleError(
        "No Moodle credentials: set MOODLE_TOKEN, or MOODLE_USERNAME + MOODLE_PASSWORD",
      );
    }
    const data = await post("/login/token.php", encodeParams({ username, password, service }));
    if (!data.token) {
      throw new MoodleError(`Login failed: ${data.error || "no token returned"}`, data);
    }
    cachedToken = data.token;
    return cachedToken;
  }

  async function call(wsfunction, params = {}) {
    const wstoken = await getToken();
    const body = encodeParams({ wstoken, wsfunction, moodlewsrestformat: "json", ...params });
    const data = await post("/webservice/rest/server.php", body);
    if (data && typeof data === "object" && data.exception) {
      throw new MoodleError(`${wsfunction}: ${data.message || data.errorcode}`, data);
    }
    return data;
  }

  async function getSiteInfo() {
    if (!siteInfo) siteInfo = await call("core_webservice_get_site_info");
    return siteInfo;
  }

  // File URLs returned by the API (course contents, intro attachments, forum
  // attachments) point at pluginfile.php. Only the /webservice/ variant
  // accepts a token, so rewrite and append it.
  async function fileUrl(raw) {
    const u = new URL(raw, base);
    if (new URL(base).host !== u.host) {
      throw new MoodleError(`Refusing to send Moodle token to foreign host ${u.host}`);
    }
    if (u.pathname.includes("/pluginfile.php/") && !u.pathname.includes("/webservice/pluginfile.php/")) {
      u.pathname = u.pathname.replace("/pluginfile.php/", "/webservice/pluginfile.php/");
    }
    u.searchParams.set("token", await getToken());
    return u;
  }

  async function download(raw) {
    const u = await fileUrl(raw);
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs * 4) });
    if (!res.ok) throw new MoodleError(`HTTP ${res.status} downloading file`);
    const contentType = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    // Moodle answers a bad/expired token on pluginfile with a JSON error body.
    if (contentType.includes("application/json") && buf.length < 4096) {
      try {
        const j = JSON.parse(buf.toString("utf8"));
        if (j.error || j.exception) throw new MoodleError(`File download: ${j.error || j.message}`, j);
      } catch (err) {
        if (err instanceof MoodleError) throw err;
      }
    }
    return { buffer: buf, contentType };
  }

  return { base, call, getSiteInfo, download, getToken };
}

// Build a client from the standard MOODLE_* env vars (after .env is loaded).
export function clientFromEnv(env = process.env) {
  return createMoodleClient({
    url: env.MOODLE_URL,
    token: env.MOODLE_TOKEN,
    username: env.MOODLE_USERNAME,
    password: env.MOODLE_PASSWORD,
    service: env.MOODLE_SERVICE || undefined,
  });
}
