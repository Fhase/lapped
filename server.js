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
const lapStatsEnabled = false;
const dataDir = process.env.DATA_DIR || new URL("./data", import.meta.url).pathname;
const tokenStore = path.join(dataDir, "tokens.json");
const lapStatsStore = path.join(dataDir, "lap-stats.json");
const analyticsStore = path.join(dataDir, "analytics.json");
const featureRequestsStore = path.join(dataDir, "feature-requests.json");
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
const featureRequestWindowMs = 60 * 60 * 1000;
const featureRequestSubmissions = new Map();
// Strava can announce a freshly uploaded activity before its segment efforts
// have finished processing. Keep one short, in-memory retry per activity so an
// import is not missed, without doubling scans for title edits or every webhook.
const processingRetryDelayMs = 2 * 60 * 1000;
const processingRetries = new Map();
const rankingCacheMs = 15 * 60 * 1000;
let connectionRankingCache = null;

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
function cookieValue(req, name) {
  return req.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function visitorIdFor(req, res) {
  const existing = cookieValue(req, "lapped_visitor");
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const visitorId = crypto.randomBytes(16).toString("hex");
  res.cookie("lapped_visitor", visitorId, {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(process.env.RENDER_EXTERNAL_URL) || process.env.NODE_ENV === "production",
    maxAge: 90 * 24 * 60 * 60 * 1000
  });
  return visitorId;
}

async function recordAnalyticsEvent(visitorId, event) {
  if (!visitorId) return;
  const analytics = await readEncryptedStore(analyticsStore);
  const now = new Date().toISOString();
  const visitor = analytics[visitorId] || { firstSeen: now, visits: 0, connectStarted: false, connected: false };
  visitor.lastSeen = now;
  if (event === "visit") {
    visitor.visits += 1;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const hour = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hourCycle: "h23" }).format(new Date());
    visitor.days ||= {};
    visitor.days[day] ||= { visits: 0, hours: {} };
    visitor.days[day].visits += 1;
    visitor.days[day].hours[hour] = (visitor.days[day].hours[hour] || 0) + 1;
  }
  if (event === "connect") visitor.connectStarted = true;
  if (event === "connected") visitor.connected = true;
  analytics[visitorId] = visitor;
  const retentionCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(analytics)) {
    if (new Date(entry.lastSeen || entry.firstSeen).getTime() < retentionCutoff) delete analytics[id];
  }
  await writeEncryptedStore(analyticsStore, analytics);
}

async function excludeAdminFromAnalytics(req, res) {
  const visitorId = cookieValue(req, "lapped_visitor");
  if (visitorId) {
    const analytics = await readEncryptedStore(analyticsStore);
    if (analytics[visitorId]) {
      delete analytics[visitorId];
      await writeEncryptedStore(analyticsStore, analytics);
    }
  }
  res.cookie("lapped_analytics_opt_out", "1", { httpOnly: true, sameSite: "lax", secure: Boolean(process.env.RENDER_EXTERNAL_URL) || process.env.NODE_ENV === "production", path: "/", maxAge: 365 * 24 * 60 * 60 * 1000 });
}

