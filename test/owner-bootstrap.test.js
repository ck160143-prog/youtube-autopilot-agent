"use strict";

// Owner bootstrap and the takeover it prevents.
//
// Before this change, the first account to register became the owner — and on an
// ephemeral filesystem (Render's free tier) that account is wiped by every deploy.
// Measured: after a wipe, the first visitor's registration returned 201 with
// role "owner", and legacy adoption handed them the previous owner's projects.
// Every test here pins one of the rules that stop that.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { storageState, isEphemeralPath, sessionKey } = require("../lib/auth");

const TOKEN = "bootstrap-token-for-tests-0123456789";

function freshEnv(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-"));
  process.env.DATA_DIR = dataDir;
  process.env.OWNER_BOOTSTRAP_TOKEN = TOKEN;
  delete process.env.ALLOW_PUBLIC_SIGNUP;
  delete process.env.APP_REGISTRATION_KEY;
  delete process.env.OWNER_REQUIRE_PERSISTENT_STORAGE;
  delete process.env.NODE_ENV;
  delete process.env.RENDER;
  process.env.API_RATE_LIMIT_MULTIPLIER = "20";
  Object.assign(process.env, extra || {});
  return dataDir;
}

async function boot(dataDir) {
  process.env.DATA_DIR = dataDir;
  delete require.cache[require.resolve("../server")];
  const server = require("../server");
  const http = server.app.listen(0, "127.0.0.1");
  await new Promise(resolve => http.once("listening", resolve));
  const base = "http://127.0.0.1:" + http.address().port;
  const post = (url, body) => fetch(base + url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const register = async (username, extra) => {
    const response = await post("/api/auth/register", {
      username, password: "owner-password-123", ...(extra || {}),
    });
    let body = {};
    try { body = await response.json(); } catch (_) { body = {}; }
    return {
      status: response.status,
      body,
      cookie: String(response.headers.get("set-cookie") || "").split(";")[0],
    };
  };
  const status = async () => (await fetch(base + "/api/auth/status")).json();
  return { http, base, post, register, status };
}

test("the first visitor is never the owner", async () => {
  freshEnv();
  const { http, register, status, base } = await boot(process.env.DATA_DIR);
  try {
    const visitor = await register("first_visitor");
    assert.equal(visitor.status, 403);
    assert.equal(visitor.body.code, "OWNER_BOOTSTRAP_REQUIRED");
    assert.equal(visitor.cookie, "", "no session may be issued");

    const before = await status();
    assert.equal(before.privateAccess, false, "no owner exists yet");
    assert.equal(before.authenticated, false);

    // And the instance does not serve private data to an anonymous caller.
    const projects = await fetch(base + "/api/projects");
    assert.equal(projects.status, 503);
    assert.equal((await projects.json()).code, "OWNER_NOT_CONFIGURED");
  } finally {
    http.close();
  }
});

test("the owner is created only by the bootstrap token, and the token is spent", async () => {
  freshEnv();
  const { http, register, status } = await boot(process.env.DATA_DIR);
  try {
    const wrong = await register("someone", { bootstrapToken: "not-the-token-000000" });
    assert.equal(wrong.status, 403, "a wrong token must not create anything");

    const owner = await register("the_owner", { bootstrapToken: TOKEN });
    assert.equal(owner.status, 201);
    assert.equal(owner.body.user.role, "owner");
    assert.match(String(owner.body.user.nextBootstrapToken || ""), /^[A-Za-z0-9_-]{40,}$/,
      "a rotated token is returned so the environment can replace the spent one");
    assert.notEqual(owner.body.user.nextBootstrapToken, TOKEN);

    // Reuse: the same token must never create a second owner.
    const reuse = await register("second_owner", { bootstrapToken: TOKEN });
    assert.equal(reuse.status, 403, "the spent token must be refused");
    assert.equal(reuse.body.code, "SIGNUP_CLOSED");

    const after = await status();
    assert.equal(after.privateAccess, true);
    assert.equal(after.bootstrap, false, "the bootstrap door is closed once an owner exists");
  } finally {
    http.close();
  }
});

test("a wrong token cannot be told apart from a missing one", async () => {
  // Otherwise the endpoint is an oracle for guessing the token.
  freshEnv();
  const { http, register } = await boot(process.env.DATA_DIR);
  try {
    const none = await register("probe_a");
    const wrong = await register("probe_b", { bootstrapToken: "wrong-token-1234567890" });
    const wrongWithBadName = await register("!", { bootstrapToken: "wrong-token-1234567890" });
    for (const response of [wrong, wrongWithBadName]) {
      assert.equal(response.status, none.status, "status must not differ");
      assert.equal(response.body.code, none.body.code, "code must not differ");
      assert.equal(response.body.error, none.body.error, "message must not differ");
    }
  } finally {
    http.close();
  }
});

test("a short bootstrap token is refused instead of trusted", async () => {
  freshEnv({ OWNER_BOOTSTRAP_TOKEN: "short" });
  const { http, register, status } = await boot(process.env.DATA_DIR);
  try {
    const result = await register("weak_owner", { bootstrapToken: "short" });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "WEAK_BOOTSTRAP_TOKEN");
    const state = await status();
    assert.equal(state.bootstrapTokenConfigured, false, "a short token does not count as configured");
    assert.equal(state.bootstrap, false, "and it certainly cannot create an owner");
  } finally {
    http.close();
  }
});

