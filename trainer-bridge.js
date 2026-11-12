import crypto from "node:crypto";
import express from "express";

const prefix = "/api/indoor-trainer";
const validKey = /^[a-f0-9]{64}$/;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function mountTrainerBridge(app, { origin, secret, isOwner, tokenForAthlete, fetchStrava = fetch }) {
  if (!secret) return;
  const sign = (payload) => crypto.createHmac("sha256", secret).update("indoor-trainer:" + payload).digest("hex");
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });

  const pairing = (input) => {
    const { state, challenge, port } = input;
    if (!validKey.test(state || "") || !validKey.test(challenge || "") ||
        !/^[1-9]\d{0,4}$/.test(port || "") || Number(port) > 65535) return null;
    return { state, challenge, port };
  };
  const ownerSession = (req) => {
    const id = String(req.session?.strava?.athlete?.id || "");
    return /^\d+$/.test(id) && isOwner(id) ? id : null;
  };
  router.get("/connect", (req, res) => {
    const fields = pairing(req.query);
    if (!fields) return res.status(400).type("text").send("Start in Indoor Trainer: Settings → Connect with Strava.");
    if (!ownerSession(req)) return res.status(403).type("html").send(
      '<h1>Sign in to lapped.fit</h1><p>Open <a href="/" target="_blank" rel="noopener">lapped.fit</a> in this browser and sign in with the owner account. Then click Connect with Strava again in Indoor Trainer.</p>'
    );
    // A no-referrer policy sends Origin: null on the browser form POST.
    res.set("Referrer-Policy", "same-origin");
    res.set("Content-Security-Policy", "default-src 'none'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'");
    const inputs = Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`).join("");
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Connect Indoor Trainer</title><h1>Connect Indoor Trainer</h1><p>Allow this Mac to upload rides to your Strava account through lapped.fit.</p><form method="post" action="${prefix}/connect">${inputs}<button>Connect with Strava</button></form>`);
  });
  router.post("/connect", (req, res) => {
    const athlete = ownerSession(req);
    if (!athlete) return res.status(403).type("text").send("Sign in to lapped.fit with the owner account, then reconnect from Indoor Trainer.");
    if (req.get("origin") !== origin) return res.status(403).type("text").send("The browser could not verify this approval. Open a fresh Connect with Strava page from Indoor Trainer.");
    const fields = pairing(req.body);
    if (!fields) return res.sendStatus(400);
    const expires = Math.floor(Date.now() / 1000) + 30 * 86400;
    const payload = `${athlete}.${expires}.${fields.challenge}`;
    const code = `${payload}.${sign(payload)}`;
    res.redirect(303, `http://127.0.0.1:${fields.port}/strava?${new URLSearchParams({ code, state: fields.state })}`);
  });

  function authenticate(req, res, next) {
    const parts = (req.get("authorization") || "").match(/^Bearer (\d+)\.(\d+)\.([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{64})$/);
    if (!parts) return res.status(401).json({ message: "Connect with Strava in Indoor Trainer." });
    const [, athlete, expires, challenge, signature, verifier] = parts;
    const expected = sign(`${athlete}.${expires}.${challenge}`);
    if (!isOwner(athlete) || Number(expires) <= Date.now() / 1000 || hash(verifier) !== challenge ||
        !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
      return res.status(401).json({ message: "Your Indoor Trainer connection expired. Connect again." });
    }
    req.trainerAthlete = athlete;
    next();
  }

  async function upload(req, res) {
    const posting = req.method === "POST";
    const contentType = req.get("content-type") || "";
    if (posting && (!/^multipart\/form-data; boundary=IndoorTrainer-[a-fA-F0-9-]{36}$/.test(contentType) ||
        !Buffer.isBuffer(req.body) || !req.body.length)) return res.status(400).json({ message: "Invalid ride file." });
    if (!posting && !/^\d{1,20}$/.test(req.params.id)) return res.sendStatus(400);
    try {
      const access = await tokenForAthlete(req.trainerAthlete);
      const upstream = await fetchStrava("https://www.strava.com/api/v3/uploads" + (posting ? "" : "/" + req.params.id), {
        method: req.method,
        headers: { authorization: `Bearer ${access}`, ...(posting ? { "content-type": contentType } : {}) },
        body: posting ? req.body : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(20000)
      });
      res.status(upstream.status).type("json").send(await upstream.text());
    } catch {
      res.status(502).json({ message: "Lapped could not reach Strava with your existing connection. Check your lapped.fit connection and try again." });
    }
  }
  router.post("/uploads", authenticate, express.raw({ type: "multipart/form-data", limit: "25mb" }), upload);
  router.get("/uploads/:id", authenticate, upload);
  app.use(prefix, router);
}
