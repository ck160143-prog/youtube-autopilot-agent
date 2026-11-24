"use strict";

// Rate limiting: per-group sliding windows, Retry-After on 429, health checks
// exempt, and the multiplier scaling limits for small deployments.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-rate-"));

const { app } = require("../server");
const { createRateLimiter, groupFor, GROUPS } = require("../lib/ratelimit");

let server;
let base;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(() => server.close());

test("route groups map expensive endpoints to their own buckets", () => {
  assert.equal(groupFor("/api/script").name, "ai");
  assert.equal(groupFor("/api/voice").name, "ai");
  assert.equal(groupFor("/api/render").name, "render");
  assert.equal(groupFor("/api/projects/p1/render").name, "render");
  assert.equal(groupFor("/api/youtube/upload").name, "upload");
  assert.equal(groupFor("/api/auth/login").name, "auth");
  assert.equal(groupFor("/api/projects").name, "general");
  // Polling status must not consume the render budget.
  assert.equal(groupFor("/api/render/status/job-1").name, "general");
});

test("limiter blocks the request after the group limit and reports Retry-After", () => {
  const limiter = createRateLimiter({ windowMs: 60000 });
  const req = { path: "/api/auth/login", method: "POST", ip: "203.0.113.9" };
  const res = { code: 0, headers: {}, status(code) { this.code = code; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(payload) { this.body = payload; return this; } };
  let passed = 0;
  for (let i = 0; i < GROUPS.auth.limit + 2; i += 1) {
    limiter(req, res, () => { passed += 1; });
  }
  assert.equal(passed, GROUPS.auth.limit);
  assert.equal(res.code, 429);
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.ok(Number(res.headers["Retry-After"]) >= 1);
});

test("health and auth status are exempt from limiting", () => {
  const limiter = createRateLimiter({ windowMs: 60000 });
  for (const url of ["/api/health", "/api/auth/status"]) {
    const res = { code: 0, headers: {}, status(code) { this.code = code; return this; },
      setHeader() {}, json() { return this; } };
    for (let i = 0; i < 200; i += 1) limiter({ path: url, method: "GET", ip: "203.0.113.9" }, res, () => {});
    assert.equal(res.code, 0, url + " must never be rate limited");
  }
});

test("API_RATE_LIMIT_MULTIPLIER scales every limit", () => {
  const limiter = createRateLimiter({ windowMs: 60000, multiplier: 0.2 });
  const res = { code: 0, headers: {}, status(code) { this.code = code; return this; },
    setHeader(k, v) { this.headers[k] = v; }, json(payload) { this.body = payload; return this; } };
  let passed = 0;
  const req = { path: "/api/auth/login", method: "POST", ip: "203.0.113.10" };
  for (let i = 0; i < 6; i += 1) limiter(req, res, () => { passed += 1; });
  assert.equal(passed, Math.round(GROUPS.auth.limit * 0.2));
  assert.equal(res.code, 429);
});

test("different callers get independent budgets", () => {
  const limiter = createRateLimiter({ windowMs: 60000 });
  const makeRes = () => ({ code: 0, headers: {}, status(code) { this.code = code; return this; },
    setHeader() {}, json(payload) { this.body = payload; return this; } });
  let firstPassed = 0;
  const firstRes = makeRes();
  for (let i = 0; i < 30; i += 1) {
    limiter({ path: "/api/script", method: "POST", ip: "198.51.100.1" }, firstRes, () => { firstPassed += 1; });
  }
  let secondPassed = 0;
  const secondRes = makeRes();
  for (let i = 0; i < 10; i += 1) {
    limiter({ path: "/api/script", method: "POST", ip: "198.51.100.2" }, secondRes, () => { secondPassed += 1; });
  }
  assert.equal(firstPassed, GROUPS.ai.limit);
  assert.equal(secondPassed, 10, "a second caller must not inherit the first caller's budget");
  assert.equal(secondRes.code, 0);
});

test("login brute force is throttled over HTTP with Retry-After", async () => {
  let limited = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "brute_force_user", password: "wrong-pass-" + attempt }),
    });
    if (response.status === 429) { limited = response; break; }
    assert.equal(response.status, 401, "attempts before the limit must be plain auth failures");
  }
  assert.ok(limited, "repeated login attempts must eventually be rate limited");
  const body = await limited.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

test("health stays reachable while the auth bucket is exhausted", async () => {
  const response = await fetch(base + "/api/health");
  assert.equal(response.status, 200);
});
