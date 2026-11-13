import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import test from "node:test";
import { isTrainerPath, mountTrainerAccessGuard, mountTrainerWeb } from "../trainer-web.js";
import { rideStats, tcx, trainingStress, workouts, parseIndoorBike, parseCyclingPower, parseHeartRate } from "../public/trainer/core.js";

test("browser trainer uploads with the rider's own session and checks the origin", async (t) => {
  const app = express();
  const forwarded = [];
  app.use((req, _res, next) => {
    const id = req.get("test-athlete");
    req.session = id ? { strava: { athlete: { id, firstname: "Ada", lastname: "Lovelace" } } } : {};
    next();
  });
  mountTrainerWeb(app, {
    origin: "https://lapped.fit",
    accessToken: async (req) => `token-${req.session.strava.athlete.id}`,
    fetchStrava: async (url, options) => {
      forwarded.push({ url, options });
      return Response.json(options.method === "GET" ? { id: 7, activity_id: 99 } : { id: 7, activity_id: null });
    }
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/trainer`;
  const ride = { id: "abc-123", name: "Endurance 60", started: Date.UTC(2026, 0, 1), ftp: 250, steps: workouts[2].steps, elapsed: 3 };
  const file = tcx(ride, [{ power: 200, heart: 120 }, { power: 210, heart: 121 }, { power: null, heart: null }]);
  const post = (headers, body = file) => fetch(`${base}/uploads?name=Endurance%2060&external_id=indoortrainer-abc-123`, {
    method: "POST", body, headers: { "content-type": "application/vnd.garmin.tcx+xml", ...headers }
  });

  assert.deepEqual(await (await fetch(`${base}/me`)).json(), { connected: false, athlete: null });
  assert.equal((await (await fetch(`${base}/me`, { headers: { "test-athlete": "5" } })).json()).athlete.firstname, "Ada");
  assert.equal((await post({ origin: "https://lapped.fit" })).status, 401);
  assert.equal((await post({ origin: "https://evil.example", "test-athlete": "5" })).status, 403);
  assert.equal((await post({ origin: "https://lapped.fit", "test-athlete": "5" }, "not a ride")).status, 400);
  assert.equal(forwarded.length, 0);

  const ok = await post({ origin: "https://lapped.fit", "test-athlete": "5" });
  assert.equal(ok.status, 200);
  assert.equal(forwarded[0].url, "https://www.strava.com/api/v3/uploads");
  assert.equal(forwarded[0].options.headers.authorization, "Bearer token-5");
  const form = forwarded[0].options.body;
  assert.equal(form.get("data_type"), "tcx");
  assert.equal(form.get("external_id"), "indoortrainer-abc-123");
  assert.match(await form.get("file").text(), /<ae:Watts>210<\/ae:Watts>/);

  const poll = await fetch(`${base}/uploads/7`, { headers: { "test-athlete": "5" } });
  assert.equal((await poll.json()).activity_id, 99);
  assert.equal(forwarded[1].url, "https://www.strava.com/api/v3/uploads/7");
  assert.equal((await fetch(`${base}/uploads/x7`, { headers: { "test-athlete": "5" } })).status, 400);

  const mute = await fetch(`${base}/activities/99/mute`, { method: "PUT", headers: { origin: "https://lapped.fit", "test-athlete": "5" } });
  assert.equal(mute.status, 200);
  assert.equal(forwarded[2].url, "https://www.strava.com/api/v3/activities/99");
  assert.equal(forwarded[2].options.method, "PUT");
  assert.deepEqual(JSON.parse(forwarded[2].options.body), { hide_from_home: true });
  assert.equal(forwarded[2].options.headers["content-type"], "application/json");
  assert.equal((await fetch(`${base}/activities/99/mute`, { method: "PUT", headers: { origin: "https://evil.example", "test-athlete": "5" } })).status, 403);

});

test("trainer workouts, stats and sensor parsing match the Mac app", () => {
  assert.equal(workouts.length, 21);
  assert.deepEqual(workouts.slice(1, 4).map((w) => w.minutes), [30, 63, 93]);
  assert.equal(trainingStress(workouts.find((w) => w.id === "endurance60").steps), 44);
  // Ramps meet the blocks next to them: no jump at warm-up and cool-down edges.
  for (const w of workouts) {
    w.steps.forEach((step, i) => {
      const next = w.steps[i + 1];
      if (step.end != null && next && step.end <= 70 && next.end == null) assert.ok(next.percent >= step.end || next.percent === step.end || step.end === 70, w.name);
    });
  }
  const ride = { name: "Ramp Test", ftp: 250, steps: workouts.find((w) => w.id === "rampTest").steps, elapsed: 120 };
  const stats = rideStats(ride, Array.from({ length: 120 }, (_, i) => ({ power: i < 60 ? 200 : 400, heart: null })));
  assert.equal(stats.ftpEstimate, 300);
  const twenty = { name: "20-Minute FTP Test", ftp: 250, steps: [], elapsed: 1300 };
  assert.equal(rideStats(twenty, Array.from({ length: 1300 }, () => ({ power: 300 }))).ftpEstimate, 285);

  const bytes = (...b) => new DataView(Uint8Array.from(b).buffer);
  // FTMS flags 0x45: speed, cadence (0.5 rpm units) and power.
  assert.deepEqual(parseIndoorBike(bytes(0x44, 0x00, 0x10, 0x27, 0xb4, 0x00, 0xfa, 0x00)), { cadence: 90, power: 250 });
  assert.deepEqual(parseCyclingPower(bytes(0x20, 0x00, 0xc8, 0x00, 0x0a, 0x00, 0x00, 0x04)), { power: 200, crankRevolutions: 10, crankEventTime: 1024 });
  assert.equal(parseHeartRate(bytes(0x00, 142)).heart, 142);
});

test("website ERG runs the FTMS control sequence with confirmations, like the Mac app", async () => {
  const { Devices } = await import("../public/trainer/devices.js");
  // A fake FTMS trainer: indications answer each command, power follows the target.
  const written = [];
  let indicate = null, bike = null, target = 150;
  const characteristic = (uuid) => ({
    addEventListener: (_type, listener) => { if (uuid === 0x2ad9) indicate = listener; else bike = listener; },
    startNotifications: async () => {},
    writeValueWithResponse: async (bytes) => {
      written.push([...bytes]);
      if (bytes[0] === 0x05) target = bytes[1] | (bytes[2] << 8);
      setTimeout(() => indicate({ target: { value: new DataView(Uint8Array.of(0x80, bytes[0], 1).buffer) } }), 5);
    }
  });
  const server = { getPrimaryService: async (uuid) => { if (uuid !== 0x1826) throw new Error("no service"); return { getCharacteristic: async (c) => characteristic(c) }; } };
  const devices = new Devices(() => {});
  const errors = [];
  devices.onError = (m) => errors.push(m);
  const link = { device: { gatt: { connect: async () => server } }, name: "Fake", state: "connecting", reading: {}, time: 0 };
  devices.links.trainer = link;
  await devices.connect("trainer", link);
  const send = (watts) => bike({ target: { value: new DataView(Uint8Array.of(0x44, 0, 0, 0, 0xb4, 0, watts & 0xff, watts >> 8).buffer) } });
  send(150);
  assert.ok(devices.canControl);
  assert.equal(await devices.setPower(237), true);
  send(target);
  assert.equal(devices.power(), 237);
  await devices.stopControl();
  assert.equal(await devices.setPower(200), true); // after a pause the trainer is started again
  assert.deepEqual(written, [[0x00], [0x07], [0x05, 237, 0], [0x08, 0x01], [0x07], [0x05, 200, 0]]);
  assert.deepEqual(errors, []);
});

test("website connects to Trainer Simulator over its local WebSocket and runs ERG through it", async () => {
  const { Devices } = await import("../public/trainer/devices.js");
  const sockets = [];
  let target = 150;
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); setTimeout(() => this.onopen(), 1); }
    frame(uuid, payload) { this.onmessage({ data: Uint8Array.of(uuid & 0xff, uuid >> 8, payload.length, ...payload).buffer }); }
    send(bytes) {
      const command = [...bytes.slice(3)];
      this.sent.push([...bytes]);
      if (command[0] === 0x05) target = command[1] | (command[2] << 8);
      setTimeout(() => this.frame(0x2ad9, [0x80, command[0], 1]), 2);
    }
    close() { this.closed = true; }
  };
  try {
    const devices = new Devices(() => {});
    await devices.connectSimulator("trainer");
    await devices.connectSimulator("heart");
    assert.equal(sockets[0].url, "ws://127.0.0.1:47827");
    sockets[0].frame(0x2ad2, [0x44, 0, 0, 0, 0xb4, 0, 150, 0]);
    sockets[1].frame(0x2a37, [0x00, 131]);
    assert.equal(devices.power(), 150);
    assert.equal(devices.heart(), 131);
    assert.equal(devices.cadence(), 90);
    assert.ok(devices.canControl);
    assert.equal(await devices.setPower(240), true);
    assert.equal(target, 240);
    // Control writes go out as 0x2AD9 frames, the same as the Mac app's LocalLink.
    assert.deepEqual(sockets[0].sent, [[0xd9, 0x2a, 1, 0x00], [0xd9, 0x2a, 1, 0x07], [0xd9, 0x2a, 3, 0x05, 240, 0]]);
    devices.forget("trainer");
    assert.ok(sockets[0].closed);
    assert.equal(devices.links.heart.name, "Trainer Sim · This Mac");
  } finally { delete globalThis.WebSocket; }
});

test("trainer saves each rider's settings and rides under their own Strava athlete", async (t) => {
  const app = express();
  app.use((req, _res, next) => { const id = req.get("test-athlete"); req.session = id ? { strava: { athlete: { id } } } : {}; next(); });
  const files = new Map();
  const store = {
    read: async (a, n) => structuredClone(files.get(`${a}/${n}`) ?? {}),
    write: async (a, n, v) => { files.set(`${a}/${n}`, structuredClone(v)); },
    remove: async (a, n) => { files.delete(`${a}/${n}`); }
  };
  mountTrainerWeb(app, { origin: "https://lapped.fit", accessToken: async () => "x", store });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/trainer`;
  const call = (path, method, athlete, body, origin = "https://lapped.fit") => fetch(base + path, {
    method, headers: { origin, "test-athlete": athlete, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body)
  });
  const id = "0b7f3c2e-1d4a-4c5b-9e8f-112233445566";
  const ride = { id, name: "Endurance 60", started: 1, ftp: 250, steps: [], elapsed: 2, state: "finished", avgPower: 205, athlete: "5", remote: true };

  assert.equal((await call("/prefs", "PUT", "5", { ftp: 250, appearance: "Light" })).status, 204);
  assert.equal((await call("/prefs", "PUT", "5", { ftp: 5000 })).status, 400);
  assert.equal((await call("/prefs", "PUT", "5", { isAdmin: true })).status, 400);
  assert.equal((await call("/prefs", "PUT", "5", { ftp: 260 }, "https://evil.example")).status, 403);
  assert.equal((await call(`/rides/${id}`, "PUT", "5", { ride, samples: [[1, 200, 120], [2, 210, null]] })).status, 204);
  assert.equal((await call(`/rides/${id}`, "PUT", "5", { ride: { ...ride, state: "running" }, samples: [] })).status, 400);
  assert.equal((await call("/rides/../index", "PUT", "5", { ride, samples: [] })).status, 404);

  const mine = await (await call("/data", "GET", "5")).json();
  assert.deepEqual(mine.prefs, { ftp: 250, appearance: "Light" });
  assert.equal(mine.rides[0].avgPower, 205);
  assert.equal(mine.rides[0].athlete, undefined);
  assert.deepEqual((await (await call(`/rides/${id}/samples`, "GET", "5")).json()).samples, [[1, 200, 120], [2, 210, null]]);

  // Another rider sees none of it.
  const other = await (await call("/data", "GET", "6")).json();
  assert.deepEqual(other, { prefs: {}, rides: [], deleted: [] });
  assert.equal((await call(`/rides/${id}/samples`, "GET", "6")).status, 404);
  assert.equal((await fetch(`${base}/data`)).status, 401);

  assert.equal((await call(`/rides/${id}`, "DELETE", "5")).status, 204);
  const after = await (await call("/data", "GET", "5")).json();
  assert.deepEqual([after.rides, after.deleted], [[], [id]]);
  assert.equal(files.has(`5/${id}`), false);
  // A browser that still has the deleted ride can't upload it again.
  assert.equal((await call(`/rides/${id}`, "PUT", "5", { ride, samples: [] })).status, 409);
});

test("only approved athletes reach the trainer, however the path is spelled", async (t) => {
  for (const p of ["/trainer", "/trainer/app.js", "//trainer/app.js", "/TRAINER/x", "/x/../trainer/app.js", "/%74rainer/", "/api/trainer/data", "//api//trainer/data", "/api/./trainer/me", "/%E0%A4%A"]) assert.equal(isTrainerPath(p), true, p);
  for (const p of ["/", "/trainers", "/indoor-trainer/x", "/api/indoor-trainer/pair", "/healthz"]) assert.equal(isTrainerPath(p), false, p);
  const app = express();
  app.use((req, _res, next) => { const id = req.get("test-athlete"); req.session = id ? { strava: { athlete: { id } } } : {}; next(); });
  mountTrainerAccessGuard(app, { isApproved: (id) => id === "111" });
  app.use((_req, res) => res.send("inside"));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const get = (path, athlete) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: "manual", headers: athlete ? { "test-athlete": athlete } : {} });
  assert.equal((await get("/trainer/", "111")).status, 200);
  assert.equal((await get("/trainer/connect", "111")).headers.get("location"), "/trainer/");
  assert.equal((await get("/trainer/", "222")).status, 404);
  assert.equal((await get("/api/trainer/data", "222")).status, 404);
  assert.equal((await get("/trainer/connect", "222")).status, 404); // never starts Strava OAuth
  assert.equal((await get("/trainer/")).headers.get("location"), "/");
  assert.equal((await get("/api/trainer/me")).status, 404);
  assert.equal((await get("/elsewhere", "222")).status, 200);
});