app.use((req, res, next) => {
  if (req.method === "GET" && req.path === "/" && cookieValue(req, "lapped_analytics_opt_out") !== "1") {
    const visitorId = visitorIdFor(req, res);
    recordAnalyticsEvent(visitorId, "visit").catch((error) => console.error("Analytics visit failed:", error.message));
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
  tokens[token.athlete.id] = { ...token, connected_at: tokens[token.athlete.id]?.connected_at || token.connected_at || new Date().toISOString() };
  return writeEncryptedStore(tokenStore, tokens);
}

async function saveFeatureRequest(text) {
  const stored = await readEncryptedStore(featureRequestsStore);
  const requests = Array.isArray(stored) ? stored : [];
  const request = { id: crypto.randomUUID(), text, created_at: new Date().toISOString(), status: "new" };
  requests.unshift(request);
  await writeEncryptedStore(featureRequestsStore, requests.slice(0, 500));
  return request;
}

function featureRequestKey(req) {
  // A memory-only keyed hash limits spam without retaining a raw IP address.
  return crypto.createHmac("sha256", sessionSecret).update(String(req.ip || "unknown")).digest("hex");
}

function canSubmitFeatureRequest(req) {
  const now = Date.now();
  for (const [key, submittedAt] of featureRequestSubmissions) {
    if (now - submittedAt >= featureRequestWindowMs) featureRequestSubmissions.delete(key);
  }
  const key = featureRequestKey(req);
  if (featureRequestSubmissions.has(key)) return false;
  featureRequestSubmissions.set(key, now);
  return true;
}

async function removeConnectedAthlete(athleteId) {
  if (!athleteId) return;
  const tokens = await readTokens();
  delete tokens[athleteId];
  await writeEncryptedStore(tokenStore, tokens);
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

function formatJoinedAt(value) {
  if (!value) return "before tracking";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "before tracking" : new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Toronto"
  }).format(date);
}

function trafficSeries(analytics, range) {
  const now = new Date();
  const days = range === "today" ? 1 : range === "week" ? 7 : 30;
  const output = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    output.push({ label: range === "today" ? "" : key.slice(5), value: Object.values(analytics).reduce((sum, visitor) => sum + (visitor.days?.[key]?.visits || 0), 0) });
  }
  if (range === "today") {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return Array.from({ length: 24 }, (_, hour) => ({ label: hour % 3 === 0 ? `${hour}:00` : "", value: Object.values(analytics).reduce((sum, visitor) => sum + (visitor.days?.[key]?.hours?.[String(hour).padStart(2, "0")] || 0), 0) }));
  }
  return output;
}

function chartHtml(analytics, range) {
  const points = trafficSeries(analytics, range), max = Math.max(1, ...points.map((point) => point.value));
  return `<div class="chart" data-range="${range}"${range === "today" ? "" : " hidden"}>${points.map((point, index) => `<div class="bar">${point.value ? `<i style="--height:${Math.max(4, Math.round((point.value / max) * 100))}%;--index:${index}" data-value="${point.value} visit${point.value === 1 ? "" : "s"}"></i>` : ""}<span>${point.label}</span></div>`).join("")}</div>`;
}

function connectedAthletePage(tokens, page, query) {
  const athletes = Object.values(tokens).sort((a, b) => String(b.connected_at || "").localeCompare(String(a.connected_at || "")));
  const filtered = query ? athletes.filter((token) => `${token.athlete?.firstname || ""} ${token.athlete?.lastname || ""} ${token.athlete?.id || ""}`.toLowerCase().includes(query.toLowerCase())) : athletes;
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const safePage = Math.min(Math.max(1, page), pageCount);
  return {
    page: safePage,
    pageCount,
    items: filtered.slice((safePage - 1) * 10, safePage * 10).map((token) => ({
      name: [token.athlete?.firstname, token.athlete?.lastname].filter(Boolean).join(" ") || "Unnamed athlete",
      id: String(token.athlete?.id || ""),
      joined: formatJoinedAt(token.connected_at),
      status: "connected"
    }))
  };
}

const adminEnhancements = `<style>th:last-child,td:last-child{text-align:right}.chart{align-items:stretch;padding:12px 0 0;margin-bottom:24px;overflow:visible}.bar{position:relative;display:block;height:100%}.bar i{position:absolute;left:0;right:0;bottom:0}.bar span{position:absolute;left:0;right:0;top:calc(100% + 5px)}</style><script>
document.querySelector('.search')?.remove();
</script>`;

