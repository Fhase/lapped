import crypto from "node:crypto";
import express from "express";
import path from "node:path";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const challengeFor = (value) => crypto.createHash("sha256").update(value).digest("base64url");
const random = () => crypto.randomBytes(32).toString("base64url");
const lifetime = 30 * 24 * 60 * 60 * 1000;

export function createYtdRefresh({ readStats, writeStats, personalStatsFor, schedule, now = Date.now }) {
  let queue = Promise.resolve();
  return (athleteId) => {
    const result = queue.then(async () => {
      const stats = await readStats();
      const entry = stats[athleteId];
      if (!entry || entry.version !== 6) return personalStatsFor(athleteId);
      if (entry.status !== "ready" || now() - Number(entry.mobileRefreshAt || 0) < 60 * 60 * 1000) return entry;
      const year = new Date(now()).getUTCFullYear();
      if (entry.year !== year) entry.ytd = null;
      Object.assign(entry, {
        status: "queued", phase: "ytd", year,
        ytdRanges: [{ start: new Date(Date.UTC(year, 0, 1)).toISOString(), end: new Date(now()).toISOString() }],
        ytdSeen: [], ytdTotal: 0, mobileRefreshAt: now(), queuedAt: now()
      });
      await writeStats(stats);
      schedule();
      return entry;
    });
    queue = result.catch(() => {});
    return result;
  };
}

