"use strict";

// Phase 3 authentication: first account becomes owner, later accounts need the
// registration key, passwords are scrypt-hashed, sessions are server-side and
// revocable, and every non-public API route refuses anonymous requests.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-auth-"));
process.env.APP_REGISTRATION_KEY = "team-key";

const { app } = require("../server");
const { hashPassword, verifyPassword } = require("../lib/auth");

let server;
let base;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(() => server.close());

async function post(url, body, headers) {
  return fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

test("auth status is public and reports registration state", async () => {
  const response = await fetch(base + "/api/auth/status");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.authenticated, false);
  assert.equal(body.registrationOpen, true);
});

test("first registration becomes the owner and returns a CSRF token", async () => {
  const response = await post("/api/auth/register", { username: "owner", password: "owner-pass-123" });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.user.role, "owner");
  assert.match(body.csrfToken, /^[A-Za-z0-9_-]{16,}$/);
  const setCookie = String(response.headers.get("set-cookie") || "");
  assert.match(setCookie, /baba_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test("passwords are stored as scrypt hashes, never plaintext", () => {
  const stored = hashPassword("owner-pass-123");
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(stored.includes("owner-pass-123"), false);
  assert.equal(verifyPassword("owner-pass-123", stored), true);
  assert.equal(verifyPassword("wrong-pass", stored), false);

  const usersFile = path.join(process.env.DATA_DIR, "users.json");
  const raw = fs.readFileSync(usersFile, "utf8");
  assert.equal(raw.includes("owner-pass-123"), false, "users.json must not contain the plaintext password");
});

test("second registration needs the key, and the key unlocks it", async () => {
  const denied = await post("/api/auth/register", { username: "member", password: "member-pass-123" });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /key/i);

  const allowed = await post("/api/auth/register", {
    username: "member", password: "member-pass-123", registrationKey: "team-key",
  });
  const body = await allowed.json();
  assert.equal(allowed.status, 201);
  assert.equal(body.user.role, "member");
});

test("login and logout work and the session cookie is HttpOnly", async () => {
  const response = await post("/api/auth/login", { username: "member", password: "member-pass-123" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.username, "member");
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];

  const me = await fetch(base + "/api/auth/me", { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, "member");

  const logout = await fetch(base + "/api/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie, "x-csrf-token": body.csrfToken },
  });
  assert.equal(logout.status, 200);

  // Server-side sessions are revoked: the same cookie no longer works.
  const after = await fetch(base + "/api/auth/me", { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});

test("wrong password and unknown user are rejected without leaking which", async () => {
  const badPassword = await post("/api/auth/login", { username: "member", password: "not-the-password" });
  const unknown = await post("/api/auth/login", { username: "ghost_user", password: "whatever-pass-1" });
  assert.equal(badPassword.status, 401);
  assert.equal(unknown.status, 401);
  const a = (await badPassword.json()).error;
  const b = (await unknown.json()).error;
  assert.equal(a, b, "login failures must be indistinguishable");
});

test("every protected API route refuses anonymous requests", async () => {
  for (const url of ["/api/projects", "/api/characters", "/api/capabilities", "/api/youtube/status"]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 401, url + " must require a session");
    const body = await response.json();
    assert.match(body.error, /login|Access key/i);
  }
});

test("invalid or expired session ids are rejected", async () => {
  const response = await fetch(base + "/api/projects", { headers: { Cookie: "baba_session=not-a-real-session" } });
  assert.equal(response.status, 401);
});

test("weak passwords and bad usernames are refused", async () => {
  const weak = await post("/api/auth/register", {
    username: "weak_user", password: "short", registrationKey: "team-key",
  });
  assert.equal(weak.status, 400);
  const badName = await post("/api/auth/register", {
    username: "Bad Name!", password: "long-enough-pass-1", registrationKey: "team-key",
  });
  assert.equal(badName.status, 400);
});
