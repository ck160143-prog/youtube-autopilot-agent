"use strict";

// Shared auth helper for API tests: registers the first account (the owner) and
// returns cookie + CSRF token headers for state-changing requests.

async function registerAndLogin(base, username, options) {
  const payload = { username: username || "tester", password: "test-password-123" };
  if (options && options.registrationKey) payload.registrationKey = options.registrationKey;
  // Creating a SECOND account is no longer possible by default: owner-only access
  // closes public signup. Tests that need another account to prove isolation must
  // say so out loud by setting ALLOW_PUBLIC_SIGNUP, which is what an operator
  // would do; this helper never weakens the default for other tests.
  const response = await fetch(base + "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok && body && body.code === "SIGNUP_CLOSED") {
    throw new Error("this test needs a second account: set ALLOW_PUBLIC_SIGNUP=1 in the test file (owner-only access closed public signup by default)");
  }
  if (!response.ok) throw new Error("test registration failed: " + JSON.stringify(body));
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  return { cookie, csrfToken: body.csrfToken, user: body.user };
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
  if (!cached) cached = await registerAndLogin(base, username);
  return authHeaders(cached);
}

module.exports = { registerAndLogin, authHeaders, authedHeaders };
