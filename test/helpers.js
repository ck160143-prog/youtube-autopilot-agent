"use strict";

// Shared auth helper for API tests.
//
// Owner-only access with an explicit bootstrap means the first registration no
// longer becomes the owner: it needs OWNER_BOOTSTRAP_TOKEN. This file installs a
// test token and exposes it as a named fixture, so a suite that wants an owner
// asks for one on purpose (`registerOwner`) instead of getting it by accident.
// Nothing here weakens the production default — the token only exists because the
// test process sets it, exactly as an operator would.

const OWNER_BOOTSTRAP_TOKEN = "test-owner-bootstrap-token-0123456789";

// Kept deliberately separate from OWNER_REQUIRE_PERSISTENT_STORAGE: test data dirs
// live under the OS temp directory, which is ephemeral by definition. A suite that
// wants to prove the fail-closed storage gate must turn the requirement on itself.
if (!process.env.OWNER_BOOTSTRAP_TOKEN) {
  process.env.OWNER_BOOTSTRAP_TOKEN = OWNER_BOOTSTRAP_TOKEN;
}

async function registerAndLogin(base, username, options) {
  const payload = { username: username || "tester", password: "test-password-123" };
  if (options && options.registrationKey) payload.registrationKey = options.registrationKey;
  if (options && options.bootstrapToken) payload.bootstrapToken = options.bootstrapToken;
  const response = await fetch(base + "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok && body && body.code === "OWNER_BOOTSTRAP_REQUIRED") {
    throw new Error(
      "this test needs the owner account: use registerOwner(base, name) from test/helpers.js " +
      "(owner creation requires OWNER_BOOTSTRAP_TOKEN)"
    );
  }
  if (!response.ok && body && body.code === "SIGNUP_CLOSED") {
    throw new Error("this test needs a second account: set ALLOW_PUBLIC_SIGNUP=1 in the test file (owner-only access closed public signup by default)");
  }
  if (!response.ok) throw new Error("test registration failed: " + JSON.stringify(body));
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  return { cookie, csrfToken: body.csrfToken, user: body.user };
}

// Create the owner the only way an owner can be created: with the bootstrap token.
function registerOwner(base, username) {
  return registerAndLogin(base, username || "owner", {
    bootstrapToken: process.env.OWNER_BOOTSTRAP_TOKEN || OWNER_BOOTSTRAP_TOKEN,
  });
}

function authHeaders(session, extra) {
  return Object.assign({
    Cookie: session.cookie,
    "x-csrf-token": session.csrfToken,
    "Content-Type": "application/json",
  }, extra || {});
}

// One session per process; the auth store lives at module scope, so it stays
// valid across server instances created by different tests.
let cached = null;
async function authedHeaders(base, username) {
  if (!cached) cached = await registerOwner(base, username);
  return authHeaders(cached);
}

module.exports = {
  registerAndLogin,
  registerOwner,
  authHeaders,
  authedHeaders,
  OWNER_BOOTSTRAP_TOKEN,
};
