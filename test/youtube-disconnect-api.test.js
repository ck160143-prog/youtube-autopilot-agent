"use strict";

// The disconnect route had no coverage at all. Its security matters more than
// most routes because it touches a session cookie, so the tests pin: it needs an
// authenticated session, it rejects a request without the CSRF token, and it
// really expires the YouTube cookie instead of merely claiming success.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { registerAndLogin, authHeaders, registerOwner } = require("./helpers");

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-disconnect-"));
  process.env.DATA_DIR = dataDir;
  process.env.APP_REGISTRATION_KEY = "yt-team-key";
  delete require.cache[require.resolve("../server")];
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return { server, base, dataDir };
}

test("disconnect requires a signed-in user", async () => {
  const { server, base, dataDir } = await boot();
  try {
    const res = await fetch(base + "/api/youtube/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": "anything" },
    });
    // With no owner yet the instance is fail-closed and answers 503; once an
    // owner exists the same anonymous request is a plain 401. Both are refusals,
    // and which one you get must never be a success.
    assert.ok([401, 503].includes(res.status), "an anonymous disconnect must be refused, got " + res.status);
    if (res.status === 503) {
      assert.equal((await res.json()).code, "OWNER_NOT_CONFIGURED");
    }
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("disconnect requires the CSRF token", async () => {
  const { server, base, dataDir } = await boot();
  try {
    const session = await registerOwner(base, "yt_user", { registrationKey: process.env.APP_REGISTRATION_KEY });
    const res = await fetch(base + "/api/youtube/disconnect", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json" },
    });
    assert.equal(res.status, 403, "a state-changing call without CSRF must be refused");
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a valid disconnect expires the YouTube cookie", async () => {
  const { server, base, dataDir } = await boot();
  try {
    const session = await registerOwner(base, "yt_user2", { registrationKey: process.env.APP_REGISTRATION_KEY });
    const res = await fetch(base + "/api/youtube/disconnect", {
      method: "POST", headers: authHeaders(session),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const cookie = String(res.headers.get("set-cookie") || "");
    assert.match(cookie, /baba_youtube_session=/, "the YouTube cookie must be addressed: " + cookie);
    assert.match(cookie, /Max-Age=0/, "the cookie must actually expire: " + cookie);
    assert.match(cookie, /HttpOnly/, "the cookie must stay HttpOnly: " + cookie);
    // It must not touch the login session: the user stays signed in.
    const me = await fetch(base + "/api/auth/me", { headers: authHeaders(session) });
    assert.equal(me.status, 200, "disconnecting YouTube must not sign the user out");
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
