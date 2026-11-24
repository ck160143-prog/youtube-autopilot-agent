"use strict";

// CSRF protection: every state-changing API call needs the per-session token
// (or a same-origin Origin/Sec-Fetch-Site proof). Cross-site posts are refused.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-csrf-"));

const { app } = require("../server");
const { authedHeaders } = require("./helpers");

let server;
let base;
let session;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await authedHeaders(base);
});

test.after(() => server.close());

function post(url, headers) {
  return fetch(base + url, { method: "POST", headers, body: JSON.stringify({ topic: "CSRF test project" }) });
}

test("a state-changing call without the CSRF token is refused", async () => {
  const response = await post("/api/projects", { Cookie: session.Cookie, "Content-Type": "application/json" });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "CSRF");
});

test("a wrong CSRF token is refused", async () => {
  const response = await post("/api/projects", {
    Cookie: session.Cookie, "Content-Type": "application/json", "x-csrf-token": "definitely-wrong-token",
  });
  assert.equal(response.status, 403);
});

test("the session CSRF token is accepted", async () => {
  const response = await post("/api/projects", session);
  assert.notEqual(response.status, 403);
  assert.equal(response.status, 201);
});

test("a foreign Origin is refused even with a valid token", async () => {
  const response = await post("/api/projects", {
    ...session, Origin: "https://evil.example.com",
  });
  assert.equal(response.status, 403);
});

test("a same-origin Origin is accepted without the token", async () => {
  const response = await post("/api/projects", {
    Cookie: session.Cookie, "Content-Type": "application/json", Origin: base,
  });
  assert.equal(response.status, 201);
});

test("safe methods are never blocked by CSRF", async () => {
  const response = await fetch(base + "/api/projects", { headers: { Cookie: session.Cookie } });
  assert.equal(response.status, 200);
});

test("public auth endpoints are reachable without a session or token", async () => {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nobody_here", password: "no-such-pass-123" }),
  });
  assert.equal(response.status, 401);
});

test("one user's CSRF token cannot be used with another user's cookie", async () => {
  // Register a second account (first account already exists, so the key is needed).
  process.env.APP_REGISTRATION_KEY = "team-key";
  const register = await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "second_user", password: "second-pass-123", registrationKey: "team-key" }),
  });
  const body = await register.json();
  assert.equal(register.status, 201);
  const secondCookie = String(register.headers.get("set-cookie") || "").split(";")[0];

  const mixed = await post("/api/projects", {
    Cookie: secondCookie, "Content-Type": "application/json", "x-csrf-token": session["x-csrf-token"],
  });
  assert.equal(mixed.status, 403);
});
