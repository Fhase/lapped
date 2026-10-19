import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { createYtdRefresh, mountMobile } from "../mobile.js";

async function fixture(t) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const stores = {}, tokens = { "123": { athlete: { id: 123, firstname: "Test", lastname: "Rider" }, access_token: "kept", refresh_token: "kept-refresh", connected_at: "2025-01-01" } };
  const tokenSnapshot = structuredClone(tokens);
  let externalReads = 0, refreshes = 0;
  const controller = mountMobile(app, {
    baseUrl: "https://lapped.fit", dataDir: "/fixtures", segmentId: "16091644", clientId: "test", disableWorker: true,
    readEncryptedStore: async (key) => structuredClone(stores[key] || {}),
    writeEncryptedStore: async (key, value) => { stores[key] = structuredClone(value); },
    readTokens: async () => structuredClone(tokens),
    // Simulate an existing athlete reauthorizing without changing their grant.
    saveToken: async () => {},
    exchangeCode: async () => tokens["123"],
    tokenForAthlete: async (id) => { assert.equal(id, "123"); return "kept"; },
    hasLappedReceipt: (text) => text?.startsWith("laps ·"),
    personalStatsFor: async () => ({ lifetime: 100, ytd: 20, status: "ready", year: 2026 }),
    refreshYtd: async (id) => { assert.equal(id, "123"); refreshes++; return { lifetime: 100, ytd: 20, status: "queued", year: 2026 }; },
    fetch: async (url) => {
      externalReads++;
      const payload = url.includes("/athlete/activities")
        ? [{ id: 10, sport_type: "Ride" }, { id: 11, sport_type: "Ride" }]
        : { id: url.includes("/10?") ? 10 : 11, athlete: { id: url.includes("/10?") ? 123 : 999 }, name: "Test ride", start_date: "2026-10-19T10:00:00Z", description: "laps · 2\nwww.lapped.fit", segment_efforts: [
          { segment: { id: 16091644 }, elapsed_time: 170, distance: 1850, start_index: 50, start_date: "2026-10-19T10:05:00Z" },
          { segment: { id: 55 }, elapsed_time: 99 },
          { segment: { id: 16091644 }, elapsed_time: 160, distance: 1850, start_index: 10, start_date: "2026-10-19T10:01:00Z" }
        ] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  // This stands in for the unchanged website callback handler.
  app.get("/auth/strava/complete", (_req, res) => res.send("website callback"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { controller.close(); server.closeAllConnections(); server.close(); });
  const call = (route, options = {}) => fetch(base + route, { redirect: "manual", ...options });
  async function login() {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("base64url");
    const start = await call("/auth/mobile/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: "yes", state, challenge }) });
    assert.equal(start.status, 302);
    const oauthState = new URL(start.headers.get("location")).searchParams.get("state");
    const complete = await call(`/auth/strava/complete?code=fake&scope=activity:read_all,activity:write&state=${oauthState}`);
    const url = new URL(complete.headers.get("location"));
    assert.equal(url.searchParams.get("state"), state);
    return { verifier, code: url.searchParams.get("code") };
  }
  async function exchange(payload) {
    return call("/api/mobile/session/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  }
  return { call, login, exchange, controller, tokens, tokenSnapshot, externalReads: () => externalReads, refreshes: () => refreshes };
}

test("one-time login is PKCE-bound; website OAuth is untouched", async (t) => {
  const f = await fixture(t);
  assert.equal(await (await f.call("/auth/strava/complete?state=website-state")).text(), "website callback");
  const login = await f.login();
  const bad = await f.exchange({ ...login, verifier: crypto.randomBytes(32).toString("base64url") });
  assert.equal(bad.status, 401);
  const response = await f.exchange(login);
  assert.equal(response.status, 200);
  const { session } = await response.json();
  assert.ok(session);
  assert.equal((await f.exchange(login)).status, 401);
  assert.deepEqual(f.tokens, f.tokenSnapshot);
  assert.equal(f.externalReads(), 0);
});

test("private routes reject browser cookies and request-supplied athlete IDs", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/mobile/stats?athleteId=123", { headers: { Cookie: "lapped_identity=fake" } })).status, 401);
  const { session } = await (await f.exchange(await f.login())).json();
  const headers = { Authorization: `Bearer ${session}` };
  const profile = await (await f.call("/api/mobile/me?athleteId=999", { headers })).json();
  assert.equal(profile.id, "123");
  const stats = await (await f.call("/api/mobile/stats", { headers })).json();
  assert.equal(stats.lifetime, 100);
  assert.equal(f.externalReads(), 0);
  assert.deepEqual(f.tokens, f.tokenSnapshot);
});

test("ride scan includes only owned receipted target efforts; cached polls make no Strava requests", async (t) => {
  const f = await fixture(t);
  const { session } = await (await f.exchange(await f.login())).json();
  const headers = { Authorization: `Bearer ${session}` };
  await f.call("/api/mobile/rides", { headers });
  await f.controller.step(); // list
  await f.controller.step(); // own detail
  await f.controller.step(); // different athlete, ignored
  await f.controller.step(); // done
  const first = await (await f.call("/api/mobile/rides", { headers })).json();
  assert.equal(first.status, "ready");
  assert.equal(first.rides.length, 1);
  assert.deepEqual(first.rides[0].laps.map((lap) => lap.seconds), [160,170]);
  assert.equal((await f.call("/api/mobile/rides/11", { headers })).status, 404);
  await f.call("/api/mobile/rides", { headers });
  assert.equal(f.externalReads(), 3);
  assert.deepEqual(f.tokens, f.tokenSnapshot);
});

test("app logout invalidates only the mobile session; refresh never revokes a connection", async (t) => {
  const f = await fixture(t);
  const { session } = await (await f.exchange(await f.login())).json();
  const headers = { Authorization: `Bearer ${session}` };
  const response = await f.call("/api/mobile/stats/ytd/refresh", { method: "POST", headers });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).ytd, 20);
  assert.equal(f.refreshes(), 1);
  assert.equal((await f.call("/api/mobile/session", { method: "DELETE", headers })).status, 204);
  assert.equal((await f.call("/api/mobile/me", { headers })).status, 401);
  assert.deepEqual(f.tokens, f.tokenSnapshot);
});

test("YTD refresh coalesces taps, preserves loaded stats and processed records, and respects cooldown", async () => {
  let stats = { "123": { version: 6, status: "ready", year: 2026, ytd: 756, lifetime: 2043, fastestLap: "2:38 · 42.3 km/h", checkedAt: 1 }, __processed: { "123": { "10": 99 } } };
  let writes = 0, schedules = 0;
  const refresh = createYtdRefresh({
    readStats: async () => structuredClone(stats), writeStats: async (value) => { stats = structuredClone(value); writes++; },
    personalStatsFor: async () => assert.fail("An existing summary must not be replaced"),
    schedule: () => { schedules++; }, now: () => Date.parse("2026-10-19T14:00:00Z")
  });
  await Promise.all([refresh("123"), refresh("123")]);
  assert.equal(writes, 1);
  assert.equal(schedules, 1);
  assert.equal(stats["123"].lifetime, 2043);
  assert.equal(stats["123"].ytd, 756);
  assert.equal(stats["123"].fastestLap, "2:38 · 42.3 km/h");
  assert.equal(stats["123"].checkedAt, 1);
  assert.deepEqual(stats.__processed, { "123": { "10": 99 } });
  stats["123"].status = "ready";
  await refresh("123");
  assert.equal(writes, 1);
});
