"use strict";

// Session storage at rest, and which account a YouTube connection belongs to.
//
// Two findings from the security review are pinned here.
//   1. Sessions were written in cleartext, and the file key WAS the cookie value:
//      copying an id out of data/sessions.json produced an HTTP 200 impersonation.
//   2. A YouTube cookie was accepted for whatever account presented it, so a
//      connection made by one account could drive another account's uploads.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const crypto = require("node:crypto");
const { sessionKey, hashPassword } = require("../lib/auth");

// What server.js setYoutubeSession() writes: AES-256-GCM over JSON, base64url,
// keyed by APP_SESSION_SECRET, with the owning account inside the payload.
function youtubeCookie(payload, ownerId) {
  const key = crypto.createHash("sha256").update(process.env.APP_SESSION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = JSON.stringify(Object.assign({}, payload, ownerId ? { ownerId } : {}));
  const encrypted = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return "baba_youtube_session=" + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

const TOKEN = "binding-token-for-tests-0123456789";

function freshEnv(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "binding-"));
  process.env.DATA_DIR = dataDir;
  process.env.OWNER_BOOTSTRAP_TOKEN = TOKEN;
  process.env.APP_SESSION_SECRET = "test-app-session-secret-0123456789abcdef";
  process.env.API_RATE_LIMIT_MULTIPLIER = "20";
  delete process.env.NODE_ENV;
  delete process.env.RENDER;
  delete process.env.OWNER_REQUIRE_PERSISTENT_STORAGE;
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

  const register = async (username, extra) => {
    const response = await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "owner-password-123", ...(extra || {}) }),
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    return { status: response.status, body, cookie: String(response.headers.get("set-cookie") || "").split(";")[0] };
  };
  const login = async (username) => {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "owner-password-123" }),
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    return { status: response.status, body, cookie: String(response.headers.get("set-cookie") || "").split(";")[0] };
  };
  return { http, base, register, login };
}

test("the stored session file is not a set of ready-to-use cookies", async () => {
  const dataDir = freshEnv();
  const { http, register, base } = await boot(dataDir);
  try {
    const owner = await register("file_owner", { bootstrapToken: TOKEN });
    const rawId = owner.cookie.split("=").slice(1).join("=");
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8"));
    const keys = Object.keys(stored.sessions);

    assert.equal(keys.includes(rawId), false, "the cookie value must not be the storage key");
    assert.equal(keys.includes(sessionKey(rawId)), true);

    // Reading the file and replaying it must fail.
    for (const key of keys) {
      const replay = await fetch(base + "/api/projects", { headers: { Cookie: "baba_session=" + key } });
      assert.equal(replay.status, 401, "a copied storage key must not be a session");
    }
    // While the genuine cookie works, so the refusal is about the key and not about the route.
    assert.equal((await fetch(base + "/api/projects", { headers: { Cookie: owner.cookie } })).status, 200);

    // The file must not leak the password either.
    const file = fs.readFileSync(path.join(dataDir, "sessions.json"), "utf8");
    assert.equal(file.includes("owner-password-123"), false, "no password may reach the session file");
    assert.equal(file.includes(rawId), false, "and no raw session id may be recoverable from it");
  } finally {
    http.close();
  }
});

