import express from "express";

export function mountTrainerAccessGuard(app, isAdmin) {
  app.get("/trainer/connect", (req, res) => {
    const athleteId = req.session?.strava?.athlete?.id;
    if (athleteId && !isAdmin(athleteId)) return res.sendStatus(403);
    if (athleteId) return res.redirect("/trainer/");
    req.session.returnTo = "/trainer/?connected=1";
    res.redirect("/auth/strava?consent=yes");
  });
  app.use("/trainer", (req, res, next) => {
    const athleteId = req.session?.strava?.athlete?.id;
    if (athleteId && !isAdmin(athleteId)) return res.sendStatus(403);
    if (!athleteId) {
      if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
        return res.redirect("/trainer/connect?consent=yes");
      }
      return res.sendStatus(401);
    }
    next();
  });
  app.use("/api/trainer", (req, res, next) => {
    const athleteId = req.session?.strava?.athlete?.id;
    if (!athleteId || !isAdmin(athleteId)) return res.sendStatus(403);
    next();
  });
}

// Browser version of Indoor Trainer at /trainer. Riders sign in with lapped's existing Strava
// connection (same session cookie); rides upload to Strava through these two routes.
// Ride data itself stays in the rider's browser; only the finished ride file passes through here.
export function mountTrainerWeb(app, { origin, accessToken, fetchStrava = fetch, now = Date.now }) {
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
      athlete: athlete ? { firstname: athlete.firstname || "", lastname: athlete.lastname || "" } : null
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
        headers: { authorization: `Bearer ${access}` },
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

  app.use("/api/trainer", router);
}