test("with no token configured, nobody can become the owner", async () => {
  freshEnv({ OWNER_BOOTSTRAP_TOKEN: "" });
  const { http, register, status } = await boot(process.env.DATA_DIR);
  try {
    const result = await register("hopeful", { bootstrapToken: "" });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "OWNER_BOOTSTRAP_REQUIRED");
    const state = await status();
    assert.equal(state.bootstrapTokenConfigured, false);
    assert.equal(state.privateAccess, false);
    assert.equal(state.access.blocked, true);
  } finally {
    http.close();
  }
});

test("ephemeral storage fails closed instead of handing the instance to a stranger", async () => {
  // The takeover scenario: identity lives on a disk that does not survive, so
  // relabelling the next visitor "owner" is exactly what must not happen.
  freshEnv({ OWNER_REQUIRE_PERSISTENT_STORAGE: "1" });
  const { http, register, status } = await boot(process.env.DATA_DIR);
  try {
    const state = await status();
    assert.equal(state.storage.durable, false, "a temp dir is not durable");
    assert.equal(state.storage.required, true, "persistence is required in this configuration");
    assert.equal(state.bootstrap, false, "the owner cannot be created on a disk that loses it");
    assert.equal(state.access.blocked, true);
    assert.equal(state.access.code, "PERSISTENT_STORAGE_REQUIRED");

    // Even with the correct token.
    const attempt = await register("stranger", { bootstrapToken: TOKEN });
    assert.equal(attempt.status, 503);
    assert.equal(attempt.body.code, "PERSISTENT_STORAGE_REQUIRED");
  } finally {
    http.close();
  }
});

test("a production deployment refuses to run ownerless", async () => {
  freshEnv({ NODE_ENV: "production" });
  const { http, status } = await boot(process.env.DATA_DIR);
  try {
    const state = await status();
    assert.equal(state.storage.required, true, "production always requires durable identity");
    assert.equal(state.access.blocked, true);
    assert.equal(state.access.code, "PERSISTENT_STORAGE_REQUIRED");
  } finally {
    http.close();
  }
});

test("durable storage detection is a real check, not a guess", () => {
  assert.equal(isEphemeralPath("/tmp/anything"), true);
  assert.equal(isEphemeralPath("/var/tmp/x"), true);
  assert.equal(isEphemeralPath("/dev/shm/x"), true);
  const previous = process.env.DATA_DIR;
  try {
    delete process.env.DATA_DIR;
    assert.equal(isEphemeralPath(path.join(process.cwd(), "data")), true,
      "an undeclared DATA_DIR lives inside the app directory, which a deploy replaces");
    process.env.DATA_DIR = "/var/data";
    assert.equal(isEphemeralPath("/var/data"), false);
    const state = storageState("/var/data");
    assert.equal(state.ephemeralPath, false);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  }
});

test("legacy records are adopted only by the bootstrapped owner", async () => {
  // The project exists before any account does (old install, restored backup).
  const dataDir = freshEnv();
  const { ProjectStore } = require("../lib/projects");
  const store = new ProjectStore({ root: path.join(dataDir, "projects") });
  store.save({
    id: "pLegacyOwnerWork", ownerId: null, topic: "पुराना मालिक का काम", status: "completed",
    sceneCount: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    assets: { scenes: {} }, story: { title: "निजी", scenes: [] }, render: { videoPath: null },
    timeline: [], progress: {}, error: null,
  });

  const { http, register, base } = await boot(dataDir);
  try {
    // Baseline: nobody has adopted it, simply by importing the server.
    const atStartup = new ProjectStore({ root: path.join(dataDir, "projects") }).get("pLegacyOwnerWork");
    assert.equal(atStartup.ownerId, null, "startup must not adopt anything on its own");

    // A refused signup must adopt nothing either.
    const refused = await register("not_the_owner");
    assert.equal(refused.status, 403, "this request is refused, so it proves nothing about adoption");
    const untouched = new ProjectStore({ root: path.join(dataDir, "projects") }).get("pLegacyOwnerWork");
    assert.equal(untouched.ownerId, null, "a refused request must not claim the record");

    const owner = await register("real_owner", { bootstrapToken: TOKEN });
    assert.equal(owner.body.user.role, "owner");
    const claimed = new ProjectStore({ root: path.join(dataDir, "projects") }).get("pLegacyOwnerWork");
    assert.equal(claimed.ownerId, owner.body.user.id, "the bootstrapped owner adopts it");

    const call = url => fetch(base + url, { headers: { Cookie: owner.cookie } });
    assert.equal((await call("/api/projects/pLegacyOwnerWork")).status, 200);

    // A later account (operator-opened signup) is a member and adopts nothing,
    // even though a fresh ownerless record appears after it exists.
    process.env.ALLOW_PUBLIC_SIGNUP = "1";
    process.env.APP_REGISTRATION_KEY = "team-key";
    const lateRecord = new ProjectStore({ root: path.join(dataDir, "projects") });
    lateRecord.save({
      id: "pLateOwnerless", ownerId: null, topic: "बाद में", status: "draft", sceneCount: 3,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      assets: { scenes: {} }, story: null, render: { videoPath: null }, timeline: [], progress: {}, error: null,
    });
    const member = await register("late_member", { registrationKey: "team-key" });
    assert.equal(member.body.user.role, "member");
    const stillOwnerless = new ProjectStore({ root: path.join(dataDir, "projects") }).get("pLateOwnerless");
    assert.equal(stillOwnerless.ownerId, null, "a member must never adopt legacy records");
  } finally {
    http.close();
  }
});