test("a legacy raw-id session file stops working instead of staying valid", async () => {
  // Upgrade path: the old file is on disk. Its keys were raw cookie ids, so they
  // must not be honoured after the change.
  const dataDir = freshEnv();
  const { http, base } = await boot(dataDir);
  http.close();

  const legacyId = "legacyRawSessionId0123456789";
  fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify({
    version: 1,
    sessions: { [legacyId]: { userId: "uLegacy", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() } },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({
    version: 1,
    users: [{ id: "uLegacy", username: "legacy_owner", role: "owner", createdAt: new Date().toISOString(), passwordHash: hashPassword("owner-password-123") }],
  }, null, 2));

  const restarted = await boot(dataDir);
  try {
    const replay = await fetch(restarted.base + "/api/projects", { headers: { Cookie: "baba_session=" + legacyId } });
    assert.equal(replay.status, 401, "a legacy raw-id session must be dropped, not honoured");
  } finally {
    restarted.http.close();
  }
});

test("a YouTube connection belongs to the account that made it", async () => {
  const dataDir = freshEnv();
  const { http, register, base } = await boot(dataDir);
  try {
    const owner = await register("yt_owner", { bootstrapToken: TOKEN });
    assert.equal(owner.body.user.role, "owner");

    // The owner's own connection is used: the route accepts it and goes on to
    // talk to Google (which cannot be reached from here), so it is not 409.
    const mine = youtubeCookie({ access_token: "fake-token", expires_at: Date.now() + 3600000 }, owner.body.user.id);
    const accepted = await fetch(base + "/api/youtube/insights", { headers: { Cookie: owner.cookie + "; " + mine } });
    assert.notEqual(accepted.status, 409, "the owner's own connection must be used, got " + accepted.status);

    // A connection made by a different account id is not usable, even by the
    // owner: that is the previous holder's channel, and it must not drive this
    // account's uploads. This is the shape the review measured as a plain 200.
    const foreign = youtubeCookie({ access_token: "someone-elses-token", expires_at: Date.now() + 3600000 }, "uAnotherAccount");
    const refused = await fetch(base + "/api/youtube/insights", { headers: { Cookie: owner.cookie + "; " + foreign } });
    assert.equal(refused.status, 409, "a connection owned by another account must be refused");
    assert.equal((await refused.json()).code, "CHANNEL_NOT_CONNECTED");

    // A second account cannot even reach the route, because this instance serves
    // exactly one account role. Recorded here so the control above is not
    // mistaken for the only protection.
    process.env.ALLOW_PUBLIC_SIGNUP = "1";
    process.env.APP_REGISTRATION_KEY = "team-key";
    const member = await register("yt_member", { registrationKey: "team-key" });
    assert.equal(member.body.user.role, "member");
    const gated = await fetch(base + "/api/youtube/insights", { headers: { Cookie: member.cookie + "; " + mine } });
    assert.equal(gated.status, 403, "a member is refused by the owner-only gate first");
    assert.equal((await gated.json()).code, "OWNER_ONLY");
  } finally {
    http.close();
  }
});

test("a YouTube cookie that names no account is refused", async () => {
  // The exact bug: the cookie was read as "the connection" without checking who
  // it belonged to. Unbound means refuse, not "use it for whoever asks".
  const dataDir = freshEnv();
  const { http, register, base } = await boot(dataDir);
  try {
    const owner = await register("unbound_owner", { bootstrapToken: TOKEN });
    const unbound = youtubeCookie({ access_token: "fake-token", expires_at: Date.now() + 3600000 }, null);

    const status = await fetch(base + "/api/youtube/status", { headers: { Cookie: owner.cookie + "; " + unbound } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).connected, false, "an unbound cookie must not count as connected");

    // And a private route that needs the channel says so explicitly.
    const insights = await fetch(base + "/api/youtube/insights", { headers: { Cookie: owner.cookie + "; " + unbound } });
    assert.equal(insights.status, 409, "an unbound cookie must not reach YouTube on the owner's behalf");
    assert.equal((await insights.json()).code, "CHANNEL_NOT_CONNECTED");
  } finally {
    http.close();
  }
});

test("the session cookie carries the browser-protection flags", async () => {
  const dataDir = freshEnv();
  const { http } = await boot(dataDir);
  try {
    const raw = await fetch("http://127.0.0.1:" + http.address().port + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "flags_owner", password: "owner-password-123", bootstrapToken: TOKEN }),
    });
    const header = String(raw.headers.get("set-cookie") || "");
    assert.match(header, /HttpOnly/, "a script must not be able to read the session cookie");
    assert.match(header, /SameSite=Lax/i, "another site must not be able to drive requests with it");
    assert.match(header, /Path=\//, "it must be scoped to the app");
  } finally {
    http.close();
  }
});
