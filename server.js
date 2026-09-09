import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import session from "express-session";
import { formatReceipt, receiptSiteUrl } from "./public/description-format.js";

const required = ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "HIGH_PARK_SEGMENT_ID"];
const configError = required.filter((name) => !process.env[name]).join(", ");
const app = express();
const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
const canonicalUrl = new URL(baseUrl);
const renderHost = process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).host : null;
const publicSiteHost = receiptSiteUrl.replace(/^www\./, "");
// Older activity receipts used the former Render hostname. Build it from parts
// so those receipts are still replaced without publishing that legacy address.
const legacyReceiptHost = ["lapped", ["onrender", "com"].join(".")].join(".");
const segmentId = String(process.env.HIGH_PARK_SEGMENT_ID || "");
const lapStatsEnabled = true;
const dataDir = process.env.DATA_DIR || new URL("./data", import.meta.url).pathname;
const tokenStore = path.join(dataDir, "tokens.json");
const lapStatsStore = path.join(dataDir, "lap-stats.json");
const receiptOptionsStore = path.join(dataDir, "receipt-options.json");
const defaultReceiptOptions = Object.freeze({ lapCount: true, fastestLap: true, lifetimeLaps: false, ytdLaps: false });
const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY
  ? crypto.createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY).digest()
  : null;
const sessionSecret = process.env.SESSION_SECRET || "change-me-before-production";
// A short-lived server-side record keeps OAuth safe if a privacy extension strips
// the session cookie during Strava's cross-site return.
const pendingOAuthStates = new Map();
// Hash of the original Lapped owner's Strava athlete ID. Render can override
// this with ADMIN_ATHLETE_ID without placing a personal ID in source control.
const defaultAdminAthleteHash = "cbed8490189459b6fb84700492174b34db9035e0cc8461fc5bf43a4fc1ecf4af";
const adminCookieName = "lapped_admin";
const adminCookieLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const oauthWindowMs = 10 * 60 * 1000;
const oauthRequestsByIp = new Map();

