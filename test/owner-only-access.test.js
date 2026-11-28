"use strict";

// Owner-only private access. Every assertion here failed before this change:
// a second account could be created at any time (a configured registration key
// was enough), and it then reached every private endpoint, because the gate only
// asked "is someone signed in" and ownership checks were skipped when a record
// had no ownerId.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Owner creation requires an explicit bootstrap token; this is the operator's
// secret for the tests, and it changes per suite so it cannot be replayed.
const BOOTSTRAP = "owner-only-test-bootstrap-token-987654";

function freshEnv(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-only-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.APP_REGISTRATION_KEY;
  delete process.env.ALLOW_PUBLIC_SIGNUP;
  // Temp dirs are ephemeral by definition; the fail-closed storage gate is
  // measured in owner-bootstrap.test.js, so it stays off unless a test asks.
  delete process.env.OWNER_REQUIRE_PERSISTENT_STORAGE;
  delete process.env.NODE_ENV;
  process.env.OWNER_BOOTSTRAP_TOKEN = BOOTSTRAP;
  Object.assign(process.env, extra || {});
  return dataDir;
}

async function boot() {
  delete require.cache[require.resolve("../server")];
  const server = require("../server");
  const http = server.app.listen(0, "127.0.0.1");
  await new Promise(resolve => http.once("listening", resolve));
  const base = "http://127.0.0.1:" + http.address().port;
  const post = (url, body, extraHeaders) => fetch(base + url, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}),
    body: JSON.stringify(body || {}),
  });
  const register = async (username, options) => {
    const response = await post("/api/auth/register", Object.assign({
      username, password: "owner-password-123",
    }, options || {}));
    // Owner creation needs the token; callers ask for it explicitly.
    let body = {};
    try { body = await response.json(); } catch (_) { body = {}; }
    return {
      status: response.status,
      body,
      session: {
        cookie: String(response.headers.get("set-cookie") || "").split(";")[0],
        csrfToken: body.csrfToken,
        user: body.user,
      },
    };
  };
  const call = (session, url, options) => fetch(base + url, {
    ...(options || {}),
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      ...((options && options.headers) || {}),
    },
  });
  return { http, base, register, call, post };
}

test("public signup is closed even when a registration key is configured", async () => {
  // The old rule was "a key is configured, so anyone with it may sign up".
  // A key is an operator secret, not a signup switch, so it must not be enough.
  freshEnv({ APP_REGISTRATION_KEY: "team-key" });
  const { http, register } = await boot();
  try {
    const anonymous = await register("the_owner");
    assert.equal(anonymous.status, 403, "a plain signup must never create the owner");
    assert.equal(anonymous.body.code, "OWNER_BOOTSTRAP_REQUIRED");

    const owner = await register("the_owner", { bootstrapToken: BOOTSTRAP });
    assert.equal(owner.status, 201);
    assert.equal(owner.body.user.role, "owner", "the token creates the owner");

    const stranger = await register("stranger", { registrationKey: "team-key" });
    assert.equal(stranger.status, 403, "a configured key must not open signup");
    assert.equal(stranger.body.code, "SIGNUP_CLOSED");
    assert.equal(stranger.session.cookie, "", "no session may be issued");
  } finally {
    http.close();
  }
});

test("signup opens only when the operator explicitly opens it, and never as owner", async () => {
  freshEnv({ APP_REGISTRATION_KEY: "team-key", ALLOW_PUBLIC_SIGNUP: "1" });
  const { http, register } = await boot();
  try {
    assert.equal((await register("owner_one", { bootstrapToken: BOOTSTRAP })).body.user.role, "owner");
    const noKey = await register("no_key");
    assert.equal(noKey.status, 403, "the key is still required once signup is open");
    const withKey = await register("second_person", { registrationKey: "team-key" });
    assert.equal(withKey.status, 201);
    assert.equal(withKey.body.user.role, "member", "a public signup must never become the owner");
  } finally {
    http.close();
  }
});

