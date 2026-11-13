import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import test from "node:test";
import { mountTrainerWeb } from "../trainer-web.js";
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