// Render terminates TLS before forwarding requests to this process. Trust that
// single proxy so secure session cookies are issued to the browser correctly.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.set({
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin"
  });
  next();
});
app.use(express.json());
app.use(session({
  name: "lapped_session",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(process.env.RENDER_EXTERNAL_URL) || process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));
// The Render service address is kept only for infrastructure compatibility.
// Visitors always land on the owned Lapped domain. Webhooks stay reachable on
// their registered callback while Strava's dashboard is being migrated.
app.use((req, res, next) => {
  if (renderHost && req.hostname === renderHost && !req.path.startsWith("/webhook")) {
    return res.redirect(308, new URL(req.originalUrl, canonicalUrl).toString());
  }
  next();
});
app.use(express.static("public"));

const strava = async (path, options = {}) => {
  const response = await fetch(`https://www.strava.com/api/v3${path}`, options);
  if (!response.ok) {
    const error = new Error(`Strava returned ${response.status}: ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

async function readTokens() {
  return readEncryptedStore(tokenStore);
}

async function readEncryptedStore(storePath) {
  try {
    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    if (!stored?.ciphertext) return stored; // Supports a one-time migration from local development data.
    if (!tokenEncryptionKey) throw new Error("TOKEN_ENCRYPTION_KEY is required to read encrypted tokens.");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      tokenEncryptionKey,
      Buffer.from(stored.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(stored.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeEncryptedStore(storePath, value) {
  await fs.mkdir(dataDir, { recursive: true });
  if (!tokenEncryptionKey) return fs.writeFile(storePath, JSON.stringify(value, null, 2));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  await fs.writeFile(storePath, JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  }));
}

async function saveToken(token) {
  if (!token.athlete?.id) return;
  const tokens = await readTokens();
  tokens[token.athlete.id] = token;
  return writeEncryptedStore(tokenStore, tokens);
}

function normalizeReceiptOptions(value = {}) {
  return Object.fromEntries(Object.keys(defaultReceiptOptions).map((key) => [key, Boolean(value[key] ?? defaultReceiptOptions[key])]));
}

async function receiptOptionsFor(athleteId) {
  const options = await readEncryptedStore(receiptOptionsStore);
  return normalizeReceiptOptions(options[athleteId]);
}

async function saveReceiptOptions(athleteId, value) {
  const options = await readEncryptedStore(receiptOptionsStore);
  const normalized = normalizeReceiptOptions(value);
  options[athleteId] = normalized;
  await writeEncryptedStore(receiptOptionsStore, options);
  return normalized;
}

async function removeConnectedAthlete(athleteId) {
  if (!athleteId) return;
  const tokens = await readTokens();
  delete tokens[athleteId];
  await writeEncryptedStore(tokenStore, tokens);
  const options = await readEncryptedStore(receiptOptionsStore);
  delete options[athleteId];
  await writeEncryptedStore(receiptOptionsStore, options);
  await clearLapStats(athleteId);
}

async function athleteIsStillConnected(athleteId) {
  if (!athleteId) return false;
  const tokens = await readTokens();
  return Boolean(tokens[athleteId]);
}

async function readLapStats() {
  return readEncryptedStore(lapStatsStore);
}

async function clearLapStats(athleteId) {
  if (!athleteId) return;
  const stats = await readLapStats();
  if (!stats[athleteId]) return;
  delete stats[athleteId];
  await writeEncryptedStore(lapStatsStore, stats);
}

async function activityWasProcessed(athleteId, activityId) {
  if (!athleteId || !activityId) return false;
  const stats = await readLapStats();
  return Boolean(stats.__processed?.[athleteId]?.[activityId]);
}

async function markActivityProcessed(athleteId, activityId) {
  if (!athleteId || !activityId) return;
  const stats = await readLapStats();
  stats.__processed ||= {};
  stats.__processed[athleteId] ||= {};
  stats.__processed[athleteId][activityId] = Date.now();
  await writeEncryptedStore(lapStatsStore, stats);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function isAdminAthlete(athleteId) {
  const candidate = String(athleteId || "");
  const configuredOwnerId = String(process.env.ADMIN_ATHLETE_ID || "");
  return (configuredOwnerId && candidate === configuredOwnerId)
    || crypto.createHash("sha256").update(candidate).digest("hex") === defaultAdminAthleteHash;
}

function signAdminCookie(payload) {
  return crypto.createHmac("sha256", sessionSecret).update(payload).digest("hex");
}

function hasValidAdminCookie(req) {
  const encoded = req.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${adminCookieName}=`))?.slice(adminCookieName.length + 1);
  if (!encoded) return false;
  const [athleteId, expiresAt, signature] = decodeURIComponent(encoded).split(".");
  const payload = `${athleteId}.${expiresAt}`;
  const expected = signAdminCookie(payload);
  if (!athleteId || !Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now() || !signature || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) && isAdminAthlete(athleteId);
}

function setAdminCookie(res, athleteId) {
  const expiresAt = Date.now() + adminCookieLifetimeMs;
  const payload = `${athleteId}.${expiresAt}`;
  res.cookie(adminCookieName, `${payload}.${signAdminCookie(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(process.env.RENDER_EXTERNAL_URL) || process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: adminCookieLifetimeMs
  });
}

function adminPage(athletes) {
  const rows = athletes.map((athlete) => {
    const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || "Unnamed athlete";
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(athlete.id)}</td><td>connected</td></tr>`;
  }).join("") || `<tr><td colspan="3">No connected athletes yet.</td></tr>`;
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lapped — Admin</title><style>
    :root{color-scheme:dark;--paper:#191a18;--ink:#f2eee7;--muted:#aaa69e;--line:#3c3c38;--accent:#fc4c02}html[data-theme="light"]{color-scheme:light;--paper:#f3f0ea;--ink:#20201e;--muted:#6f6b65;--line:#cbc7bf;--accent:#fc4c02}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Arial,Helvetica,sans-serif;padding:32px;min-height:100vh;transition:background .25s,color .25s}.wrap{max-width:860px;margin:0 auto}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:86px}.brand{color:var(--ink);text-decoration:none;font-weight:700;font-size:22px;letter-spacing:-.07em}.right{display:flex;gap:12px;align-items:center}.tag,.theme-label{color:var(--muted);font-size:12px}.toggle{display:block;width:30px;height:18px;cursor:pointer}.toggle input{position:absolute;opacity:0;pointer-events:none}.track{display:block;position:relative;width:30px;height:18px;border:1px solid var(--muted);border-radius:99px}.track i{position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--ink);transition:transform .2s}.toggle input:checked+.track i{transform:translateX(12px)}.count{font-family:Georgia,"Times New Roman",serif;font-size:clamp(74px,15vw,156px);line-height:.8;letter-spacing:-.08em;margin:0 0 64px}.count span{display:block;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:400;letter-spacing:0;color:var(--muted);margin:52px 0 0}.panel{border-top:1px solid var(--ink);padding-top:18px}.panel-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px}.panel h2{font-size:15px;margin:0;font-weight:500}.panel p{margin:0;color:var(--muted);font-size:12px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:15px 0;border-top:1px solid var(--line)}th{color:var(--muted);font-size:11px;font-weight:400}td:last-child{text-align:right;color:var(--accent)}@media(max-width:600px){body{padding:20px}.top{margin-bottom:64px}.tag{display:none}.count{font-size:96px;margin-bottom:64px}.panel-head{display:block}.panel-head p{margin-top:8px}}
  </style></head><body><main class="wrap"><nav class="top"><a class="brand" href="/">Lapped</a><div class="right"><span class="tag">private admin</span><span class="theme-label" id="theme-label">Light mode</span><label class="toggle"><input id="theme-toggle" type="checkbox" aria-label="Use light mode"><span class="track"><i></i></span></label></div></nav><p class="count">${athletes.length}<span>connected athletes</span></p><section class="panel"><div class="panel-head"><h2>People connected to Lapped</h2><p>Only visible to the owner Strava account.</p></div><table><thead><tr><th>athlete</th><th>Strava ID</th><th>status</th></tr></thead><tbody>${rows}</tbody></table></section></main><script>const toggle=document.querySelector('#theme-toggle'),label=document.querySelector('#theme-label'),root=document.documentElement;function setTheme(theme){root.dataset.theme=theme;toggle.checked=theme==='light';label.textContent=theme==='light'?'Light mode':'Dark mode'}setTheme(localStorage.getItem('lapped-theme')==='dark'?'dark':'light');toggle.onchange=()=>{const theme=toggle.checked?'light':'dark';setTheme(theme);localStorage.setItem('lapped-theme',theme)};</script></body></html>`;
}

async function requireAdmin(req, res, next) {
  try {
    if (hasValidAdminCookie(req)) {
      req.connectedTokens = await readTokens();
      return next();
    }
    if (!req.session.strava) {
      req.session.returnTo = "/admin";
      return res.redirect("/auth/strava");
    }
    const sessionAthleteId = String(req.session.strava.athlete?.id || "");
    if (!isAdminAthlete(sessionAthleteId)) return res.status(403).send("Admin access is not available for this Strava account.");
    setAdminCookie(res, sessionAthleteId);
    const tokens = await readTokens();
    req.connectedTokens = tokens;
    next();
  } catch (error) { next(error); }
}

async function accessToken(req) {
  const token = req.session.strava;
  if (!token) throw new Error("Connect Strava first.");
  if (token.expires_at > Math.floor(Date.now() / 1000) + 60) return token.access_token;
  const refreshed = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: token.refresh_token })
  });
  if (!refreshed.ok) throw new Error("Could not refresh the Strava connection.");
  const refreshedToken = await refreshed.json();
  refreshedToken.athlete = token.athlete;
  Object.assign(req.session, { strava: refreshedToken });
  await saveToken(req.session.strava);
  return req.session.strava.access_token;
}

async function tokenForAthlete(athleteId) {
  const token = (await readTokens())[athleteId];
  if (!token) throw new Error("No connected athlete found for this event.");
  if (token.expires_at > Math.floor(Date.now() / 1000) + 60) return token.access_token;
  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: token.refresh_token })
  });
  if (!response.ok) throw new Error("Could not refresh an athlete's Strava connection.");
  const refreshed = await response.json();
  refreshed.athlete = token.athlete;
  await saveToken(refreshed);
  return refreshed.access_token;
}

const lapStatsCacheMs = 24 * 60 * 60 * 1000;

function stravaHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function countSegmentEfforts(token, start, end) {
  const pageSize = 200;
  const seenEfforts = new Set();
  let total = 0;
  // Strava may return a short page before the last page, so keep paginating
  // until it explicitly returns an empty page rather than trusting page length.
  for (let page = 1; page <= 20; page += 1) {
    const params = new URLSearchParams({
      segment_id: segmentId,
      start_date_local: start.toISOString(),
      end_date_local: end.toISOString(),
      page: String(page),
      per_page: String(pageSize)
    });
    const efforts = await strava(`/segment_efforts?${params}`, stravaHeaders(token));
    if (!efforts.length) return total;
    const freshEfforts = efforts.filter((effort) => !seenEfforts.has(String(effort.id)));
    // Some Strava responses repeat the first page instead of advancing. Split
    // the range in that case so no efforts are skipped or counted twice.
    if (!freshEfforts.length) {
      if (end - start <= 24 * 60 * 60 * 1000) return total;
      const middle = new Date(start.getTime() + Math.floor((end - start) / 2));
      const [firstHalf, secondHalf] = await Promise.all([
        countSegmentEfforts(token, start, middle),
        countSegmentEfforts(token, middle, end)
      ]);
      return firstHalf + secondHalf;
    }
    freshEfforts.forEach((effort) => seenEfforts.add(String(effort.id)));
    total += freshEfforts.length;
  }
  throw new Error("Strava segment effort pagination exceeded its safe limit.");
}

async function getLapStats(token, athleteId, { includeYtd = false } = {}) {
  const stats = await readLapStats();
  const cached = stats[athleteId];
  if (cached?.version === 5 && (!includeYtd || cached.hasYtd)) {
    if (cached.rateLimited && Date.now() < cached.retryAt) return cached;
    if (!cached.rateLimited && Date.now() - cached.checkedAt < lapStatsCacheMs) return cached.available ? cached : null;
  }

  try {
    const segment = await strava(`/segments/${segmentId}`, stravaHeaders(token));
    const lifetime = Number(segment.athlete_segment_stats?.effort_count);
    if (!Number.isFinite(lifetime)) throw new Error("Strava returned 403: segment history unavailable");
    const now = new Date();
    const year = now.getUTCFullYear();
    let ytd = null;
    if (!includeYtd) {
      const result = { available: true, lifetime, ytd, year, hasYtd: false, checkedAt: Date.now(), version: 5 };
      stats[athleteId] = result;
      await writeEncryptedStore(lapStatsStore, stats);
      return result;
    }
    try {
      ytd = await countSegmentEfforts(token, new Date(Date.UTC(year, 0, 1)), now);
    } catch (error) {
      if (error.status !== 429) throw error;
      const retryAt = (Math.floor(Date.now() / (15 * 60 * 1000)) + 1) * 15 * 60 * 1000 + 1000;
      const result = { available: true, lifetime, ytd: null, year, hasYtd: false, rateLimited: true, retryAt, checkedAt: Date.now(), version: 5 };
      stats[athleteId] = result;
      await writeEncryptedStore(lapStatsStore, stats);
      return result;
    }
    const result = { available: true, lifetime, ytd, year, hasYtd: true, checkedAt: Date.now(), version: 5 };
    stats[athleteId] = result;
    await writeEncryptedStore(lapStatsStore, stats);
    return result;
  } catch (error) {
    if (!/Strava returned (?:401|403|404)/.test(error.message)) throw error;
    stats[athleteId] = { available: false, checkedAt: Date.now(), version: 5 };
    await writeEncryptedStore(lapStatsStore, stats);
    return null;
  }
}

function isTargetEffort(effort) {
  return String(effort.segment?.id ?? effort.segment_id ?? "") === segmentId;
}

function formatFastestLap(efforts) {
  const fastest = efforts
    .filter((effort) => Number(effort.elapsed_time) > 0)
    .sort((a, b) => Number(a.elapsed_time) - Number(b.elapsed_time))[0];
  if (!fastest) return null;
  const seconds = Math.round(Number(fastest.elapsed_time));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  const speedMs = Number(fastest.average_speed) || Number(fastest.distance) / seconds;
  const speedKmh = (speedMs * 3.6).toFixed(1);
  return `${minutes}:${remainder} · ${speedKmh} km/h`;
}

function hasLappedReceipt(description) {
  const receiptLine = "(?:laps:\\s*\\d+|fastest lap:[^\\r\\n]+|lifetime laps:\\s*\\d+|\\d{4} laps:\\s*\\d+)";
  const receiptSite = "(?:https?:\\/\\/)?(?:www\\.)?(?:lapped\\.fit|lapped\\.onrender\\.com)";
  return new RegExp(`(?:^|\\r?\\n)(?:${receiptLine})(?:\\r?\\n[^\\r\\n]+){0,4}\\r?\\n${receiptSite}(?=\\r?\\n|$)|(?:^|\\r?\\n)high park laps:\\s*\\d+(?=\\r?\\n|$)`, "i").test(String(description || ""));
}

async function scanActivity(req, activityId) {
  const token = await accessToken(req);
  return scanActivityWithToken(token, activityId, req.session.strava.athlete?.id);
}
async function scanActivityWithToken(token, activityId, athleteId) {
  const activity = await strava(`/activities/${activityId}?include_all_efforts=true`, { headers: { Authorization: `Bearer ${token}` } });
  const targetEfforts = (activity.segment_efforts || []).filter(isTargetEffort);
  const lapCount = targetEfforts.length;
  if (await activityWasProcessed(athleteId, activityId)) {
    return { lapCount, changed: false, description: activity.description ?? "" };
  }
  if (hasLappedReceipt(activity.description)) {
    return { lapCount, changed: false, description: activity.description ?? "" };
  }
  if (!lapCount) return { lapCount: 0, changed: false, description: activity.description ?? "" };

  const receiptOptions = await receiptOptionsFor(athleteId);
  if (!Object.values(receiptOptions).some(Boolean)) return { lapCount, changed: false, description: activity.description ?? "" };
  let lapStats = null;
  if (lapStatsEnabled && (receiptOptions.lifetimeLaps || receiptOptions.ytdLaps)) {
    try {
      lapStats = await Promise.race([
        getLapStats(token, athleteId, { includeYtd: receiptOptions.ytdLaps }),
        new Promise((resolve) => setTimeout(() => resolve(null), 10000))
      ]);
    } catch (error) {
      console.error("Lap stats lookup failed:", error.message);
    }
  }
  const fastestLap = formatFastestLap(targetEfforts);
  const stamp = formatReceipt({
    lapCount: receiptOptions.lapCount ? lapCount : null,
    fastestLap: receiptOptions.fastestLap ? fastestLap : null,
    lifetimeLaps: receiptOptions.lifetimeLaps ? lapStats?.lifetime : null,
    ytdLaps: receiptOptions.ytdLaps ? lapStats?.ytd : null,
    ytdYear: receiptOptions.ytdLaps ? lapStats?.year : null,
    options: receiptOptions
  });
  // Do not overwrite the user's writing. The app replaces only its own stamp,
  // including the older High Park laps format already written to past rides.
  const existing = (activity.description || "")
    .replace(/(?:^|\n)High Park laps: \d+(?=\n|$)/g, "")
    .replace(new RegExp(`(?:^|\\n)Loops: \\d+(?:\\n(?:https:\\/\\/)?${legacyReceiptHost.replace(/\\./g, "\\\\.")})?(?=\\n|$)`, "gi"), "")
    .replace(new RegExp(`(?:^|\\n)Laps: \\d+(?:\\nfastest lap: [^\\n]+)?(?:\\n(?:https:\\/\\/)?(?:(?:www\\.)?${legacyReceiptHost.replace(/\\./g, "\\\\.")}|(?:www\\.)?${publicSiteHost.replace(/\\./g, "\\\\.")}))?(?=\\n|$)`, "gi"), "")
    .replace(new RegExp(`(?:^|\\n)L O O P S : \\d+(?:\\n${legacyReceiptHost.replace(/\\./g, "\\\\.")})?(?=\\n|$)`, "g"), "")
    .trim();
  const description = [existing, stamp].filter(Boolean).join("\n");
  // Strava also emits an update event for our own description write. Do not
  // write an identical value back and accidentally create a webhook loop.
  if (description === (activity.description ?? "")) return { lapCount, changed: false, description };
  // A disconnect can race an already received webhook. Check immediately
  // before writing so a removed connection cannot modify another activity.
  if (!(await athleteIsStillConnected(athleteId))) return { lapCount, changed: false, description: activity.description ?? "" };
  await strava(`/activities/${activityId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ description })
  });
  await markActivityProcessed(athleteId, activityId);
  await clearLapStats(athleteId);
  return { lapCount, changed: true, description };
}

