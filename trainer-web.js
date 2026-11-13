import express from "express";
import path from "node:path";

/** True for any request aimed at the trainer, however the path is spelled (case, repeated slashes, %-encoding). */
export function isTrainerPath(rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath); } catch { return true; } // undecodable: treat as trainer and refuse
  p = path.posix.normalize("/" + p.replace(/\\/g, "/")).toLowerCase();
  return /^\/(api\/)?trainer(\/|$)/.test(p);
}

// Only approved athletes (the lapped admin plus the /admin whitelist) can open the trainer or its API.
// This guard never starts Strava OAuth and never reads or writes anyone's lapped connection:
// it only compares the signed-in athlete ID with the approved list.
export function mountTrainerAccessGuard(app, { isApproved, landing = new URL("./trainer-waitlist.html", import.meta.url).pathname }) {
  app.use((req, res, next) => {
    if (!isTrainerPath(req.path)) return next();
    res.set("Cache-Control", "private, no-store");
    const id = String(req.session?.strava?.athlete?.id || "");
    if (/^\d+$/.test(id) && isApproved(id)) {
      if (req.method === "GET" && /^\/trainer\/connect\/?$/.test(req.path)) return res.redirect("/trainer/");
      return next();
    }
    // Not on the whitelist (signed in or not): the trainer page is the waitlist. Everything else stays hidden.
    if (req.method === "GET" && /^\/trainer(\/|\/index\.html)?$/.test(req.path)) return res.sendFile(landing);
    res.status(404).type("text").send("Not found");
  });
}