test("a non-owner, even signed in, reaches no private route", async () => {
  freshEnv({ APP_REGISTRATION_KEY: "team-key", ALLOW_PUBLIC_SIGNUP: "1" });
  const { http, register, call } = await boot();
  try {
    const owner = await register("owner_two", { bootstrapToken: BOOTSTRAP });
    const member = await register("member_two", { registrationKey: "team-key" });
    assert.equal(member.body.user.role, "member");

    const created = await call(owner.session, "/api/projects", {
      method: "POST", body: JSON.stringify({ topic: "निजी", durationMinutes: 1, sceneCount: 3 }),
    });
    const id = (await created.json()).project.id;

    const routes = [
      ["GET", "/api/projects"],
      ["GET", "/api/projects/" + id],
      ["GET", "/api/projects/" + id + "/video"],
      ["GET", "/api/projects/" + id + "/download"],
      ["GET", "/api/projects/" + id + "/captions"],
      ["GET", "/api/setup"],
      ["GET", "/api/capabilities"],
      ["GET", "/api/characters"],
      ["GET", "/api/youtube/status"],
      ["POST", "/api/projects"],
      ["POST", "/api/projects/" + id + "/automate"],
      ["POST", "/api/projects/" + id + "/render"],
      ["POST", "/api/projects/" + id + "/cancel"],
      ["POST", "/api/projects/" + id + "/restore"],
      ["DELETE", "/api/projects/" + id],
    ];
    for (const [method, url] of routes) {
      const response = await call(member.session, url, {
        method, body: method === "GET" ? undefined : JSON.stringify({ topic: "x" }),
      });
      assert.equal(response.status, 403, method + " " + url + " must be refused, got " + response.status);
      assert.equal((await response.json()).code, "OWNER_ONLY", method + " " + url + " must say why");
    }

    // The owner still has everything, and the member's attempt changed nothing.
    assert.equal((await call(owner.session, "/api/projects/" + id)).status, 200);
  } finally {
    http.close();
  }
});

test("a signed-in non-owner can still see their own session and sign out", async () => {
  // Otherwise they are trapped: every request refused, no way to leave.
  freshEnv({ APP_REGISTRATION_KEY: "team-key", ALLOW_PUBLIC_SIGNUP: "1" });
  const { http, register, call } = await boot();
  try {
    await register("owner_three", { bootstrapToken: BOOTSTRAP });
    const member = await register("member_three", { registrationKey: "team-key" });

    const me = await call(member.session, "/api/auth/me");
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.access, "owner-only-denied");
    assert.match(body.message, /owner-only/);

    const logout = await call(member.session, "/api/auth/logout", { method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal((await call(member.session, "/api/auth/me")).status, 401, "the session is really gone");
  } finally {
    http.close();
  }
});

test("anonymous requests reach nothing private", async () => {
  freshEnv();
  const { http, base, register } = await boot();
  try {
    await register("owner_four", { bootstrapToken: BOOTSTRAP });
    for (const url of ["/api/projects", "/api/setup", "/api/capabilities", "/api/characters",
      "/api/youtube/status", "/api/auth/me"]) {
      const response = await fetch(base + url);
      assert.equal(response.status, 401, url + " must require a session");
    }
  } finally {
    http.close();
  }
});

test("the public status endpoint does not advertise signup and reports privacy", async () => {
  freshEnv({ APP_REGISTRATION_KEY: "team-key" });
  const { http, base, register } = await boot();
  try {
    const before = await (await fetch(base + "/api/auth/status")).json();
    assert.equal(before.privateAccess, false, "a fresh instance has no owner yet");
    assert.equal(before.bootstrap, true, "the owner can still be created with the token");
    assert.equal(before.bootstrapTokenConfigured, true);

    await register("owner_five", { bootstrapToken: BOOTSTRAP });
    const after = await (await fetch(base + "/api/auth/status")).json();
    assert.equal(after.privateAccess, true);
    assert.equal(after.bootstrap, false, "once an owner exists, the bootstrap door is shut");
    assert.equal(after.registrationOpen, false, "a configured key must not be advertised as open signup");
    assert.equal(after.user, null);
  } finally {
    http.close();
  }
});
