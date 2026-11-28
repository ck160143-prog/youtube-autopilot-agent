"use strict";

// Session, CSRF and brute-force behaviour seen from the outside, on the
// owner-only build. These are the properties an attacker would actually try.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Importing the helper installs the test bootstrap token; owner creation needs it.
const { OWNER_BOOTSTRAP_TOKEN } = require("./helpers");

async function boot(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.APP_REGISTRATION_KEY;
  delete process.env.ALLOW_PUBLIC_SIGNUP;
  process.env.API_RATE_LIMIT_MULTIPLIER = "10";
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve("../server")];
  const { app } = require("../server");
  const http = app.listen(0, "127.0.0.1");
  await new Promise(resolve => http.once("listening", resolve));
  return { http, base: "http://127.0.0.1:" + http.address().port, dataDir };
}

test("the session cookie is HttpOnly, SameSite and not readable by scripts", async () => {
  const { http, base } = await boot();
  try {
    const response = await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "cookie_owner", password: "owner-password-123", bootstrapToken: OWNER_BOOTSTRAP_TOKEN }),
    });
    assert.equal(response.status, 201);
    const cookie = String(response.headers.get("set-cookie") || "");
    assert.match(cookie, /HttpOnly/, "a script must not read the session id");
    assert.match(cookie, /SameSite=Lax/, "a cross-site form post must not carry it");
    assert.match(cookie, /Path=\//);
    // The session id must be long and random, not a counter or a username.
    const value = cookie.split(";")[0].split("=").slice(1).join("=");
    assert.ok(value.length >= 32, "session id is too short: " + value.length);
  } finally {
    http.close();
  }
});

test("a state-changing request without the CSRF token is refused", async () => {
  const { http, base } = await boot();
  try {
    const response = await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "csrf_owner", password: "owner-password-123", bootstrapToken: OWNER_BOOTSTRAP_TOKEN }),
    });
    const body = await response.json();
    const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];

    const noToken = await fetch(base + "/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ topic: "x", durationMinutes: 1, sceneCount: 3 }),
    });
    assert.equal(noToken.status, 403, "no token must be refused");
    assert.equal((await noToken.json()).code, "CSRF");

    // A wrong token is refused too, and a cross-site Origin is refused even with
    // a correct token.
    const wrongToken = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": "not-the-token" },
      body: JSON.stringify({ topic: "x", durationMinutes: 1, sceneCount: 3 }),
    });
    assert.equal(wrongToken.status, 403);

    const crossSite = await fetch(base + "/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Cookie: cookie,
        "x-csrf-token": body.csrfToken, Origin: "https://evil.example",
      },
      body: JSON.stringify({ topic: "x", durationMinutes: 1, sceneCount: 3 }),
    });
    assert.equal(crossSite.status, 403, "a cross-site origin must be refused");

    // With the real token it works, so the test is not passing by refusing all.
    const allowed = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": body.csrfToken },
      body: JSON.stringify({ topic: "ठीक", durationMinutes: 1, sceneCount: 3 }),
    });
    assert.equal(allowed.status, 201);
  } finally {
    http.close();
  }
});

test("password guessing is throttled", async () => {
  const { http, base } = await boot({ API_RATE_LIMIT_MULTIPLIER: "1" });
  try {
    await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "brute_owner", password: "owner-password-123", bootstrapToken: OWNER_BOOTSTRAP_TOKEN }),
    });
    const codes = [];
    for (let i = 0; i < 40; i++) {
      const response = await fetch(base + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "brute_owner", password: "wrong-" + i }),
      });
      codes.push(response.status);
    }
    const refused = codes.filter(code => code === 401).length;
    const throttled = codes.filter(code => code === 429).length;
    assert.ok(throttled > 0, "unlimited guessing must not be possible: " + codes.join(","));
    assert.ok(refused > 0, "the first attempts must still be answered normally");
    assert.ok(codes.indexOf(429) < 25, "throttling must start early, not after 30 guesses");
  } finally {
    http.close();
  }
});

test("an unknown user and a wrong password look the same", async () => {
  const { http, base } = await boot();
  try {
    await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "enum_owner", password: "owner-password-123", bootstrapToken: OWNER_BOOTSTRAP_TOKEN }),
    });
    const unknown = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "does_not_exist", password: "whatever-123" }),
    });
    const wrong = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "enum_owner", password: "whatever-123" }),
    });
    assert.equal(unknown.status, wrong.status, "status must not reveal whether the user exists");
    assert.equal((await unknown.json()).error, (await wrong.json()).error,
      "the message must not reveal whether the user exists");
  } finally {
    http.close();
  }
});

test("logging out really revokes the session server-side", async () => {
  const { http, base } = await boot();
  try {
    const response = await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "logout_owner", password: "owner-password-123", bootstrapToken: OWNER_BOOTSTRAP_TOKEN }),
    });
    const body = await response.json();
    const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
    const headers = { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": body.csrfToken };

    assert.equal((await fetch(base + "/api/projects", { headers })).status, 200);
    assert.equal((await fetch(base + "/api/auth/logout", { method: "POST", headers })).status, 200);
    // The cookie alone is no longer enough: the id is deleted on the server.
    assert.equal((await fetch(base + "/api/projects", { headers })).status, 401);
  } finally {
    http.close();
  }
});