app.get("/auth/strava", (req, res) => {
  if (configError) return res.status(503).send(`Missing configuration: ${configError}`);
  const now = Date.now();
  const ip = req.ip || "unknown";
  const recentRequests = (oauthRequestsByIp.get(ip) || []).filter((time) => now - time < oauthWindowMs);
  if (recentRequests.length >= 12) return res.status(429).send("Please wait a few minutes before trying Strava again.");
  recentRequests.push(now);
  oauthRequestsByIp.set(ip, recentRequests);
  for (const [state, issuedAt] of pendingOAuthStates) {
    if (now - issuedAt >= oauthWindowMs) pendingOAuthStates.delete(state);
  }
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  pendingOAuthStates.set(state, Date.now());
  const url = new URL("https://www.strava.com/oauth/authorize");
  url.search = new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, redirect_uri: `${baseUrl}/auth/strava/complete`, response_type: "code", approval_prompt: "auto", scope: "activity:read_all,activity:write", state });
  res.redirect(url);
});

app.get("/auth/strava/complete", async (req, res, next) => {
  try {
    const state = String(req.query.state || "");
    const issuedAt = pendingOAuthStates.get(state);
    const sessionMatches = state && req.session.oauthState === state;
    const recentServerState = Number.isFinite(issuedAt) && Date.now() - issuedAt < 10 * 60 * 1000;
    if (!req.query.code || (!sessionMatches && !recentServerState)) throw new Error("Invalid OAuth state.");
    pendingOAuthStates.delete(state);
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, code: req.query.code, grant_type: "authorization_code" })
    });
    if (!response.ok) throw new Error("Strava did not authorize the app.");
    req.session.strava = await response.json();
    await saveToken(req.session.strava);
    delete req.session.oauthState;
    const returnTo = req.session.returnTo || "/?connected=1";
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (error) { next(error); }
});