function ticketPanel(stored) {
  const requests = Array.isArray(stored) ? stored : [];
  const renderTicket = (request, archived = false) => `<article class="ticket" data-ticket-id="${escapeHtml(request.id)}"><div><p>${escapeHtml(request.text)}</p><small>${escapeHtml(formatJoinedAt(request.created_at))}</small></div><div class="ticket-actions">${archived ? "" : '<button data-ticket-action="archive">archive</button>'}<button data-ticket-action="delete">delete</button></div></article>`;
  const open = requests.filter((request) => request.status !== "archive").slice(0, 50);
  const archived = requests.filter((request) => request.status === "archive").slice(0, 50);
  return `<style>.tickets{border-top:1px solid var(--ink);padding-top:18px;margin-top:64px}.tickets h2{font-size:15px;margin:0 0 18px}.ticket{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:16px 0}.ticket p{margin:0 0 8px;font-size:14px;line-height:1.45}.ticket small,.ticket-empty,.archived-folder summary{color:var(--muted);font-size:12px}.ticket-actions{display:flex;gap:6px;align-self:start}.ticket-actions button{background:transparent;color:var(--muted);border:1px solid var(--line);padding:6px 7px;font:11px Arial;cursor:pointer}.ticket-actions button:last-child{color:var(--accent)}.archived-folder{margin-top:16px;border-top:1px solid var(--line)}.archived-folder summary{cursor:pointer;padding:14px 0;list-style:none}.archived-folder summary::before{content:"+";display:inline-block;width:15px}.archived-folder[open] summary::before{content:"−"}@media(max-width:600px){.ticket{display:block}.ticket-actions{margin-top:12px}}</style><section class="tickets"><h2>Feature requests</h2>${open.map((request) => renderTicket(request)).join("") || "<p class=\"ticket-empty\">No feature requests yet.</p>"}${archived.length ? `<details class="archived-folder"><summary>Archived (${archived.length})</summary>${archived.map((request) => renderTicket(request, true)).join("")}</details>` : ""}</section><script>document.querySelectorAll('[data-ticket-action]').forEach(button=>button.onclick=async()=>{const ticket=button.closest('[data-ticket-id]'),action=button.dataset.ticketAction;const response=await fetch('/admin/tickets/'+ticket.dataset.ticketId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});if(response.ok){ticket.remove()}})</script>`;
}