// App sessions have their own store. Signing out here never calls Strava's
// deauthorize endpoint or removes anything from the existing connections store.
export function mountMobile(app, deps) {
  const { baseUrl, dataDir, readEncryptedStore, writeEncryptedStore, readTokens, saveToken,
    tokenForAthlete, segmentId, hasLappedReceipt, personalStatsFor, refreshYtd } = deps;
  const sessionsFile = path.join(dataDir, "mobile-sessions.json");
  const pending = new Map(), codes = new Map(), attempts = new Map(), jobs = new Map();
  let writeQueue = Promise.resolve(), worker = null, workerBusy = false;
  let quota = [], blockedUntil = 0;
  const transaction = (operation) => {
    const next = writeQueue.then(operation);
    writeQueue = next.catch(() => {});
    return next;
  };
  const clean = () => {
    const now = Date.now();
    for (const [key, value] of pending) if (now - value.created > 10 * 60 * 1000) pending.delete(key);
    for (const [key, value] of codes) if (now - value.created > 60 * 1000) codes.delete(key);
    for (const [key, value] of jobs) if (now - value.updatedAt > 30 * 60 * 1000) jobs.delete(key);
    for (const [key, value] of attempts) if (now - value.start > 15 * 60 * 1000) attempts.delete(key);
  };
  const limit = (req, res, next) => {
    clean();
    const key = sha(String(req.ip || "unknown"));
    const attempt = attempts.get(key) || { start: Date.now(), count: 0 };
    attempt.count += 1;
    attempts.set(key, attempt);
    if (attempt.count > 24) return res.status(429).send("Please try again in 15 minutes.");
    next();
  };
  const callback = (res, values) => {
    res.set("Cache-Control", "no-store");
    return res.redirect(`lapped-preview://auth?${new URLSearchParams(values)}`);
  };

  app.get("/auth/mobile", limit, (req, res) => {
    const challenge = String(req.query.challenge || ""), state = String(req.query.state || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{32,100}$/.test(state)) return res.sendStatus(400);
    res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'" });
    res.type("html").send(`<!doctype html><html lang="en" data-theme="light"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to lapped for iPhone</title><link rel="stylesheet" href="/styles.css"><main><nav><a class="wordmark" href="/">lapped</a></nav><section class="intro"><div><h1>Your laps. On iPhone.</h1><p class="lede">Connect your Strava account to see your own laps and rides in the local lapped app.</p><form method="post" action="/auth/mobile/start"><input type="hidden" name="challenge" value="${challenge}"><input type="hidden" name="state" value="${state}"><label><input type="checkbox" name="consent" value="yes" required> I agree to lapped’s <a href="/privacy.html">data use and privacy policy</a> and <a href="/terms.html">terms</a>.</label><p><button type="submit">Connect with Strava</button></p></form></div></section></main></html>`);
  });
  app.post("/auth/mobile/start", limit, (req, res) => {
    const challenge = String(req.body.challenge || ""), state = String(req.body.state || "");
    if (req.body.consent !== "yes" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{32,100}$/.test(state)) return res.sendStatus(400);
    const oauthState = random();
    pending.set(oauthState, { challenge, deviceState: state, created: Date.now() });
    const url = new URL("https://www.strava.com/oauth/authorize");
    url.search = new URLSearchParams({ client_id: deps.clientId, redirect_uri: `${baseUrl}/auth/strava/complete`, response_type: "code", approval_prompt: "auto", scope: "activity:read_all,activity:write", state: oauthState });
    res.redirect(url.toString());
  });

  // Mounted before the website callback; website OAuth state is never consumed.
  app.get("/auth/strava/complete", async (req, res, next) => {
    const state = String(req.query.state || ""), entry = pending.get(state);
    if (!entry) return next();
    pending.delete(state);
    try {
      if (Date.now() - entry.created > 10 * 60 * 1000 || req.query.error || !req.query.code) {
        return callback(res, { state: entry.deviceState, error: "Sign-in was cancelled or expired. Please try again." });
      }
      const scopes = String(req.query.scope || "").split(",");
      if (!scopes.includes("activity:read_all") || !scopes.includes("activity:write")) return callback(res, { state: entry.deviceState, error: "Please allow the activity permissions lapped needs." });
      const token = await deps.exchangeCode(String(req.query.code));
      if (!/^\d+$/.test(String(token.athlete?.id || "")) || !token.access_token || !token.refresh_token) throw new Error("Invalid Strava account response.");
      await saveToken(token);
      const code = random();
      codes.set(sha(code), { athleteId: String(token.athlete.id), challenge: entry.challenge, created: Date.now() });
      return callback(res, { state: entry.deviceState, code });
    } catch (_) {
      return callback(res, { state: entry.deviceState, error: "Could not finish Strava sign-in. Please try again." });
    }
  });

  const router = express.Router();
  router.use((_req, res, next) => { clean(); res.set("Cache-Control", "no-store"); next(); });
  router.post("/session/exchange", limit, async (req, res, next) => {
    try {
      const verifier = String(req.body.verifier || ""), key = sha(String(req.body.code || ""));
      const entry = codes.get(key);
      if (!entry || Date.now() - entry.created > 60000 || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || entry.challenge !== challengeFor(verifier)) return res.status(401).json({ error: "Sign-in expired. Please try again." });
      codes.delete(key); // Consume before the first await: one exchange only.
      if (!(await readTokens())[entry.athleteId]) return res.sendStatus(401);
      const session = random(), expiresAt = Date.now() + lifetime;
      await transaction(async () => {
        const stored = await readEncryptedStore(sessionsFile);
        const fresh = Object.fromEntries(Object.entries(stored).filter(([, item]) => item.expiresAt > Date.now()));
        fresh[sha(session)] = { athleteId: entry.athleteId, expiresAt };
        await writeEncryptedStore(sessionsFile, fresh);
      });
      res.json({ session, expiresAt });
    } catch (error) { next(error); }
  });
  router.use(async (req, res, next) => {
    try {
      const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!bearer) return res.status(401).json({ error: "Sign in to Strava first." });
      const key = sha(bearer), entry = (await readEncryptedStore(sessionsFile))[key];
      if (!entry || entry.expiresAt <= Date.now()) return res.status(401).json({ error: "Your app session expired. Sign in again." });
      const token = (await readTokens())[entry.athleteId];
      if (!token) return res.status(401).json({ error: "This account is no longer connected to lapped." });
      req.mobileAthleteId = entry.athleteId;
      req.mobileSessionKey = key;
      req.mobileAthlete = token.athlete;
      next();
    } catch (error) { next(error); }
  });
  router.delete("/session", async (req, res, next) => {
    try {
      await transaction(async () => {
        const stored = await readEncryptedStore(sessionsFile);
        delete stored[req.mobileSessionKey];
        await writeEncryptedStore(sessionsFile, stored);
      });
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  router.get("/me", (req, res) => res.json({ id: req.mobileAthleteId, name: [req.mobileAthlete?.firstname, req.mobileAthlete?.lastname].filter(Boolean).join(" ") || "Your laps" }));
  const statsResult = (stats) => ({
    status: stats?.status || "queued", year: stats?.year || new Date().getUTCFullYear(),
    lifetime: Number.isFinite(stats?.lifetime) ? stats.lifetime : null,
    ytd: Number.isFinite(stats?.ytd) ? stats.ytd : null,
    ytdPartial: Number.isFinite(stats?.ytdTotal) ? stats.ytdTotal : null,
    fastestLap: stats?.fastestLap || null, checkedAt: stats?.checkedAt || null
  });
  router.get("/stats", async (req, res, next) => {
    try { res.json(statsResult(await personalStatsFor(req.mobileAthleteId))); } catch (error) { next(error); }
  });
  router.post("/stats/ytd/refresh", async (req, res, next) => {
    try { res.status(202).json(statsResult(await refreshYtd(req.mobileAthleteId))); } catch (error) { next(error); }
  });

  // All mobile history reads share one small budget, in addition to respecting
  // Strava's actual read limits. Upload processing keeps the remaining headroom.
  async function readStrava(athleteId, resource) {
    const now = Date.now();
    quota = quota.filter((time) => now - time < 15 * 60 * 1000);
    if (now < blockedUntil || quota.length >= 20) {
      const error = new Error("History is waiting for the next API window."); error.status = 429; throw error;
    }
    quota.push(now);
    const token = await tokenForAthlete(athleteId);
    const response = await (deps.fetch || fetch)(`https://www.strava.com/api/v3${resource}`, { headers: { Authorization: `Bearer ${token}` } });
    for (const prefix of ["x-readratelimit", "x-ratelimit"]) {
      const limits = (response.headers.get(`${prefix}-limit`) || "").split(",").map(Number);
      const used = (response.headers.get(`${prefix}-usage`) || "").split(",").map(Number);
      if (limits[0] > 0 && used[0] >= limits[0] * 0.7) blockedUntil = Math.max(blockedUntil, now + 16 * 60 * 1000);
      if (limits[1] > 0 && used[1] >= limits[1] * 0.7) blockedUntil = Math.max(blockedUntil, new Date().setUTCHours(24, 1, 0, 0));
    }
    if (!response.ok) {
      if (response.status === 429) blockedUntil = Math.max(blockedUntil, now + 16 * 60 * 1000);
      const error = new Error("Strava could not load this ride right now."); error.status = response.status; throw error;
    }
    return response.json();
  }
  function rideResult(activity, athleteId) {
    if (String(activity.athlete?.id || "") !== athleteId) return null;
    const efforts = (activity.segment_efforts || []).filter((effort) => String(effort.segment?.id || effort.segment_id) === String(segmentId) && Number(effort.elapsed_time) > 0)
      .sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")) || Number(a.start_index || 0) - Number(b.start_index || 0));
    if (!efforts.length || !hasLappedReceipt(activity.description)) return null;
    return { id: String(activity.id), title: activity.name || "High Park ride", date: activity.start_date,
      receipt: activity.description || "", laps: efforts.map((effort, index) => ({ id: index + 1, seconds: Math.round(Number(effort.elapsed_time)), distanceMeters: Number(effort.distance) > 0 ? Number(effort.distance) : null })) };
  }
  function schedule() {
    if (worker || deps.disableWorker) return;
    worker = setTimeout(() => { worker = null; step().catch(() => {}); }, 15000);
    worker.unref?.();
  }
  async function step() {
    if (workerBusy) return;
    workerBusy = true;
    try {
      clean();
      const entry = [...jobs.values()].filter((job) => job.status === "loading").sort((a,b) => a.lastStep - b.lastStep)[0];
      if (!entry) return;
      if (!(await readTokens())[entry.athleteId]) { jobs.delete(entry.athleteId); return; }
      entry.lastStep = Date.now();
      try {
        if (!entry.ids) {
          const activities = await readStrava(entry.athleteId, `/athlete/activities?page=${entry.page}&per_page=20`);
          entry.hasMore = activities.length === 20;
          entry.ids = activities.filter((activity) => /ride/i.test(activity.sport_type || activity.type || "")).map((activity) => String(activity.id));
        } else if (entry.index < entry.ids.length) {
          const activity = await readStrava(entry.athleteId, `/activities/${entry.ids[entry.index]}?include_all_efforts=true`);
          const ride = rideResult(activity, entry.athleteId);
          if (ride) entry.rides.push(ride);
          entry.index += 1;
        } else { entry.status = "ready"; }
        entry.message = "";
      } catch (error) {
        if (error.status === 429) entry.message = "History is loading slowly to leave room for ride uploads. Come back in a while.";
        else if ([403,404].includes(error.status) && entry.ids) entry.index += 1;
        else { entry.status = "error"; entry.message = "Couldn’t load ride history. Try again later."; }
      }
      entry.updatedAt = Date.now();
    } finally {
      workerBusy = false;
      if ([...jobs.values()].some((job) => job.status === "loading")) schedule();
    }
  }
  router.get("/rides", (req, res) => {
    clean();
    const page = Math.min(100, Math.max(1, parseInt(req.query.page, 10) || 1));
    let job = jobs.get(req.mobileAthleteId);
    if (!job || job.page !== page) {
      // Don't let rapid page changes replace an in-flight job and burn reads.
      if (job?.status === "loading") return res.status(409).json({ error: "Wait for the current page to finish loading." });
      job = { athleteId: req.mobileAthleteId, page, ids: null, index: 0, rides: [], status: "loading", lastStep: 0, updatedAt: Date.now(), hasMore: false };
      jobs.set(req.mobileAthleteId, job);
    }
    schedule();
    res.json({ rides: job.rides, status: job.status, page: job.page, hasMore: job.hasMore, scanned: job.index, total: job.ids?.length || 0, message: job.message || "" });
  });
  router.get("/rides/:id", (req, res) => {
    const ride = jobs.get(req.mobileAthleteId)?.rides.find((item) => item.id === req.params.id);
    // Details come from this athlete's own scan, never an arbitrary ID probe.
    if (!ride) return res.status(404).json({ error: "This ride is not in your current history page." });
    res.json(ride);
  });
  app.use("/api/mobile", router);
  return { step, close: () => { clearTimeout(worker); worker = null; } };
}