// Browser version of Indoor Trainer at /trainer. Riders sign in with lapped's existing Strava
// connection (same session cookie); rides upload to Strava through these two routes.
// Settings and finished rides are saved per Strava athlete in `store`, so they follow the rider to any browser.
export function mountTrainerWeb(app, { origin, accessToken, store, fetchStrava = fetch, now = Date.now }) {
  const router = express.Router();
  const recentUploads = new Map();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const athleteId = (req) => {
    const id = String(req.session?.strava?.athlete?.id || "");
    return /^\d+$/.test(id) ? id : null;
  };

  router.get("/me", (req, res) => {
    const athlete = req.session?.strava?.athlete;
    res.json({
      connected: Boolean(athleteId(req)),
      athlete: athlete ? { id: String(athlete.id), firstname: athlete.firstname || "", lastname: athlete.lastname || "" } : null
    });
  });

  function sameOriginWithAthlete(req, res, next) {
    // Session cookies are SameSite=Lax; the Origin check also rejects cross-site form posts.
    // Browsers omit Origin on same-origin GETs, which only read upload status.
    if (req.method !== "GET" && req.get("origin") !== origin) return res.status(403).json({ message: "Open the trainer on lapped.fit and try again." });
    const id = athleteId(req);
    if (!id) return res.status(401).json({ message: "Connect with Strava first." });
    req.trainerAthlete = id;
    next();
  }

  function rateLimit(req, res, next) {
    const hour = 3600 * 1000;
    const times = (recentUploads.get(req.trainerAthlete) || []).filter((t) => now() - t < hour);
    if (times.length >= 30) return res.status(429).json({ message: "Too many uploads this hour. Try again later." });
    times.push(now());
    recentUploads.set(req.trainerAthlete, times);
    next();
  }

  async function strava(req, res, url, options) {
    try {
      const access = await accessToken(req);
      const upstream = await fetchStrava(url, {
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${access}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000)
      });
      res.status(upstream.status).type("json").send(await upstream.text());
    } catch {
      res.status(502).json({ message: "Lapped could not reach Strava with your connection. Try again, or reconnect Strava." });
    }
  }

  router.post("/uploads", sameOriginWithAthlete, rateLimit,
    express.raw({ type: ["application/vnd.garmin.tcx+xml", "application/xml"], limit: "25mb" }),
    async (req, res) => {
      const text = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      if (!text.startsWith("<?xml") || !text.includes("<TrainingCenterDatabase")) return res.status(400).json({ message: "Invalid ride file." });
      const field = (name, max) => String(req.query[name] || "").slice(0, max);
      const externalId = field("external_id", 80);
      if (externalId && !/^indoortrainer-[A-Za-z0-9-]+$/.test(externalId)) return res.status(400).json({ message: "Invalid ride id." });
      const form = new FormData();
      form.append("file", new Blob([req.body], { type: "application/xml" }), "ride.tcx");
      form.append("data_type", "tcx");
      form.append("trainer", "1");
      if (field("name", 120)) form.append("name", field("name", 120));
      if (field("description", 2000)) form.append("description", field("description", 2000));
      if (externalId) form.append("external_id", externalId);
      await strava(req, res, "https://www.strava.com/api/v3/uploads", { method: "POST", body: form });
    });

  router.get("/uploads/:id", sameOriginWithAthlete, async (req, res) => {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.sendStatus(400);
    await strava(req, res, `https://www.strava.com/api/v3/uploads/${req.params.id}`, { method: "GET" });
  });

  // Strava's API cannot set "Only You"; muting (hide_from_home) keeps the ride out of followers' feeds.
  router.put("/activities/:id/mute", sameOriginWithAthlete, async (req, res) => {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.sendStatus(400);
    await strava(req, res, `https://www.strava.com/api/v3/activities/${req.params.id}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ hide_from_home: true })
    });
  });

  // ---------- Saved data (settings, ride history) ----------
  const prefRules = {
    ftp: (v) => Number.isInteger(v) && v >= 1 && v <= 1000,
    weightKg: (v) => typeof v === "number" && v >= 20 && v <= 200,
    maxHeartRate: (v) => Number.isInteger(v) && v >= 100 && v <= 230,
    riderName: (v) => typeof v === "string" && v.length <= 40,
    workoutFavorites: (v) => Array.isArray(v) && v.length <= 100 && v.every((n) => typeof n === "string" && n.length <= 80),
    appearance: (v) => v === "Dark" || v === "Light",
    stravaAutoUpload: (v) => typeof v === "boolean"
  };
  const rideId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const maxRides = 3000, maxSeconds = 12 * 3600;
  const locks = new Map();
  // One read-modify-write at a time per rider, so two tabs saving at once never lose an update.
  const withIndex = (athlete, change) => {
    const run = (locks.get(athlete) || Promise.resolve()).then(async () => {
      const index = { prefs: {}, rides: {}, deleted: [], ...(await store.read(athlete, "index")) };
      const result = await change(index);
      if (result !== false) await store.write(athlete, "index", index);
      return index;
    });
    locks.set(athlete, run.catch(() => {}));
    return run;
  };
  const saved = (handler) => async (req, res) => {
    if (!store) return res.sendStatus(503);
    try { await handler(req, res); } catch (error) {
      console.error("Trainer data failed:", error.message);
      res.status(500).json({ message: "Could not save to lapped. Your data is still in this browser." });
    }
  };

  router.get("/data", sameOriginWithAthlete, saved(async (req, res) => {
    const index = await withIndex(req.trainerAthlete, () => false);
    res.json({ prefs: index.prefs, rides: Object.values(index.rides), deleted: index.deleted });
  }));

  router.put("/prefs", sameOriginWithAthlete, express.json({ limit: "32kb" }), saved(async (req, res) => {
    const changes = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const keys = Object.keys(changes);
    if (!keys.length || keys.some((k) => !prefRules[k] || (changes[k] !== null && !prefRules[k](changes[k])))) return res.status(400).json({ message: "Invalid setting." });
    await withIndex(req.trainerAthlete, (index) => { for (const k of keys) changes[k] === null ? delete index.prefs[k] : (index.prefs[k] = changes[k]); });
    res.sendStatus(204);
  }));

  router.get("/rides/:id/samples", sameOriginWithAthlete, saved(async (req, res) => {
    if (!rideId.test(req.params.id)) return res.sendStatus(400);
    const file = await store.read(req.trainerAthlete, req.params.id);
    if (!file.samples) return res.sendStatus(404);
    res.json({ samples: file.samples });
  }));

  router.put("/rides/:id", sameOriginWithAthlete, express.json({ limit: "8mb" }), saved(async (req, res) => {
    const id = req.params.id, ride = req.body?.ride, samples = req.body?.samples;
    const number = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
    if (!rideId.test(id) || !ride || typeof ride !== "object" || ride.id !== id || ride.state !== "finished"
      || !Array.isArray(samples) || samples.length > maxSeconds
      || !samples.every((s) => Array.isArray(s) && s.length === 3 && s.every(number))
      || JSON.stringify(ride).length > 64 * 1024) return res.status(400).json({ message: "Invalid ride." });
    const { athlete: _a, remote: _r, ...summary } = ride;
    let refused = false;
    await withIndex(req.trainerAthlete, async (index) => {
      if (index.deleted.includes(id)) { refused = true; return false; }
      if (!index.rides[id] && Object.keys(index.rides).length >= maxRides) { refused = true; return false; }
      await store.write(req.trainerAthlete, id, { samples });
      index.rides[id] = summary;
    });
    res.sendStatus(refused ? 409 : 204);
  }));

  router.delete("/rides/:id", sameOriginWithAthlete, saved(async (req, res) => {
    const id = req.params.id;
    if (!rideId.test(id)) return res.sendStatus(400);
    await withIndex(req.trainerAthlete, async (index) => {
      delete index.rides[id];
      // Tombstones stop another browser that still has the ride from uploading it again.
      index.deleted = [...index.deleted.filter((d) => d !== id), id].slice(-5000);
      await store.remove(req.trainerAthlete, id);
    });
    res.sendStatus(204);
  }));

  app.use("/api/trainer", router);
}
