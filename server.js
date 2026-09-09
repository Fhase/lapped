import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import session from "express-session";

const required = ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "HIGH_PARK_SEGMENT_ID"];
const configError = required.filter((name) => !process.env[name]).join(", ");
const app = express();
const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
const segmentId = String(process.env.HIGH_PARK_SEGMENT_ID || "");
const dataDir = process.env.DATA_DIR || new URL("./data", import.meta.url).pathname;
const tokenStore = path.join(dataDir, "tokens.json");
const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY
  ? crypto.createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY).digest()
  : null;
// A short-lived server-side record keeps OAuth safe if a privacy extension strips
// the session cookie during Strava's cross-site return.
const pendingOAuthStates = new Map();

// Render terminates TLS before forwarding requests to this process. Trust that
// single proxy so secure session cookies are issued to the browser correctly.
app.set("trust proxy", 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "change-me-before-production",
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: "lax", secure: process.env.NODE_ENV === "production" }
}));
app.use(express.static("public"));

const strava = async (path, options = {}) => {
  const response = await fetch(`https://www.strava.com/api/v3${path}`, options);
  if (!response.ok) throw new Error(`Strava returned ${response.status}: ${await response.text()}`);
  return response.json();
};

async function readTokens() {
  try {
    const stored = JSON.parse(await fs.readFile(tokenStore, "utf8"));
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
async function saveToken(token) {
  if (!token.athlete?.id) return;
  await fs.mkdir(dataDir, { recursive: true });
  const tokens = await readTokens();
  tokens[token.athlete.id] = token;
  if (!tokenEncryptionKey) return fs.writeFile(tokenStore, JSON.stringify(tokens, null, 2));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  await fs.writeFile(tokenStore, JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  }));
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

function isTargetEffort(effort) {
  return String(effort.segment?.id ?? effort.segment_id ?? "") === segmentId;
}

async function scanActivity(req, activityId) {
  const token = await accessToken(req);
  return scanActivityWithToken(token, activityId);
}
async function scanActivityWithToken(token, activityId) {
  const activity = await strava(`/activities/${activityId}?include_all_efforts=true`, { headers: { Authorization: `Bearer ${token}` } });
  const lapCount = (activity.segment_efforts || []).filter(isTargetEffort).length;
  if (!lapCount) return { lapCount: 0, changed: false, description: activity.description ?? "" };

  const stamp = `Loops: ${lapCount}\nhttps://lapped.onrender.com`;
  // Do not overwrite the user's writing. The app replaces only its own stamp,
  // including the older High Park laps format already written to past rides.
  const existing = (activity.description || "")
    .replace(/(?:^|\n)High Park laps: \d+(?=\n|$)/g, "")
    .replace(/(?:^|\n)Loops: \d+(?:\nhttps:\/\/lapped\.onrender\.com)?(?=\n|$)/g, "")
    .trim();
  const description = [existing, stamp].filter(Boolean).join("\n");
  // Strava also emits an update event for our own description write. Do not
  // write an identical value back and accidentally create a webhook loop.
  if (description === (activity.description ?? "")) return { lapCount, changed: false, description };
  await strava(`/activities/${activityId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ description })
  });
  return { lapCount, changed: true, description };
}

app.get("/auth/strava", (req, res) => {
  if (configError) return res.status(503).send(`Missing configuration: ${configError}`);
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
    res.redirect("/?connected=1");
  } catch (error) { next(error); }
});

app.get("/api/status", (req, res) => res.json({ connected: Boolean(req.session.strava), configured: !configError, segmentId: segmentId || null }));
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.post("/api/activities/:id/scan", async (req, res, next) => {
  try { res.json(await scanActivity(req, req.params.id)); } catch (error) { next(error); }
});
app.post("/auth/disconnect", (req, res) => req.session.destroy(() => res.status(204).end()));
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
    .then((token) => scanActivityWithToken(token, event.object_id))
    .catch((error) => console.error("Webhook scan failed:", error.message));
});
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || "Something went wrong." }));
app.listen(process.env.PORT || 3000, process.env.HOST || (process.env.RENDER_EXTERNAL_URL ? "0.0.0.0" : "127.0.0.1"), () => console.log(`Lapped running at ${baseUrl}`));
