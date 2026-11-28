"use strict";

// Phase 3 authentication: the first account becomes the owner, public signup is
// closed after that (owner-only access), passwords are scrypt-hashed, sessions
// are server-side and revocable, and no private route answers an anonymous
// request. The owner-only rules themselves are covered in owner-only-access.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-auth-"));
// This file deliberately makes many registration attempts (each refused door is
// an attempt too), so the auth bucket is raised for the suite. The throttle
// itself is measured in session-security.test.js at the production limit.
process.env.API_RATE_LIMIT_MULTIPLIER = "20";
process.env.APP_REGISTRATION_KEY = "team-key";

const { app } = require("../server");
// Owner creation requires the explicit bootstrap token (see lib/auth.js).
const { OWNER_BOOTSTRAP_TOKEN } = require("./helpers");
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

test("auth status is public and reports the bootstrap state, not an open door", async () => {
  const response = await fetch(base + "/api/auth/status");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.authenticated, false);
  assert.equal(body.privateAccess, false, "a fresh instance has no owner yet");
  assert.equal(body.bootstrapTokenConfigured, true, "a token is configured in this process");
  // "Registration open" is no longer a public signup switch: it is the owner
  // bootstrap, which needs a secret nobody is given here.
  assert.equal(body.bootstrap, true);
});

test("the owner is created only with the bootstrap token, and returns a CSRF token", async () => {
  // Without the token: refused. This is the takeover fix.
  const refused = await post("/api/auth/register", { username: "owner", password: "owner-pass-123" });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "OWNER_BOOTSTRAP_REQUIRED");

  const response = await post("/api/auth/register", {
    username: "owner", password: "owner-pass-123", bootstrapToken: OWNER_BOOTSTRAP_TOKEN,
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.user.role, "owner");
  assert.match(body.csrfToken, /^[A-Za-z0-9_-]{16,}$/);
  const setCookie = String(response.headers.get("set-cookie") || "");
  assert.match(setCookie, /baba_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  // A fresh token is handed back so the environment can be rotated.
  assert.match(String(body.user.nextBootstrapToken || ""), /^[A-Za-z0-9_-]{40,}$/);
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

test("a second registration is refused, even with the registration key", async () => {
  // Owner-only access: a configured key is an operator secret, not a signup
  // switch, so it must not open a public account. The operator can open signup
  // explicitly with ALLOW_PUBLIC_SIGNUP, which the next test covers.
  const denied = await post("/api/auth/register", { username: "member", password: "member-pass-123" });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "SIGNUP_CLOSED");

  const withKey = await post("/api/auth/register", {
    username: "member", password: "member-pass-123", registrationKey: "team-key",
  });
  assert.equal(withKey.status, 403, "the key alone must not open signup");
  assert.equal((await withKey.json()).code, "SIGNUP_CLOSED");
});

test("an operator-opened signup creates a member, never an owner", async () => {
  process.env.ALLOW_PUBLIC_SIGNUP = "1";
  try {
    const noKey = await post("/api/auth/register", { username: "member", password: "member-pass-123" });
    assert.equal(noKey.status, 403, "with a key configured, the key is still required");
    const allowed = await post("/api/auth/register", {
      username: "member", password: "member-pass-123", registrationKey: "team-key",
    });
    const body = await allowed.json();
    assert.equal(allowed.status, 201);
    assert.equal(body.user.role, "member", "a public signup must never become the owner");
  } finally {
    delete process.env.ALLOW_PUBLIC_SIGNUP;
  }
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

test("weak passwords and bad usernames are refused once a door is open", async () => {
  // The door is checked first (so a wrong bootstrap token cannot be told apart
  // from a right one), which means these need an open signup to reach validation.
  process.env.ALLOW_PUBLIC_SIGNUP = "1";
  try {
    const weak = await post("/api/auth/register", {
      username: "weak_user", password: "short", registrationKey: "team-key",
    });
    assert.equal(weak.status, 400);
    const badName = await post("/api/auth/register", {
      username: "Bad Name!", password: "long-enough-pass-1", registrationKey: "team-key",
    });
    assert.equal(badName.status, 400);
  } finally {
    delete process.env.ALLOW_PUBLIC_SIGNUP;
  }
});