function rankingPanel(rankings) {
  const available = rankings.filter((entry) => !entry.unavailable);
  const byLaps = [...available].sort((a, b) => b.laps - a.laps);
  const byFastest = [...available].filter((entry) => entry.fastest).sort((a, b) => {
    const seconds = (value) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    return seconds(a.fastest) - seconds(b.fastest);
  });
  const rows = (entries, value) => entries.map((entry, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(value(entry))}</td></tr>`).join("") || '<tr><td colspan="3">No lap data yet.</td></tr>';
  return `<style>.rankings{border-top:1px solid var(--ink);padding-top:18px;margin-top:64px}.rankings h2{font-size:15px;margin:0 0 6px;font-weight:500}.rankings p{color:var(--muted);font-size:12px;margin:0 0 18px}.ranking-grids{display:grid;grid-template-columns:1fr 1fr;gap:36px}.rankings td:first-child{color:var(--muted);width:30px}.rankings td:last-child{text-align:right;color:var(--ink)}@media(max-width:600px){.ranking-grids{grid-template-columns:1fr;gap:32px}}</style><section class="rankings"><h2>Laps since connecting</h2><p>High Park segment efforts since each athlete joined Lapped.</p><div class="ranking-grids"><div><h2>Most laps</h2><table><thead><tr><th>#</th><th>athlete</th><th>laps</th></tr></thead><tbody>${rows(byLaps, (entry) => entry.laps)}</tbody></table></div><div><h2>Fastest lap</h2><table><thead><tr><th>#</th><th>athlete</th><th>time</th></tr></thead><tbody>${rows(byFastest, (entry) => entry.fastest)}</tbody></table></div></div></section>`;
}

function adminPage(tokens, analytics, { page, query }) {
  const athletes = Object.values(tokens).sort((a, b) => String(b.connected_at || "").localeCompare(String(a.connected_at || "")));
  const filtered = query ? athletes.filter((token) => `${token.athlete?.firstname || ""} ${token.athlete?.lastname || ""} ${token.athlete?.id || ""}`.toLowerCase().includes(query.toLowerCase())) : athletes;
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const rows = filtered.slice((safePage - 1) * 10, safePage * 10).map((token) => {
    const athlete = token.athlete || {};
    const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || "Unnamed athlete";
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(athlete.id)}</td><td>${escapeHtml(formatJoinedAt(token.connected_at))}</td><td>connected</td></tr>`;
  }).join("") || `<tr><td colspan="4">No connected athletes found.</td></tr>`;
  const visitors = Object.values(analytics);
  const started = visitors.filter((visitor) => visitor.connectStarted).length;
  const pagination = `<nav class="pages">${pageCount > 1 ? Array.from({ length: pageCount }, (_, index) => { const number = index + 1; return `<a ${number === safePage ? 'aria-current="page"' : ""} href="/admin?page=${number}${query ? `&q=${encodeURIComponent(query)}` : ""}">${number}</a>`; }).join("") : ""}</nav>`;
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lapped — Admin</title><style>
    :root{color-scheme:dark;--paper:#191a18;--ink:#f2eee7;--muted:#aaa69e;--line:#3c3c38;--accent:#fc4c02}html[data-theme="light"]{color-scheme:light;--paper:#f3f0ea;--ink:#20201e;--muted:#6f6b65;--line:#cbc7bf;--accent:#fc4c02}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Arial,Helvetica,sans-serif;padding:32px 32px 72px;min-height:100vh;transition:background .25s,color .25s}.wrap{max-width:860px;margin:0 auto}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:86px}.brand{color:var(--ink);text-decoration:none;font-weight:700;font-size:22px;letter-spacing:-.07em}.right{display:flex;gap:12px;align-items:center}.tag,.theme-label,.admin-link{color:var(--muted);font-size:12px}.admin-link{text-decoration:underline;text-underline-offset:3px}.toggle{display:block;width:30px;height:18px;cursor:pointer}.toggle input{position:absolute;opacity:0;pointer-events:none}.track{display:block;position:relative;width:30px;height:18px;border:1px solid var(--muted);border-radius:99px}.track i{position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--ink);transition:transform .2s}.toggle input:checked+.track i{transform:translateX(12px)}.count{font-family:Georgia,"Times New Roman",serif;font-size:clamp(74px,15vw,156px);line-height:.8;letter-spacing:-.08em;margin:0 0 64px}.count span{display:block;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:400;letter-spacing:0;color:var(--muted);margin:52px 0 0}.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin:0 0 42px}.metric{background:var(--paper);padding:20px}.metric strong{display:block;font-family:Georgia,"Times New Roman",serif;font-size:44px;font-weight:400;letter-spacing:-.07em;line-height:.9}.metric span{display:block;color:var(--muted);font-size:12px;margin-top:10px}.chart-panel{margin-bottom:64px}.chart-tabs{display:flex;gap:8px;margin:15px 0}.chart-tabs button,.pages a{background:none;color:var(--muted);border:1px solid var(--line);padding:7px 10px;font:12px Arial;cursor:pointer;text-decoration:none}.chart-tabs button[aria-pressed="true"],.pages a[aria-current="page"]{color:var(--paper);background:var(--ink);border-color:var(--ink)}.chart{height:170px;display:flex;align-items:end;gap:3px;border-bottom:1px solid var(--line);padding-top:12px}.chart[hidden]{display:none}.bar{height:100%;flex:1;min-width:0;display:flex;flex-direction:column;justify-content:end;gap:6px}.bar i{display:block;position:relative;height:var(--height);background:var(--accent);transform-origin:bottom;animation:bar-rise .58s cubic-bezier(.22,1,.36,1) both;animation-delay:calc(var(--index) * 18ms)}.bar i:hover::after{content:attr(data-value);position:absolute;z-index:2;left:50%;bottom:calc(100% + 7px);transform:translateX(-50%);background:var(--ink);color:var(--paper);font:11px Arial;white-space:nowrap;padding:6px 7px}.bar span{display:block;color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-align:center}.panel{border-top:1px solid var(--ink);padding-top:18px}.panel-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px}.panel h2{font-size:15px;margin:0;font-weight:500}.panel p{margin:0;color:var(--muted);font-size:12px}.search{display:flex}.search input{background:transparent;color:var(--ink);border:1px solid var(--line);padding:8px;font:13px Arial}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:15px 0;border-top:1px solid var(--line)}th{color:var(--muted);font-size:11px;font-weight:400}td:last-child{text-align:right;color:var(--accent)}.pages{display:flex;gap:5px;margin-top:18px}.footer{margin-top:72px;color:var(--muted);font-size:12px}@keyframes bar-rise{from{transform:scaleY(0)}to{transform:scaleY(1)}}@media(prefers-reduced-motion:reduce){.bar i{animation:none}}@media(max-width:600px){body{padding:20px 20px 52px}.top{margin-bottom:64px}.tag{display:none}.count{font-size:96px;margin-bottom:50px}.metrics{grid-template-columns:1fr;margin-bottom:40px}.panel-head{display:block}.panel-head p{margin-top:8px}.search{margin-top:14px}table{font-size:12px}th:nth-child(2),td:nth-child(2){display:none}}
  </style></head><body><main class="wrap"><nav class="top"><a class="brand" href="/">Lapped</a><div class="right"><span class="tag">private admin</span><a class="admin-link" href="/admin?view=laps">lap rankings</a><span class="theme-label" id="theme-label">light mode</span><label class="toggle"><input id="theme-toggle" type="checkbox" aria-label="Use light mode"><span class="track"><i></i></span></label></div></nav><p class="count">${athletes.length}<span>connected athletes</span></p><section class="metrics"><div class="metric"><strong>${visitors.length}</strong><span>site visitors</span></div><div class="metric"><strong>${started}</strong><span>connect starts</span></div></section><section class="chart-panel"><div class="panel-head"><h2>Visitors</h2></div><div class="chart-tabs"><button data-tab="today" aria-pressed="true">daily</button><button data-tab="week" aria-pressed="false">weekly</button><button data-tab="month" aria-pressed="false">monthly</button></div>${chartHtml(analytics, "today")}${chartHtml(analytics, "week")}${chartHtml(analytics, "month")}</section><section class="panel"><div class="panel-head"><div><h2>People connected to Lapped</h2></div><form class="search" method="get"><input name="q" value="${escapeHtml(query)}" placeholder="Search athlete or ID" autocomplete="off"></form></div><table><thead><tr><th>athlete</th><th>Strava ID</th><th>joined</th><th>status</th></tr></thead><tbody>${rows}</tbody></table>${pagination}</section><footer class="footer">Lapped 2026</footer></main><script>const toggle=document.querySelector('#theme-toggle'),label=document.querySelector('#theme-label'),root=document.documentElement;function setTheme(theme){root.dataset.theme=theme;toggle.checked=theme==='light';label.textContent=theme+' mode'}setTheme(localStorage.getItem('lapped-theme')==='dark'?'dark':'light');toggle.onchange=()=>{const theme=toggle.checked?'light':'dark';setTheme(theme);localStorage.setItem('lapped-theme',theme)};document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(item=>item.setAttribute('aria-pressed',item===button));document.querySelectorAll('.chart').forEach(chart=>chart.hidden=chart.dataset.range!==button.dataset.tab)});const search=document.querySelector('.search input');let searchTimer;search?.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>search.form.submit(),280)})</script></body></html>`;
}

async function requireAdmin(req, res, next) {
  try {
    if (hasValidAdminCookie(req)) {
      await excludeAdminFromAnalytics(req, res);
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
    await excludeAdminFromAnalytics(req, res);
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

function formatElapsedTime(seconds) {
  const rounded = Math.round(Number(seconds));
  if (!Number.isFinite(rounded) || rounded < 1) return null;
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

async function segmentEffortsSince(token, joinedAt) {
  const efforts = [];
  // A connection that has existed less than a day will normally fit in one
  // page. The cap prevents an admin report from exhausting Strava's API quota.
  for (let page = 1; page <= 5; page += 1) {
    const params = new URLSearchParams({
      segment_id: segmentId,
      start_date_local: new Date(joinedAt).toISOString(),
      end_date_local: new Date().toISOString(),
      page: String(page),
      per_page: "200"
    });
    const batch = await strava(`/segment_efforts?${params}`, stravaHeaders(token));
    efforts.push(...batch);
    if (batch.length < 200) break;
  }
  return efforts;
}

function rankingFingerprint(tokens) {
  return Object.entries(tokens)
    .map(([athleteId, token]) => `${athleteId}:${token.connected_at || ""}`)
    .sort()
    .join("|");
}

async function connectionRankings(tokens) {
  const fingerprint = rankingFingerprint(tokens);
  if (connectionRankingCache
    && connectionRankingCache.fingerprint === fingerprint
    && Date.now() - connectionRankingCache.checkedAt < rankingCacheMs) {
    return connectionRankingCache.rankings;
  }

  const rankings = await Promise.all(Object.entries(tokens).map(async ([athleteId, token]) => {
    const name = [token.athlete?.firstname, token.athlete?.lastname].filter(Boolean).join(" ") || "Unnamed athlete";
    if (!token.connected_at) return { athleteId, name, laps: null, fastest: null, unavailable: true };
    try {
      const efforts = await segmentEffortsSince(await tokenForAthlete(athleteId), token.connected_at);
      const fastest = efforts
        .map((effort) => Number(effort.elapsed_time))
        .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
        .sort((a, b) => a - b)[0];
      return { athleteId, name, laps: efforts.length, fastest: formatElapsedTime(fastest), unavailable: false };
    } catch (error) {
      console.error(`Ranking read failed for athlete ${athleteId}:`, error.message);
      return { athleteId, name, laps: null, fastest: null, unavailable: true };
    }
  }));

  connectionRankingCache = { fingerprint, checkedAt: Date.now(), rankings };
  return rankings;
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

function processingRetryKey(athleteId, activityId) {
  return `${athleteId}:${activityId}`;
}

function clearProcessingRetry(athleteId, activityId) {
  const key = processingRetryKey(athleteId, activityId);
  const timer = processingRetries.get(key);
  if (!timer) return;
  clearTimeout(timer);
  processingRetries.delete(key);
}

function queueProcessingRetry(athleteId, activityId) {
  if (!athleteId || !activityId) return;
  const key = processingRetryKey(athleteId, activityId);
  if (processingRetries.has(key)) return;
  const timer = setTimeout(async () => {
    processingRetries.delete(key);
    try {
      // Never resurrect a connection after the athlete has disconnected.
      if (!(await athleteIsStillConnected(athleteId))) return;
      const token = await tokenForAthlete(athleteId);
      await scanActivityWithToken(token, activityId, athleteId);
    } catch (error) {
      console.error("Delayed activity scan failed:", error.message);
    }
  }, processingRetryDelayMs);
  timer.unref?.();
  processingRetries.set(key, timer);
}

async function scanActivityWithToken(token, activityId, athleteId, { retryIfProcessing = false } = {}) {
  const activity = await strava(`/activities/${activityId}?include_all_efforts=true`, { headers: { Authorization: `Bearer ${token}` } });
  const targetEfforts = (activity.segment_efforts || []).filter(isTargetEffort);
  const lapCount = targetEfforts.length;
  if (await activityWasProcessed(athleteId, activityId)) {
    clearProcessingRetry(athleteId, activityId);
    return { lapCount, changed: false, description: activity.description ?? "" };
  }
  if (hasLappedReceipt(activity.description)) {
    clearProcessingRetry(athleteId, activityId);
    return { lapCount, changed: false, description: activity.description ?? "" };
  }
  if (!lapCount) {
    if (retryIfProcessing) queueProcessingRetry(athleteId, activityId);
    return { lapCount: 0, changed: false, description: activity.description ?? "" };
  }

  clearProcessingRetry(athleteId, activityId);

  const fastestLap = formatFastestLap(targetEfforts);
  const stamp = formatReceipt({
    lapCount,
    fastestLap
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
  if (cookieValue(req, "lapped_analytics_opt_out") !== "1") recordAnalyticsEvent(visitorIdFor(req, res), "connect").catch((error) => console.error("Analytics connect failed:", error.message));
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
    if (cookieValue(req, "lapped_analytics_opt_out") !== "1") await recordAnalyticsEvent(visitorIdFor(req, res), "connected");
    delete req.session.oauthState;
    const returnTo = req.session.returnTo || "/?connected=1";
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (error) { next(error); }
});

app.get("/api/status", (req, res) => res.json({ connected: Boolean(req.session.strava), athlete: req.session.strava?.athlete || null, configured: !configError, segmentId: segmentId || null, lapStatsEnabled }));
app.post("/api/feature-requests", async (req, res, next) => {
  try {
    const text = String(req.body?.request || "").trim().replace(/\s+/g, " ");
    if (text.length < 3 || text.length > 500) return res.status(400).json({ error: "Please keep requests between 3 and 500 characters." });
    if (!canSubmitFeatureRequest(req)) return res.status(429).json({ error: "One request per hour, please." });
    await saveFeatureRequest(text);
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.get("/admin", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const query = String(req.query.q || "").slice(0, 80);
    const showRankings = req.query.view === "laps";
    const [analytics, tickets, rankings] = await Promise.all([
      readEncryptedStore(analyticsStore),
      readEncryptedStore(featureRequestsStore),
      showRankings ? connectionRankings(req.connectedTokens) : Promise.resolve(null)
    ]);
    const pageHtml = adminPage(req.connectedTokens, analytics, { page, query });
    const extras = `${rankings ? rankingPanel(rankings) : ""}${ticketPanel(tickets)}`;
    res.type("html").send(pageHtml.replace("<footer class=\"footer\">", `${extras}<footer class="footer">`).replace("</body>", `${adminEnhancements}</body>`));
  } catch (error) { next(error); }
});
app.get("/admin/athletes", requireAdmin, (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const query = String(req.query.q || "").slice(0, 80);
  res.json(connectedAthletePage(req.connectedTokens, page, query));
});
app.get("/admin/rankings", requireAdmin, async (req, res, next) => {
  try {
    const rankings = await connectionRankings(req.connectedTokens);
    res.json({
      updatedAt: new Date().toISOString(),
      mostLaps: [...rankings].filter((entry) => !entry.unavailable).sort((a, b) => b.laps - a.laps),
      fastestLap: [...rankings].filter((entry) => !entry.unavailable && entry.fastest).sort((a, b) => {
        const seconds = (value) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
        return seconds(a.fastest) - seconds(b.fastest);
      })
    });
  } catch (error) { next(error); }
});
app.post("/admin/tickets/:id", requireAdmin, async (req, res, next) => {
  try {
    const action = String(req.body?.action || "");
    if (!new Set(["archive", "delete"]).has(action)) return res.status(400).json({ error: "Invalid action." });
    const stored = await readEncryptedStore(featureRequestsStore);
    const requests = Array.isArray(stored) ? stored : [];
    const index = requests.findIndex((request) => request.id === req.params.id);
    if (index === -1) return res.sendStatus(404);
    if (action === "delete") requests.splice(index, 1);
    else requests[index].status = action;
    await writeEncryptedStore(featureRequestsStore, requests);
    res.json({ ok: true });
  } catch (error) { next(error); }
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
    .then((token) => scanActivityWithToken(token, event.object_id, event.owner_id, { retryIfProcessing: event.aspect_type === "create" }))
    .catch((error) => console.error("Webhook scan failed:", error.message));
});
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || "Something went wrong." }));
app.listen(process.env.PORT || 3000, process.env.HOST || (process.env.RENDER_EXTERNAL_URL ? "0.0.0.0" : "127.0.0.1"), () => console.log(`Lapped running at ${baseUrl}`));
