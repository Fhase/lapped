import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { once } from "node:events";
import test from "node:test";
import { mountTrainerBridge } from "../trainer-bridge.js";

test("only the lapped owner can pair and forward uploads", async (t) => {
  const app = express();
  const forwarded = [];
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = { strava: { athlete: { id: req.get("test-athlete") } } };
    next();
  });
  mountTrainerBridge(app, {
    origin: "https://lapped.fit",
    secret: "test-secret",
    isOwner: (id) => id === "123",
    tokenForAthlete: async (id) => { assert.equal(id, "123"); return "fake-strava-token"; },
    fetchStrava: async (url, options) => {
      forwarded.push({ url, options });
      return Response.json({ id: 42, activity_id: options.method === "GET" ? 99 : null });
    }
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/indoor-trainer`;
  const verifier = "a".repeat(64);
  const body = new URLSearchParams({ state: "b".repeat(64), port: "12345", challenge: crypto.createHash("sha256").update(verifier).digest("hex") });
  const pair = (id, origin = "https://lapped.fit") => fetch(base + "/connect", {
    method: "POST", body, headers: { origin, "test-athlete": id }, redirect: "manual"
  });
  assert.equal((await pair("456")).status, 403);
  assert.equal((await pair("123", "https://example.com")).status, 403);
  const approval = await pair("123");
  assert.equal(approval.status, 303);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.origin, "http://127.0.0.1:12345");
  assert.equal(callback.searchParams.get("state"), body.get("state"));
  const code = callback.searchParams.get("code");
  const upload = (key) => fetch(base + "/uploads", {
    method: "POST", body: "test ride",
    headers: { authorization: `Bearer ${code}.${key}`, "content-type": "multipart/form-data; boundary=IndoorTrainer-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
  });
  assert.equal((await upload("c".repeat(64))).status, 401);
  assert.equal(forwarded.length, 0);
  assert.equal((await upload(verifier)).status, 200);
  const poll = await fetch(base + "/uploads/42", { headers: { authorization: `Bearer ${code}.${verifier}` } });
  assert.equal((await poll.json()).activity_id, 99);
  assert.deepEqual(forwarded.map(({ url }) => url), ["https://www.strava.com/api/v3/uploads", "https://www.strava.com/api/v3/uploads/42"]);
  assert.equal(forwarded[0].options.body.toString(), "test ride");
});
