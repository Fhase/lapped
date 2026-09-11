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
const waitlistStore = path.join(dataDir, "waitlist.json");
// Retained only long enough to clear the retired leaderboard cache on deploy.
// It never contains tokens and clearing it never changes a connection.
const legacyLeaderboardStore = path.join(dataDir, "leaderboard.json");
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
const waitlistSubmissions = new Map();
// Strava can announce a freshly uploaded activity before its segment efforts
// have finished processing. Keep one short, in-memory retry per activity so an
// import is not missed, without doubling scans for title edits or every webhook.
const processingRetryDelayMs = 2 * 60 * 1000;
const processingRetries = new Map();
const activityCacheRetentionMs = 7 * 24 * 60 * 60 * 1000;

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
app.use(express.urlencoded({ extended: false }));
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

async function saveWaitlistLead({ name, email, stravaUrl }) {
  const stored = await readEncryptedStore(waitlistStore);
  const leads = Array.isArray(stored) ? stored : [];
  const existing = leads.find((lead) => String(lead.email || "").toLowerCase() === email.toLowerCase());
  if (existing) return { lead: existing, existing: true };
  const lead = { id: crypto.randomUUID(), name, email, stravaUrl, created_at: new Date().toISOString(), status: "new" };
  leads.unshift(lead);
  await writeEncryptedStore(waitlistStore, leads.slice(0, 1000));
  return { lead, existing: false };
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

function canSubmitWaitlist(req) {
  const now = Date.now();
  for (const [key, submittedAt] of waitlistSubmissions) {
    if (now - submittedAt >= featureRequestWindowMs) waitlistSubmissions.delete(key);
  }
  const key = featureRequestKey(req);
  if (waitlistSubmissions.has(key)) return false;
  waitlistSubmissions.set(key, now);
  return true;
}

async function removeConnectedAthlete(athleteId) {
  if (!athleteId) return;
  const tokens = await readTokens();
  delete tokens[athleteId];
  await writeEncryptedStore(tokenStore, tokens);
  await clearLapStats(athleteId);
  const legacy = await readEncryptedStore(legacyLeaderboardStore);
  if (legacy.athletes?.[athleteId]) {
    delete legacy.athletes[athleteId];
    await writeEncryptedStore(legacyLeaderboardStore, legacy);
  }
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

async function pruneStravaCaches() {
  const cutoff = Date.now() - activityCacheRetentionMs;
  const stats = await readLapStats();
  const processed = Object.fromEntries(Object.entries(stats.__processed || {}).map(([athleteId, activities]) => {
    const current = Object.fromEntries(Object.entries(activities || {}).filter(([, processedAt]) => Number(processedAt) >= cutoff));
    return [athleteId, current];
  }).filter(([, activities]) => Object.keys(activities).length));
  // Only the seven-day duplicate-prevention cache remains. Historical lap
  // totals and effort-derived values are intentionally discarded.
  const cleanedStats = Object.keys(processed).length ? { __processed: processed } : {};
  if (JSON.stringify(stats) !== JSON.stringify(cleanedStats)) await writeEncryptedStore(lapStatsStore, cleanedStats);

  // Retire the old cross-athlete leaderboard cache without ever reading or
  // changing the token store. This is a data cleanup, not a disconnect.
  const legacy = await readEncryptedStore(legacyLeaderboardStore);
  if (Object.keys(legacy || {}).length) await writeEncryptedStore(legacyLeaderboardStore, {});
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
    const month = range === "month" && (offset === days - 1 || date.getDate() === 1)
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short" }).format(date).toLowerCase()
      : "";
    const label = range === "month" ? String(date.getDate()) : range === "today" ? "" : key.slice(5);
    output.push({ label, month, value: Object.values(analytics).reduce((sum, visitor) => sum + (visitor.days?.[key]?.visits || 0), 0) });
  }
  if (range === "today") {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return Array.from({ length: 24 }, (_, hour) => ({ label: hour % 3 === 0 ? `${hour}:00` : "", value: Object.values(analytics).reduce((sum, visitor) => sum + (visitor.days?.[key]?.hours?.[String(hour).padStart(2, "0")] || 0), 0) }));
  }
  return output;
}

function chartHtml(analytics, range) {
  const points = trafficSeries(analytics, range), max = Math.max(1, ...points.map((point) => point.value));
  return `<div class="chart" data-range="${range}"${range === "today" ? "" : " hidden"}>${points.map((point, index) => `<div class="bar">${point.value ? `<i style="--height:${Math.max(4, Math.round((point.value / max) * 100))}%;--index:${index}" data-value="${point.value} visit${point.value === 1 ? "" : "s"}"></i>` : ""}<span>${point.label}${point.month ? `<b>${point.month}</b>` : ""}</span></div>`).join("")}</div>`;
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

const adminEnhancements = `<style>th:last-child,td:last-child{text-align:right}.chart{align-items:stretch;padding:12px 0 0;margin-bottom:24px;overflow:visible}.bar{position:relative;display:block;height:100%}.bar i{position:absolute;left:0;right:0;bottom:0}.bar span{position:absolute;left:0;right:0;top:calc(100% + 5px)}.chart[data-range="month"] .bar span{font-size:8px}.chart[data-range="month"] .bar span b{display:block;font:8px Arial;color:var(--muted);margin-top:3px}.count{display:none}.metrics{grid-template-columns:repeat(3,1fr);margin-bottom:64px}.metric strong{font-family:Arial,Helvetica,sans-serif;font-weight:700}@media(max-width:600px){.metrics{grid-template-columns:repeat(3,1fr);margin-bottom:42px}.metric{padding:14px 10px}.metric strong{font-size:30px}.metric span{font-size:10px;margin-top:8px}.chart[data-range="month"] .bar span{font-size:7px}}</style><script>
document.querySelector('.search')?.remove();
</script>`;

function manualPushPanel(tokens = {}) {
  const riders = Object.values(tokens).sort((a, b) => athleteDisplayName(a.athlete).localeCompare(athleteDisplayName(b.athlete)));
  const options = riders.map((token) => `<option value="${escapeHtml(token.athlete?.id)}">${escapeHtml(athleteDisplayName(token.athlete))}</option>`).join("");
  return `<style>.manual-push{margin:0 0 64px}.manual-push .panel-head{display:block}.manual-push-form{display:flex;gap:8px;margin-top:18px}.manual-push input,.manual-push select{min-width:0;background:transparent;color:var(--ink);border:1px solid var(--line);padding:11px 12px;font:14px Arial}.manual-push-url{flex:1}.manual-push-owner{margin-top:8px;max-width:280px}.manual-push button{border:1px solid var(--ink);background:var(--ink);color:var(--paper);padding:11px 14px;font:13px Arial;cursor:pointer;white-space:nowrap}.manual-push button[disabled]{cursor:wait;opacity:.6}.manual-result{min-height:20px;margin:13px 0 0;color:var(--muted);font-size:13px;line-height:1.45}.manual-result[data-state="ready"]{color:var(--ink)}.manual-confirm{margin-top:14px}.manual-confirm[hidden],.manual-push-owner[hidden]{display:none}@media(max-width:600px){.manual-push-form{display:block}.manual-push input,.manual-push select{width:100%;max-width:none}.manual-push-form button{margin-top:8px}}</style><section class="panel manual-push" aria-labelledby="manual-push-title"><div class="panel-head"><h2 id="manual-push-title">Manual ride push</h2></div><form class="manual-push-form" id="manual-push-form"><input class="manual-push-url" id="manual-push-url" name="url" type="url" inputmode="url" autocomplete="off" placeholder="Strava activity or app link" required><button id="manual-push-check" type="submit">Check ride</button></form><select class="manual-push-owner" id="manual-push-owner" aria-label="Ride owner" hidden><option value="">Select the connected rider</option>${options}</select><div class="manual-result" id="manual-push-result" aria-live="polite"></div><button class="manual-confirm" id="manual-push-confirm" type="button" hidden>Push description</button></section>`;
}

const manualPushEnhancements = `<script>
(()=>{const form=document.querySelector('#manual-push-form'),input=document.querySelector('#manual-push-url'),owner=document.querySelector('#manual-push-owner'),check=document.querySelector('#manual-push-check'),result=document.querySelector('#manual-push-result'),confirm=document.querySelector('#manual-push-confirm');if(!form)return;let readyUrl='';const post=async(path,url)=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({url,athleteId:owner.value})});const body=await response.json().catch(()=>({error:'Something went wrong.'}));if(!response.ok)throw new Error(body.error||'Something went wrong.');return body};const show=(body)=>{result.textContent=body.message||'';result.dataset.state=body.status||'';readyUrl=body.status==='ready'?input.value.trim():'';confirm.hidden=!readyUrl};form.addEventListener('submit',async(event)=>{event.preventDefault();confirm.hidden=true;readyUrl='';if(!owner.value){owner.hidden=false;result.textContent='Choose the connected rider for this activity.';return}check.disabled=true;result.textContent='Checking ride…';result.dataset.state='';try{show(await post('/admin/activity-review/check',input.value.trim()))}catch(error){result.textContent=error.message}finally{check.disabled=false}});confirm.addEventListener('click',async()=>{if(!readyUrl)return;confirm.disabled=true;result.textContent='Writing description…';try{show(await post('/admin/activity-review/apply',readyUrl));if(result.dataset.state==='pushed')input.value=''}catch(error){result.textContent=error.message}finally{confirm.disabled=false}})})();
</script>`;

function ticketPanel(stored) {
  const requests = Array.isArray(stored) ? stored : [];
  const renderTicket = (request, archived = false) => `<article class="ticket" data-ticket-id="${escapeHtml(request.id)}"><div><p>${escapeHtml(request.text)}</p><small>${escapeHtml(formatJoinedAt(request.created_at))}</small></div><div class="ticket-actions">${archived ? "" : '<button data-ticket-action="archive">archive</button>'}<button data-ticket-action="delete">delete</button></div></article>`;
  const open = requests.filter((request) => request.status !== "archive").slice(0, 50);
  const archived = requests.filter((request) => request.status === "archive").slice(0, 50);
  return `<style>.tickets{border-top:1px solid var(--ink);padding-top:18px;margin-top:64px}.tickets h2{font-size:15px;margin:0 0 18px}.ticket{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:16px 0}.ticket p{margin:0 0 8px;font-size:14px;line-height:1.45}.ticket small,.ticket-empty,.archived-folder summary{color:var(--muted);font-size:12px}.ticket-actions{display:flex;gap:6px;align-self:start}.ticket-actions button{background:transparent;color:var(--muted);border:1px solid var(--line);padding:6px 7px;font:11px Arial;cursor:pointer}.ticket-actions button:last-child{color:var(--accent)}.archived-folder{margin-top:16px;border-top:1px solid var(--line)}.archived-folder summary{cursor:pointer;padding:14px 0;list-style:none}.archived-folder summary::before{content:"+";display:inline-block;width:15px}.archived-folder[open] summary::before{content:"−"}@media(max-width:600px){.ticket{display:block}.ticket-actions{margin-top:12px}}</style><section class="tickets"><h2>Feature requests</h2>${open.map((request) => renderTicket(request)).join("") || "<p class=\"ticket-empty\">No feature requests yet.</p>"}${archived.length ? `<details class="archived-folder"><summary>Archived (${archived.length})</summary>${archived.map((request) => renderTicket(request, true)).join("")}</details>` : ""}</section><script>document.querySelectorAll('[data-ticket-action]').forEach(button=>button.onclick=async()=>{const ticket=button.closest('[data-ticket-id]'),action=button.dataset.ticketAction;const response=await fetch('/admin/tickets/'+ticket.dataset.ticketId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});if(response.ok){ticket.remove()}})</script>`;
}

function waitlistPanel(stored) {
  const leads = (Array.isArray(stored) ? stored : []).filter((lead) => lead.status !== "archive").slice(0, 100);
  const archived = (Array.isArray(stored) ? stored : []).filter((lead) => lead.status === "archive").slice(0, 100);
  const renderLead = (lead, isArchived = false) => `<article class="ticket waitlist-lead" data-waitlist-id="${escapeHtml(lead.id)}"><div><p><strong>${escapeHtml(lead.name)}</strong> · <a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a>${lead.stravaUrl ? ` · <a href="${escapeHtml(lead.stravaUrl)}" target="_blank" rel="noreferrer">Strava</a>` : ""}</p><small>${escapeHtml(formatJoinedAt(lead.created_at))}</small></div><div class="ticket-actions">${isArchived ? "" : '<button data-waitlist-action="archive">archive</button>'}<button data-waitlist-action="delete">delete</button></div></article>`;
  return `<section class="tickets waitlist"><h2>Waitlist</h2>${leads.map((lead) => renderLead(lead)).join("") || '<p class="ticket-empty">No waitlist leads yet.</p>'}${archived.length ? `<details class="archived-folder"><summary>Archived (${archived.length})</summary>${archived.map((lead) => renderLead(lead, true)).join("")}</details>` : ""}</section><script>document.querySelectorAll('[data-waitlist-action]').forEach(button=>button.onclick=async()=>{const lead=button.closest('[data-waitlist-id]'),action=button.dataset.waitlistAction;const response=await fetch('/admin/waitlist/'+lead.dataset.waitlistId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});if(response.ok){lead.remove()}})</script>`;
}

function waitlistPage() {
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lapped — Waitlist</title><meta name="description" content="Join the Lapped waitlist."><link rel="canonical" href="https://lapped.fit/waitlist"><link rel="stylesheet" href="/styles.css"><style>.waitlist-page{max-width:650px;padding:112px 0 62px}.waitlist-page h1{font-size:clamp(56px,9vw,96px);margin-bottom:30px}.waitlist-page>p{max-width:510px;color:var(--muted);font-size:17px;line-height:1.45;margin:0 0 42px}.waitlist-form{display:grid;gap:18px;border-top:1px solid var(--ink);padding-top:24px}.waitlist-form label{display:grid;gap:7px;font-size:13px;color:var(--muted)}.waitlist-form input{width:100%;background:transparent;border:1px solid color-mix(in srgb,var(--ink) 45%,transparent);color:var(--ink);padding:13px;font:16px Manrope,Arial,sans-serif}.waitlist-form button{justify-self:start;margin-top:4px}.waitlist-form p{min-height:22px;color:var(--muted);font-size:14px;margin:0}.waitlist-note{font-size:12px!important;line-height:1.5!important;margin:0!important}.waitlist-note a{color:var(--ink);text-underline-offset:3px}</style></head><body><main><nav><a class="wordmark" href="/">Lapped</a><div class="nav-right"><a class="github-link" href="/">back to Lapped</a></div></nav><section class="waitlist-page"><h1>Join the list.</h1><p>We’re waiting for Strava to open more Lapped spots. Leave your details and we’ll reach out when you can connect.</p><form class="waitlist-form" id="waitlist-form"><label>name<input name="name" autocomplete="name" maxlength="80" required></label><label>email<input name="email" type="email" autocomplete="email" maxlength="254" required></label><label>Strava profile or activity link <small>optional</small><input name="stravaUrl" type="url" inputmode="url" maxlength="500" placeholder="https://www.strava.com/athletes/..." ></label><button type="submit">Join the waitlist</button><p id="waitlist-status" aria-live="polite"></p><p class="waitlist-note">We use these details only to notify you when Lapped has space. Read the <a href="/privacy.html">privacy policy</a>.</p></form></section></main><script>const form=document.querySelector('#waitlist-form'),status=document.querySelector('#waitlist-status');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Saving…';try{const values=Object.fromEntries(new FormData(form));const response=await fetch('/api/waitlist',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});const body=await response.json();if(!response.ok)throw new Error(body.error||'Could not join right now.');form.reset();status.textContent=body.existing?'You’re already on the list.':'You’re on the list — we’ll be in touch.'}catch(error){status.textContent=error.message}finally{button.disabled=false}})</script></body></html>`;
}

function rankingPanel(rankings) {
  const available = rankings.filter((entry) => !entry.unavailable);
  const byLaps = [...available].sort((a, b) => b.laps - a.laps);
  const byFastest = [...available].filter((entry) => entry.fastest).sort((a, b) => {
    const seconds = (value) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    return seconds(a.fastest) - seconds(b.fastest);
  });
  const distance = (laps) => `${Math.round(Number(laps) * 1.85).toLocaleString()} km`;
  const rows = (entries, value, showDistance = false) => entries.map((entry, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(value(entry))}</td>${showDistance ? `<td>${distance(entry.laps)}</td>` : ""}</tr>`).join("") || `<tr><td colspan="${showDistance ? 4 : 3}">No lap data yet.</td></tr>`;
  return `<style>.rankings{border-top:1px solid var(--ink);padding-top:18px;margin-top:64px}.rankings h2{font-size:15px;margin:0 0 6px;font-weight:500}.rankings p{color:var(--muted);font-size:12px;margin:0 0 18px}.ranking-grids{display:grid;grid-template-columns:1fr 1fr;gap:36px}.rankings td:first-child{color:var(--muted);width:30px}.ranking-grids>div:first-child th:nth-last-child(-n+2),.ranking-grids>div:first-child td:nth-last-child(-n+2),.ranking-grids>div:nth-child(2) th:last-child,.ranking-grids>div:nth-child(2) td:last-child{text-align:right}.rankings td:last-child{color:var(--ink)}@media(max-width:600px){.ranking-grids{grid-template-columns:1fr;gap:32px}}</style><section class="rankings"><h2>Laps since connecting</h2><p>High Park segment efforts since each athlete joined Lapped.</p><div class="ranking-grids"><div><h2>Most laps</h2><table><thead><tr><th>#</th><th>athlete</th><th>laps</th><th>km</th></tr></thead><tbody>${rows(byLaps, (entry) => entry.laps, true)}</tbody></table></div><div><h2>Fastest lap</h2><table><thead><tr><th>#</th><th>athlete</th><th>time</th></tr></thead><tbody>${rows(byFastest, (entry) => entry.fastest)}</tbody></table></div></div></section>`;
}

function leaderboardPanel(board, tokens) {
  const entries = Object.entries(board.athletes || {}).filter(([athleteId]) => tokens[athleteId]).map(([, entry]) => entry);
  const distance = (laps) => `${Math.round(Number(laps) * 1.85).toLocaleString()} km`;
  const rows = (key) => entries.filter((entry) => entry[key]?.status === "ready")
    .sort((a, b) => b[key].value - a[key].value)
    .map((entry, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry[key].value}</td><td>${distance(entry[key].value)}</td></tr>`).join("");
  // A historical YTD scan can span several pages. Show the collected total
  // immediately (with a +) rather than leaving the whole table blank until
  // that athlete's final page has been read.
  const ytdRows = entries.filter((entry) => entry.ytd?.status === "ready" || Number(entry.ytd?.total) > 0)
    .sort((a, b) => (b.ytd.value ?? b.ytd.total ?? 0) - (a.ytd.value ?? a.ytd.total ?? 0))
    .map((entry, index) => {
      const complete = entry.ytd.status === "ready";
      const value = complete ? entry.ytd.value : entry.ytd.total;
      return `<tr><td>${index + 1}</td><td>${escapeHtml(entry.name)}</td><td>${value}${complete ? "" : "+"}</td><td>${distance(value)}${complete ? "" : "+"}</td></tr>`;
    }).join("");
  const loading = entries.filter((entry) => entry.allTime?.status !== "ready" || entry.ytd?.status !== "ready").length;
  const empty = '<tr><td colspan="4">loading stats… come back in a while</td></tr>';
  return `<style>.leaderboard{padding-top:18px;margin-top:64px}.leaderboard h2{font-size:15px;margin:0 0 6px;font-weight:500}.leaderboard p{color:var(--muted);font-size:12px;margin:0 0 18px}.leaderboard-grid{display:grid;grid-template-columns:1fr 1fr;gap:36px}.leaderboard td:first-child{color:var(--muted);width:30px}.leaderboard th:nth-last-child(-n+2),.leaderboard td:nth-last-child(-n+2){text-align:right}.leaderboard td:last-child{color:var(--ink)}@media(max-width:600px){.leaderboard-grid{grid-template-columns:1fr;gap:32px}}</style><section class="leaderboard"><h2>High Park leaderboard</h2><p>${loading ? `loading stats for ${loading} athlete${loading === 1 ? "" : "s"}… come back in a while` : "up to date"}</p><div class="leaderboard-grid"><div><h2>All time</h2><table><thead><tr><th>#</th><th>athlete</th><th>laps</th><th>km</th></tr></thead><tbody>${rows("allTime") || empty}</tbody></table></div><div><h2>${new Date().getUTCFullYear()}</h2><table><thead><tr><th>#</th><th>athlete</th><th>laps</th><th>km</th></tr></thead><tbody>${ytdRows || empty}</tbody></table></div></div></section>`;
}

function publicLeaderboardPage(board, tokens, rankings) {
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lapped — Leaderboard</title><meta name="description" content="High Park’s Lapped leaderboard: all-time, yearly, and fastest laps."><link rel="canonical" href="https://lapped.fit/leaderboard"><meta property="og:type" content="website"><meta property="og:title" content="Lapped — Leaderboard"><meta property="og:description" content="High Park’s Lapped leaderboard: all-time, yearly, and fastest laps."><meta property="og:url" content="https://lapped.fit/leaderboard"><meta property="og:image" content="https://lapped.fit/leaderboard-og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Lapped Leaderboard — High Park laps."><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Lapped — Leaderboard"><meta name="twitter:description" content="High Park’s Lapped leaderboard: all-time, yearly, and fastest laps."><meta name="twitter:image" content="https://lapped.fit/leaderboard-og.png"><meta name="twitter:image:alt" content="Lapped Leaderboard — High Park laps."><style>:root{color-scheme:dark;--paper:#191a18;--ink:#f2eee7;--muted:#aaa69e;--line:#3c3c38;--accent:#fc4c02}html[data-theme="light"]{color-scheme:light;--paper:#f3f0ea;--ink:#20201e;--muted:#6f6b65;--line:#cbc7bf;--accent:#fc4c02}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px Arial,Helvetica,sans-serif;padding:32px 24px 72px;transition:background .25s,color .25s}.wrap{max-width:860px;margin:0 auto}.top{display:flex;align-items:center;justify-content:space-between}.brand,.back{color:var(--ink);text-decoration:none}.brand{font-weight:700;font-size:22px;letter-spacing:-.07em}.right{display:flex;align-items:center;gap:12px}.back,.theme-label{color:var(--muted);font-size:12px;text-decoration:underline;text-underline-offset:3px}.theme-label{text-decoration:none}.toggle{display:block;width:30px;height:18px;cursor:pointer}.toggle input{position:absolute;opacity:0;pointer-events:none}.track{display:block;position:relative;width:30px;height:18px;border:1px solid var(--muted);border-radius:99px}.track i{position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--ink);transition:transform .2s}.toggle input:checked+.track i{transform:translateX(12px)}.heading{margin:94px 0 54px;padding-bottom:22px}.heading h1{margin:0;font:400 clamp(56px,11vw,108px)/.85 Georgia,"Times New Roman",serif;letter-spacing:-.075em}.leaderboard,.rankings{border-top:1px solid var(--ink);padding-top:18px;margin-top:64px}.leaderboard h2,.rankings h2{font-size:15px;margin:0 0 6px;font-weight:500}.leaderboard p,.rankings p{color:var(--muted);font-size:13px;margin:0 0 18px}.leaderboard-grid,.ranking-grids{display:grid;grid-template-columns:1fr 1fr;gap:36px}table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:15px 0;border-top:1px solid var(--line)}th{color:var(--muted);font-size:12px;font-weight:400}td:first-child{color:var(--muted);width:30px}td:last-child{text-align:right;color:var(--ink)}footer{margin-top:72px;color:var(--muted);font-size:12px}@media(max-width:600px){body{padding:20px 20px 52px}.heading{margin:68px 0 42px}.leaderboard-grid,.ranking-grids{grid-template-columns:1fr;gap:32px}.right .back{display:none}table{font-size:14px}.heading h1{font-size:68px}}</style></head><body><main class="wrap"><nav class="top"><a class="brand" href="/">Lapped</a><div class="right"><a class="back" href="/">back to Lapped</a><span class="theme-label" id="theme-label">light mode</span><label class="toggle"><input id="theme-toggle" type="checkbox" aria-label="Use light mode"><span class="track"><i></i></span></label></div></nav><header class="heading"><h1>Leaderboard</h1></header>${leaderboardPanel(board, tokens)}${rankingPanel(rankings)}<footer>Lapped 2026</footer></main><script>const toggle=document.querySelector('#theme-toggle'),label=document.querySelector('#theme-label'),root=document.documentElement;function setTheme(theme){root.dataset.theme=theme;toggle.checked=theme==='light';label.textContent=theme+' mode'}setTheme(localStorage.getItem('lapped-theme')==='dark'?'dark':'light');toggle.onchange=()=>{const theme=toggle.checked?'light':'dark';setTheme(theme);localStorage.setItem('lapped-theme',theme)}</script></body></html>`;
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
    :root{color-scheme:dark;--paper:#191a18;--ink:#f2eee7;--muted:#aaa69e;--line:#3c3c38;--accent:#fc4c02}html[data-theme="light"]{color-scheme:light;--paper:#f3f0ea;--ink:#20201e;--muted:#6f6b65;--line:#cbc7bf;--accent:#fc4c02}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Arial,Helvetica,sans-serif;padding:32px 32px 72px;min-height:100vh;transition:background .25s,color .25s}.wrap{max-width:860px;margin:0 auto}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:86px}.brand{color:var(--ink);text-decoration:none;font-weight:700;font-size:22px;letter-spacing:-.07em}.right{display:flex;gap:12px;align-items:center}.tag,.theme-label,.admin-link{color:var(--muted);font-size:12px}.admin-link{text-decoration:underline;text-underline-offset:3px}.toggle{display:block;width:30px;height:18px;cursor:pointer}.toggle input{position:absolute;opacity:0;pointer-events:none}.track{display:block;position:relative;width:30px;height:18px;border:1px solid var(--muted);border-radius:99px}.track i{position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--ink);transition:transform .2s}.toggle input:checked+.track i{transform:translateX(12px)}.count{font-family:Georgia,"Times New Roman",serif;font-size:clamp(74px,15vw,156px);line-height:.8;letter-spacing:-.08em;margin:0 0 64px}.count span{display:block;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:400;letter-spacing:0;color:var(--muted);margin:52px 0 0}.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin:0 0 42px}.metric{background:var(--paper);padding:20px}.metric strong{display:block;font-family:Georgia,"Times New Roman",serif;font-size:44px;font-weight:400;letter-spacing:-.07em;line-height:.9}.metric span{display:block;color:var(--muted);font-size:12px;margin-top:10px}.chart-panel{margin-bottom:64px}.chart-tabs{display:flex;gap:8px;margin:15px 0}.chart-tabs button,.pages a{background:none;color:var(--muted);border:1px solid var(--line);padding:7px 10px;font:12px Arial;cursor:pointer;text-decoration:none}.chart-tabs button[aria-pressed="true"],.pages a[aria-current="page"]{color:var(--paper);background:var(--ink);border-color:var(--ink)}.chart{height:170px;display:flex;align-items:end;gap:3px;border-bottom:1px solid var(--line);padding-top:12px}.chart[hidden]{display:none}.bar{height:100%;flex:1;min-width:0;display:flex;flex-direction:column;justify-content:end;gap:6px}.bar i{display:block;position:relative;height:var(--height);background:var(--accent);transform-origin:bottom;animation:bar-rise .58s cubic-bezier(.22,1,.36,1) both;animation-delay:calc(var(--index) * 18ms)}.bar i:hover::after{content:attr(data-value);position:absolute;z-index:2;left:50%;bottom:calc(100% + 7px);transform:translateX(-50%);background:var(--ink);color:var(--paper);font:11px Arial;white-space:nowrap;padding:6px 7px}.bar span{display:block;color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-align:center}.panel{border-top:1px solid var(--ink);padding-top:18px}.panel-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px}.panel h2{font-size:15px;margin:0;font-weight:500}.panel p{margin:0;color:var(--muted);font-size:12px}.search{display:flex}.search input{background:transparent;color:var(--ink);border:1px solid var(--line);padding:8px;font:13px Arial}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:15px 0;border-top:1px solid var(--line)}th{color:var(--muted);font-size:11px;font-weight:400}td:last-child{text-align:right;color:var(--accent)}.pages{display:flex;gap:5px;margin-top:18px}.footer{margin-top:72px;color:var(--muted);font-size:12px}@keyframes bar-rise{from{transform:scaleY(0)}to{transform:scaleY(1)}}@media(prefers-reduced-motion:reduce){.bar i{animation:none}}@media(max-width:600px){body{padding:20px 20px 52px}.top{margin-bottom:64px}.tag{display:none}.count{font-size:96px;margin-bottom:50px}.metrics{grid-template-columns:1fr;margin-bottom:40px}.panel-head{display:block}.panel-head p{margin-top:8px}.search{margin-top:14px}table{font-size:12px}.panel th:nth-child(2),.panel td:nth-child(2){display:none}}
  </style></head><body><main class="wrap"><nav class="top"><a class="brand" href="/">Lapped</a><div class="right"><span class="tag">private admin</span><span class="theme-label" id="theme-label">light mode</span><label class="toggle"><input id="theme-toggle" type="checkbox" aria-label="Use light mode"><span class="track"><i></i></span></label></div></nav><p class="count">${athletes.length}<span>connected athletes</span></p><section class="metrics"><div class="metric"><strong>${visitors.length}</strong><span>site visitors</span></div><div class="metric"><strong>${started}</strong><span>connect starts</span></div></section><section class="chart-panel"><div class="panel-head"><h2>Visitors</h2></div><div class="chart-tabs"><button data-tab="today" aria-pressed="true">daily</button><button data-tab="week" aria-pressed="false">weekly</button><button data-tab="month" aria-pressed="false">monthly</button></div>${chartHtml(analytics, "today")}${chartHtml(analytics, "week")}${chartHtml(analytics, "month")}</section>${manualPushPanel(tokens)}<section class="panel"><div class="panel-head"><div><h2>People connected to Lapped</h2></div><form class="search" method="get"><input name="q" value="${escapeHtml(query)}" placeholder="Search athlete or ID" autocomplete="off"></form></div><table><thead><tr><th>athlete</th><th>Strava ID</th><th>joined</th><th>status</th></tr></thead><tbody>${rows}</tbody></table>${pagination}</section><footer class="footer">Lapped 2026</footer></main><script>const toggle=document.querySelector('#theme-toggle'),label=document.querySelector('#theme-label'),root=document.documentElement;function setTheme(theme){root.dataset.theme=theme;toggle.checked=theme==='light';label.textContent=theme+' mode'}setTheme(localStorage.getItem('lapped-theme')==='dark'?'dark':'light');toggle.onchange=()=>{const theme=toggle.checked?'light':'dark';setTheme(theme);localStorage.setItem('lapped-theme',theme)};document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(item=>item.setAttribute('aria-pressed',item===button));document.querySelectorAll('.chart').forEach(chart=>chart.hidden=chart.dataset.range!==button.dataset.tab)});const search=document.querySelector('.search input');let searchTimer;search?.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>search.form.submit(),280)})</script></body></html>`;
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
      return res.redirect("/?admin=1#connect-card");
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

function leaderboardName(token) {
  return [token.athlete?.firstname, token.athlete?.lastname].filter(Boolean).join(" ") || "Unnamed athlete";
}

function freshYtdScan() {
  const year = new Date().getUTCFullYear();
  return {
    algorithm: "date-ranges-v2",
    year,
    status: "loading",
    value: null,
    total: 0,
    seen: [],
    ranges: [{ start: new Date(Date.UTC(year, 0, 1)).toISOString(), end: new Date().toISOString() }]
  };
}

async function ensureLeaderboard(tokens) {
  const board = await readEncryptedStore(leaderboardStore);
  board.athletes ||= {};
  let changed = false;
  for (const [athleteId, token] of Object.entries(tokens)) {
    if (!board.athletes[athleteId]) {
      board.athletes[athleteId] = {
        name: leaderboardName(token),
        allTime: { status: "loading", value: null },
        ytd: freshYtdScan()
      };
      changed = true;
    } else if (board.athletes[athleteId].name !== leaderboardName(token)) {
      board.athletes[athleteId].name = leaderboardName(token);
      changed = true;
    }
    // Date cursors are unsafe because Strava does not guarantee a chronological
    // order for a 200-effort response. Rebuild old totals with bounded ranges.
    if (board.athletes[athleteId].ytd?.algorithm !== "date-ranges-v2"
      || board.athletes[athleteId].ytd?.year !== new Date().getUTCFullYear()) {
      board.athletes[athleteId].ytd = freshYtdScan();
      changed = true;
    }
  }
  if (changed) await writeEncryptedStore(leaderboardStore, board);
  scheduleLeaderboardStep(leaderboardBackfillStepMs);
  return board;
}

function scheduleLeaderboardStep(delay = leaderboardBackfillStepMs) {
  if (leaderboardTimer) return;
  leaderboardTimer = setTimeout(() => {
    leaderboardTimer = null;
    runLeaderboardStep().catch((error) => console.error("Leaderboard step failed:", error.message));
  }, delay);
  leaderboardTimer.unref?.();
}

async function runLeaderboardStep() {
  if (leaderboardBusy) return;
  leaderboardBusy = true;
  let hasPendingWork = true;
  try {
    const [board, tokens] = await Promise.all([readEncryptedStore(leaderboardStore), readTokens()]);
    const entries = Object.entries(board.athletes || {}).filter(([athleteId]) => tokens[athleteId]);
    const next = entries.find(([, entry]) => entry.allTime?.status === "loading")
      || entries.find(([, entry]) => entry.ytd?.status === "loading");
    if (!next) {
      hasPendingWork = false;
      return;
    }
    const [athleteId, entry] = next;
    const accessTokenValue = await tokenForAthlete(athleteId);
    if (entry.allTime?.status === "loading") {
      const segment = await strava(`/segments/${segmentId}`, stravaHeaders(accessTokenValue));
      entry.allTime = { status: "ready", value: Number(segment.athlete_segment_stats?.effort_count) || 0, checkedAt: Date.now() };
    } else {
      entry.ytd ||= freshYtdScan();
      const range = entry.ytd.ranges?.shift();
      if (!range) {
        entry.ytd = {
          algorithm: "date-ranges-v2",
          year: new Date().getUTCFullYear(),
          status: "ready",
          value: Number(entry.ytd.total) || 0,
          checkedAt: Date.now()
        };
        board.athletes[athleteId] = entry;
        await writeEncryptedStore(leaderboardStore, board);
        hasPendingWork = Object.entries(board.athletes || {}).some(([id, item]) => tokens[id]
          && (item.allTime?.status !== "ready" || item.ytd?.status !== "ready"));
        return;
      }
      const params = new URLSearchParams({
        segment_id: segmentId,
        start_date_local: range.start,
        end_date_local: range.end,
        per_page: "200"
      });
      const batch = await strava(`/segment_efforts?${params}`, stravaHeaders(accessTokenValue));
      const seen = new Set(entry.ytd.seen || []);
      if (batch.length >= 200) {
        const start = Date.parse(range.start);
        const end = Date.parse(range.end);
        const midpoint = start + Math.floor((end - start) / 2);
        if (!Number.isFinite(midpoint) || midpoint <= start || midpoint >= end) {
          throw new Error("Could not subdivide a full segment-effort range.");
        }
        entry.ytd.ranges.unshift(
          { start: new Date(midpoint + 1).toISOString(), end: range.end },
          { start: range.start, end: new Date(midpoint).toISOString() }
        );
      } else {
        for (const effort of batch) seen.add(String(effort.id));
      }
      entry.ytd.total = seen.size;
      entry.ytd.seen = [...seen];
    }
    board.athletes[athleteId] = entry;
    await writeEncryptedStore(leaderboardStore, board);
    hasPendingWork = Object.entries(board.athletes || {}).some(([id, item]) => tokens[id]
      && (item.allTime?.status !== "ready" || item.ytd?.status !== "ready"));
  } catch (error) {
    console.error("Slow leaderboard read failed:", error.message);
  } finally {
    leaderboardBusy = false;
    scheduleLeaderboardStep(hasPendingWork ? leaderboardBackfillStepMs : leaderboardStepMs);
  }
}

async function refreshLeaderboardLifetime(athleteId, tokens) {
  if (!tokens[athleteId]) return null;
  const board = await ensureLeaderboard(tokens);
  const accessTokenValue = await tokenForAthlete(athleteId);
  const segment = await strava(`/segments/${segmentId}`, stravaHeaders(accessTokenValue));
  const entry = board.athletes[athleteId];
  entry.allTime = { status: "ready", value: Number(segment.athlete_segment_stats?.effort_count) || 0, checkedAt: Date.now() };
  board.athletes[athleteId] = entry;
  await writeEncryptedStore(leaderboardStore, board);
  return entry.allTime.value;
}

async function addCompletedActivityToLeaderboard(athleteId, activityId, result) {
  if (!result?.changed || !athleteId || !activityId) return;
  const board = await readEncryptedStore(leaderboardStore);
  const entry = board.athletes?.[athleteId];
  if (!entry) return; // Historical sync has not started for this athlete yet.
  entry.activityIds ||= [];
  if (entry.activityIds.includes(String(activityId))) return;
  entry.activityIds = [...entry.activityIds.slice(-499), String(activityId)];
  if (entry.allTime?.status === "ready") entry.allTime.value += result.lapCount;
  const year = new Date().getUTCFullYear();
  if (entry.ytd?.status === "ready" && new Date(result.activityStart || 0).getUTCFullYear() === year) entry.ytd.value += result.lapCount;
  board.athletes[athleteId] = entry;
  await writeEncryptedStore(leaderboardStore, board);
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

function activityIdFromStravaUrl(url) {
  if (!new Set(["www.strava.com", "strava.com"]).has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/activities\/(\d+)(?:\/.*)?$/);
  return match?.[1] || null;
}

async function parseStravaActivityUrl(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const directActivityId = activityIdFromStravaUrl(url);
  if (directActivityId) return directActivityId;
  if (!new Set(["strava.app.link", "www.strava.app.link"]).has(url.hostname.toLowerCase())) return null;

  // iOS shares Strava's Branch-style app links, which open the native app on
  // the phone. Resolve only through Strava-owned hosts so this admin-only
  // convenience cannot become an arbitrary server-side URL fetch.
  let nextUrl = url;
  const allowedHosts = new Set(["strava.app.link", "www.strava.app.link", "strava.com", "www.strava.com"]);
  for (let hop = 0; hop < 5; hop += 1) {
    let response;
    try {
      response = await fetch(nextUrl, {
        redirect: "manual",
        headers: { "user-agent": "Lapped activity checker/1.0" }
      });
    } catch {
      return null;
    }
    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      const redirected = new URL(location, nextUrl);
      if (!allowedHosts.has(redirected.hostname.toLowerCase())) return null;
      const activityId = activityIdFromStravaUrl(redirected);
      if (activityId) return activityId;
      nextUrl = redirected;
      continue;
    }
    if (!response.ok) return null;
    const page = await response.text();
    const activityMatch = page.match(/https?:\/\/(?:www\.)?strava\.com\/activities\/(\d+)/i);
    return activityMatch?.[1] || null;
  }
  return null;
}

function athleteDisplayName(athlete) {
  return [athlete?.firstname, athlete?.lastname].filter(Boolean).join(" ") || "Connected athlete";
}

function isRateLimitError(error) {
  return Number(error?.status) === 429;
}

// A manual retry is tied to the athlete selected by the owner. This avoids
// probing other athletes' private activities or using their tokens for an
// unrelated support request.
async function findConnectedActivity(activityId, athleteId, tokens) {
  if (!tokens[athleteId]) return { status: "not-connected", activityId };
  const token = await tokenForAthlete(athleteId);
  try {
    const activity = await strava(`/activities/${activityId}?include_all_efforts=true`, stravaHeaders(token));
    if (String(activity.athlete?.id || "") !== String(athleteId)) return { status: "not-connected", activityId };
    return { status: "found", activityId, athleteId: String(athleteId), token, activity };
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    return { status: "inaccessible", activityId };
  }
}

async function reviewManualActivity(value, athleteId, tokens) {
  const activityId = await parseStravaActivityUrl(value);
  if (!activityId) return { status: "invalid", message: "Paste a valid Strava activity or Strava app link." };
  const match = await findConnectedActivity(activityId, String(athleteId || ""), tokens);
  if (match.status === "not-connected") return { ...match, message: "This ride does not belong to the selected connected athlete." };
  if (match.status !== "found") return { ...match, message: "Lapped could not access this ride with the selected athlete’s Strava connection." };

  const efforts = (match.activity.segment_efforts || []).filter(isTargetEffort);
  const lapCount = efforts.length;
  const athleteName = athleteDisplayName(tokens[match.athleteId]?.athlete || match.activity.athlete);
  const fastestLap = formatFastestLap(efforts);
  const alreadyProcessed = await activityWasProcessed(match.athleteId, activityId);
  const alreadyDescribed = hasLappedReceipt(match.activity.description);
  const details = `${athleteName} · ${lapCount} completed High Park lap${lapCount === 1 ? "" : "s"}${fastestLap ? ` · fastest lap ${fastestLap}` : ""}`;
  if (alreadyProcessed || alreadyDescribed) {
    return { ...match, status: "already", lapCount, fastestLap, message: `${details}. It already has a Lapped receipt, so nothing will be changed.` };
  }
  if (!lapCount) return { ...match, status: "no-laps", lapCount: 0, message: `${athleteName}'s ride has no completed High Park laps. Nothing will be changed.` };
  return { ...match, status: "ready", lapCount, fastestLap, message: `${details}. Ready to push the standard Lapped receipt.` };
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

async function scanActivityWithToken(token, activityId, athleteId, { retryIfProcessing = false, activity: loadedActivity = null } = {}) {
  const activity = loadedActivity || await strava(`/activities/${activityId}?include_all_efforts=true`, { headers: { Authorization: `Bearer ${token}` } });
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
  return { lapCount, changed: true, description, activityStart: activity.start_date };
}

app.get("/auth/strava", (req, res) => {
  if (configError) return res.status(503).send(`Missing configuration: ${configError}`);
  if (req.query.consent !== "yes") return res.status(400).send("Please review and accept Lapped’s data use and privacy terms before connecting Strava.");
  req.session.consentAt = new Date().toISOString();
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
app.get("/waitlist", (_req, res) => res.type("html").send(waitlistPage()));
app.post("/api/waitlist", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
    const email = String(req.body?.email || "").trim().toLowerCase();
    const rawStravaUrl = String(req.body?.stravaUrl || "").trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Please enter your name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Please enter a valid email." });
    let stravaUrl = "";
    if (rawStravaUrl) {
      let parsed;
      try { parsed = new URL(rawStravaUrl); } catch { return res.status(400).json({ error: "Please use a valid Strava link, or leave it blank." }); }
      if (!/^https:$/.test(parsed.protocol) || !(/(^|\.)strava\.com$/.test(parsed.hostname) || parsed.hostname === "strava.app.link")) return res.status(400).json({ error: "Please use a Strava link, or leave it blank." });
      stravaUrl = parsed.toString();
    }
    if (!canSubmitWaitlist(req)) return res.status(429).json({ error: "You’re already on the list, or please try again in an hour." });
    const saved = await saveWaitlistLead({ name, email, stravaUrl });
    res.status(saved.existing ? 200 : 201).json({ ok: true, existing: saved.existing });
  } catch (error) { next(error); }
});
app.get("/account/data", async (req, res, next) => {
  try {
    const athleteId = String(req.session.strava?.athlete?.id || "");
    if (!athleteId) return res.status(401).json({ error: "Connect Strava to view your Lapped data." });
    const token = (await readTokens())[athleteId];
    res.json({
      athlete: {
        id: athleteId,
        name: athleteDisplayName(token?.athlete || req.session.strava?.athlete),
        connectedAt: token?.connected_at || null
      },
      retained: [
        "Your Strava athlete ID and display name while connected",
        "Encrypted authorization tokens while connected",
        "A duplicate-prevention activity cache for up to seven days"
      ],
      notRetained: ["Activity history", "segment-effort history", "leaderboards or cross-athlete rankings"]
    });
  } catch (error) { next(error); }
});
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
    const [analytics, tickets, waitlist] = await Promise.all([
      readEncryptedStore(analyticsStore),
      readEncryptedStore(featureRequestsStore),
      readEncryptedStore(waitlistStore)
    ]);
    const pageHtml = adminPage(req.connectedTokens, analytics, { page, query }).replace(
      '<section class="metrics">',
      `<section class="metrics"><div class="metric"><strong>${Object.keys(req.connectedTokens).length}</strong><span>connected athletes</span></div>`
    );
    const extras = `${waitlistPanel(waitlist)}${ticketPanel(tickets)}`;
    res.type("html").send(pageHtml.replace("<footer class=\"footer\">", `${extras}<footer class="footer">`).replace("</body>", `${adminEnhancements}${manualPushEnhancements}</body>`));
  } catch (error) { next(error); }
});
app.get("/admin/athletes", requireAdmin, (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const query = String(req.query.q || "").slice(0, 80);
  res.json(connectedAthletePage(req.connectedTokens, page, query));
});
app.get("/admin/athletes/:athleteId/disconnect", requireAdmin, (req, res) => {
  const athleteId = String(req.params.athleteId || "");
  const athlete = req.connectedTokens[athleteId]?.athlete;
  if (!athlete) return res.sendStatus(404);
  const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || "this athlete";
  res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disconnect athlete — Lapped</title><style>body{margin:0;background:#f3f0ea;color:#20201e;font:16px Arial,sans-serif;padding:48px 24px}.wrap{max-width:520px;margin:auto}h1{font:400 42px Georgia,serif;margin:0 0 18px}p{line-height:1.55;color:#6f6b65}form{margin-top:30px;display:flex;gap:12px;align-items:center}button,a{font:14px Arial;padding:11px 14px;border:1px solid #20201e;background:#20201e;color:#f3f0ea;text-decoration:none;cursor:pointer}a{background:transparent;color:#20201e}</style><main class="wrap"><h1>Disconnect ${escapeHtml(name)}?</h1><p>This removes only Strava athlete ${escapeHtml(athleteId)} from Lapped and revokes Lapped’s Strava authorization for that account. It does not affect any other connected athlete.</p><form method="post" action="/admin/athletes/${encodeURIComponent(athleteId)}/disconnect"><button type="submit">Disconnect athlete</button><a href="/admin">Cancel</a></form></main>`);
});
app.post("/admin/activity-review/check", requireAdmin, async (req, res, next) => {
  try {
    const review = await reviewManualActivity(req.body?.url, req.body?.athleteId, req.connectedTokens);
    res.status(review.status === "invalid" ? 400 : 200).json({
      status: review.status,
      activityId: review.activityId || null,
      lapCount: review.lapCount ?? null,
      fastestLap: review.fastestLap || null,
      message: review.message
    });
  } catch (error) {
    if (isRateLimitError(error)) return res.status(429).json({ error: "Strava is temporarily rate-limiting checks. Wait a few minutes, then try again." });
    next(error);
  }
});
app.post("/admin/activity-review/apply", requireAdmin, async (req, res, next) => {
  try {
    const review = await reviewManualActivity(req.body?.url, req.body?.athleteId, req.connectedTokens);
    if (review.status !== "ready") {
      return res.status(review.status === "invalid" ? 400 : 200).json({
        status: review.status,
        activityId: review.activityId || null,
        lapCount: review.lapCount ?? null,
        fastestLap: review.fastestLap || null,
        message: review.message
      });
    }
    // Pass the just-read activity through to the normal scanner. This avoids a
    // second Strava read after confirmation while retaining every existing
    // duplicate-prevention and description-preservation rule.
    const result = await scanActivityWithToken(review.token, review.activityId, review.athleteId, { activity: review.activity });
    const status = result.changed ? "pushed" : "already";
    const message = result.changed
      ? `${athleteDisplayName(req.connectedTokens[review.athleteId]?.athlete)} · ${result.lapCount} completed High Park lap${result.lapCount === 1 ? "" : "s"}${review.fastestLap ? ` · fastest lap ${review.fastestLap}` : ""}. Lapped receipt added.`
      : "This ride already has a Lapped receipt, so nothing was changed.";
    res.json({ status, activityId: review.activityId, lapCount: result.lapCount, fastestLap: review.fastestLap, message });
  } catch (error) {
    if (isRateLimitError(error)) return res.status(429).json({ error: "Strava is temporarily rate-limiting writes. Wait a few minutes, then try again." });
    next(error);
  }
});
app.post("/admin/athletes/:athleteId/disconnect", requireAdmin, async (req, res, next) => {
  try {
    const athleteId = String(req.params.athleteId || "");
    if (!/^\d+$/.test(athleteId)) return res.status(400).json({ error: "Invalid athlete ID." });
    const token = req.connectedTokens[athleteId];
    if (!token) return res.sendStatus(404);
    // This endpoint is deliberately admin-only: it is for correcting an
    // accidentally linked athlete, never an automatic connection cleanup.
    await removeConnectedAthlete(athleteId);
    if (token.access_token) {
      await fetch("https://www.strava.com/oauth/deauthorize", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}` }
      }).catch(() => {});
    }
    if (req.accepts("html")) return res.redirect("/admin");
    res.json({ ok: true, athleteId });
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
app.post("/admin/waitlist/:id", requireAdmin, async (req, res, next) => {
  try {
    const action = String(req.body?.action || "");
    if (!new Set(["archive", "delete"]).has(action)) return res.status(400).json({ error: "Invalid action." });
    const stored = await readEncryptedStore(waitlistStore);
    const leads = Array.isArray(stored) ? stored : [];
    const index = leads.findIndex((lead) => lead.id === req.params.id);
    if (index === -1) return res.sendStatus(404);
    if (action === "delete") leads.splice(index, 1);
    else leads[index].status = action;
    await writeEncryptedStore(waitlistStore, leads);
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
    .then(async (token) => {
      const result = await scanActivityWithToken(token, event.object_id, event.owner_id, { retryIfProcessing: event.aspect_type === "create" });
    })
    .catch((error) => console.error("Webhook scan failed:", error.message));
});
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || "Something went wrong." }));
async function startServer() {
  await pruneStravaCaches();
  const cachePruner = setInterval(() => {
    pruneStravaCaches().catch((error) => console.error("Strava cache cleanup failed:", error.message));
  }, 24 * 60 * 60 * 1000);
  cachePruner.unref?.();
  app.listen(process.env.PORT || 3000, process.env.HOST || (process.env.RENDER_EXTERNAL_URL ? "0.0.0.0" : "127.0.0.1"), () => {
    console.log(`Lapped running at ${baseUrl}`);
  });
}

startServer().catch((error) => {
  console.error("Lapped could not start:", error.message);
  process.exitCode = 1;
});