test("a restart with an existing owner does not adopt new legacy records", async () => {
  // The dangerous shape: the owner account survives, but ownerless records exist
  // (restored from an old backup, or written before auth). Automatic adoption at
  // startup would quietly stamp them, and any later adoption bug would hand them
  // to the wrong account. It must happen only for the account that proved the
  // bootstrap token — never as a side effect of starting the process.
  const dataDir = freshEnv();
  const { hashPassword } = require("../lib/auth");
  const ownerId = "uExistingOwner01";
  fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({
    version: 1,
    users: [{ id: ownerId, username: "existing_owner", role: "owner", createdAt: new Date().toISOString(),
      passwordHash: hashPassword("owner-password-123") }],
  }, null, 2));

  const { ProjectStore } = require("../lib/projects");
  const store = new ProjectStore({ root: path.join(dataDir, "projects") });
  store.save({
    id: "pRestoredLegacy", ownerId: null, topic: "बहाल किया गया", status: "completed", sceneCount: 3,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    assets: { scenes: {} }, story: { title: "पुरानी", scenes: [] }, render: { videoPath: null },
    timeline: [], progress: {}, error: null,
  });

  const { http, base } = await boot(dataDir);
  try {
    const afterBoot = new ProjectStore({ root: path.join(dataDir, "projects") }).get("pRestoredLegacy");
    assert.equal(afterBoot.ownerId, null, "starting the process must not adopt records by itself");

    // The real owner can still reach it (an unowned record belongs to the owner),
    // so nothing is lost by refusing to adopt automatically.
    const login = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "existing_owner", password: "owner-password-123" }),
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
    assert.equal((await fetch(base + "/api/projects/pRestoredLegacy", { headers: { Cookie: cookie } })).status, 200);
  } finally {
    http.close();
  }
});

test("a second owner account can never be created, even with signup opened", async () => {
  freshEnv({ ALLOW_PUBLIC_SIGNUP: "1", APP_REGISTRATION_KEY: "team-key" });
  const { http, register } = await boot(process.env.DATA_DIR);
  try {
    const owner = await register("owner_a", { bootstrapToken: TOKEN });
    assert.equal(owner.body.user.role, "owner");
    const member = await register("member_a", { registrationKey: "team-key" });
    assert.equal(member.status, 201);
    assert.equal(member.body.user.role, "member", "an opened signup still never creates an owner");
    // And the bootstrap token does not turn an opened signup into a second owner.
    const again = await register("owner_b", { bootstrapToken: TOKEN, registrationKey: "team-key" });
    assert.equal(again.body.user.role, "member");
  } finally {
    http.close();
  }
});

test("sessions are stored hashed, so the file is not a usable credential", async () => {
  const dataDir = freshEnv();
  const { http, register, base } = await boot(dataDir);
  try {
    const owner = await register("hashed_owner", { bootstrapToken: TOKEN });
    const rawId = owner.cookie.split("=").slice(1).join("=");
    const file = path.join(dataDir, "sessions.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = Object.keys(stored.sessions);

    assert.equal(keys.includes(rawId), false, "the raw cookie id must not be on disk");
    assert.equal(keys.includes(sessionKey(rawId)), true, "it is stored as a sha256 of the id");

    // Put the stored value into a cookie: it must not authenticate.
    const stolen = await fetch(base + "/api/projects", { headers: { Cookie: "baba_session=" + keys[0] } });
    assert.equal(stolen.status, 401, "a leaked file must not be replayable as a session");

    // The real cookie still works.
    assert.equal((await fetch(base + "/api/projects", { headers: { Cookie: owner.cookie } })).status, 200);
  } finally {
    http.close();
  }
});

test("credential files are not world-readable", async () => {
  const dataDir = freshEnv();
  const { http, register } = await boot(dataDir);
  try {
    await register("mode_owner", { bootstrapToken: TOKEN });
    for (const name of ["users.json", "sessions.json"]) {
      const mode = fs.statSync(path.join(dataDir, name)).mode & 0o777;
      assert.equal(mode, 0o600, name + " must be 0600, got " + mode.toString(8));
    }
  } finally {
    http.close();
  }
});