app.get("/api/status", (req, res) => res.json({ connected: Boolean(req.session.strava), athlete: req.session.strava?.athlete || null, configured: !configError, segmentId: segmentId || null, lapStatsEnabled }));
app.get("/api/receipt-options", async (req, res, next) => {
  try {
    if (!req.session.strava?.athlete?.id) return res.status(401).json({ error: "Connect Strava first." });
    res.json(await receiptOptionsFor(req.session.strava.athlete.id));
  } catch (error) { next(error); }
});
app.put("/api/receipt-options", async (req, res, next) => {
  try {
    if (!req.session.strava?.athlete?.id) return res.status(401).json({ error: "Connect Strava first." });
    res.json(await saveReceiptOptions(req.session.strava.athlete.id, req.body));
  } catch (error) { next(error); }
});
app.get("/api/lap-stats", async (req, res, next) => {
  try {
    if (!lapStatsEnabled) return res.json({ available: false, enabled: false });
    if (!req.session.strava) return res.status(401).json({ available: false });
    const token = await accessToken(req);
    const athleteId = req.session.strava.athlete?.id;
    const options = await receiptOptionsFor(athleteId);
    if (!options.lifetimeLaps && !options.ytdLaps) return res.json({ available: false, enabled: false });
    const stats = await getLapStats(token, athleteId, { includeYtd: options.ytdLaps });
    res.json(stats || { available: false });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ available: false, rateLimited: true });
    next(error);
  }
});
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.get("/admin", requireAdmin, (req, res) => {
  const athletes = Object.values(req.connectedTokens).map((token) => token.athlete || {});
  res.type("html").send(adminPage(athletes));
});
app.post("/api/activities/:id/scan", async (req, res, next) => {
  try { res.json(await scanActivity(req, req.params.id)); } catch (error) { next(error); }
});
app.post("/auth/disconnect", async (req, res, next) => {
  try {
    const athleteId = req.session.strava?.athlete?.id;
    const accessTokenValue = req.session.strava?.access_token;
    // Remove Lapped's persisted token before contacting Strava. This guarantees
    // webhooks cannot update future activities even if the remote revocation is slow.
    await removeConnectedAthlete(athleteId);
    if (accessTokenValue) {
      await fetch("https://www.strava.com/oauth/deauthorize", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessTokenValue}` }
      }).catch(() => {});
    }
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("lapped_session");
      res.status(204).end();
    });
  } catch (error) { next(error); }
});
// Register this public URL in the Strava developer dashboard as the webhook callback.
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.STRAVA_VERIFY_TOKEN) {
    return res.json({ "hub.challenge": req.query["hub.challenge"] });
  }
  res.sendStatus(403);
});
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // acknowledge fast; Strava retries slow callbacks.
  const event = req.body;
  if (event.object_type !== "activity" || !["create", "update"].includes(event.aspect_type)) return;
  tokenForAthlete(event.owner_id)
    .then((token) => scanActivityWithToken(token, event.object_id, event.owner_id))
    .catch((error) => console.error("Webhook scan failed:", error.message));
});
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || "Something went wrong." }));
app.listen(process.env.PORT || 3000, process.env.HOST || (process.env.RENDER_EXTERNAL_URL ? "0.0.0.0" : "127.0.0.1"), () => console.log(`Lapped running at ${baseUrl}`));
