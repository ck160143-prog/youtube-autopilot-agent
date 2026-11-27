"use strict";

// Regression: a DNS/TLS/offline failure used to be reported as "Gemini ने key
// reject की" (reason: "rejected"). That tells the user to rotate a valid key
// when the real fault is the host's outbound network. A key that Google really
// rejects (HTTP 400/403) must still say so.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-net-"));
process.env.GEMINI_API_KEY = "dummy-test-key-not-a-real-credential";

const { app, isNetworkError, networkErrorDetail, setAIClientFactoryForTests, resetAIClientFactory } =
  require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");

let server;
let base;
let session;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "net_user");
});

test.after(() => { if (server) server.close(); resetAIClientFactory(); });

function fetchFailure(code) {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error("getaddrinfo " + code + " generativelanguage.googleapis.com"), { code });
  return error;
}

test("a call that runs past its deadline is reported as unreachable, not as a 502", () => {
  // Regression: AbortSignal.timeout() throws name=TimeoutError / code=ABORT_ERR,
  // which used to fall through to the generic 502 branch.
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  timeout.code = "ABORT_ERR";
  assert.equal(isNetworkError(timeout), true);
  assert.match(networkErrorDetail(timeout), /ABORT_ERR/);

  const aborted = new Error("This operation was aborted");
  aborted.name = "AbortError";
  aborted.code = "ABORT_ERR";
  assert.equal(isNetworkError(aborted), true);
});

test("isNetworkError recognises DNS/TLS failures and rejects HTTP errors", () => {
  assert.equal(isNetworkError(fetchFailure("ENOTFOUND")), true);
  assert.equal(isNetworkError(fetchFailure("EAI_AGAIN")), true);
  assert.equal(isNetworkError(fetchFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), true);
  assert.equal(isNetworkError(Object.assign(new Error("network down"), { code: "ECONNRESET" })), true);

  const rejected = Object.assign(new Error("API key not valid"), { status: 400 });
  assert.equal(isNetworkError(rejected), false, "a rejected key must not be called a network fault");
  const forbidden = Object.assign(new Error("permission denied"), { status: 403 });
  assert.equal(isNetworkError(forbidden), false);
});

test("networkErrorDetail reports the cause code without any secret", () => {
  const detail = networkErrorDetail(fetchFailure("ENOTFOUND"));
  assert.match(detail, /ENOTFOUND/);
  assert.doesNotMatch(detail, /AIza/, "the key must never appear in a diagnostic string");
});

test("verify setup reports a network fault as network, not as a rejected key", async () => {
  setAIClientFactoryForTests(() => ({
    models: { list: async () => { throw fetchFailure("ENOTFOUND"); } },
  }));
  const response = await fetch(base + "/api/setup/verify", {
    method: "POST", headers: authHeaders(session), body: JSON.stringify({}),
  });
  const body = await response.json();
  const gemini = (body.results || []).find(c => c.id === "GEMINI_API_KEY");
  assert.ok(gemini, "verify must report the Gemini check");
  assert.equal(gemini.reason, "network", "reason must say network, got: " + JSON.stringify(gemini));
  assert.match(gemini.detail, /पहुँच नहीं बनी/);
  assert.doesNotMatch(JSON.stringify(body), /AIza/, "no key material in the response");
  assert.doesNotMatch(JSON.stringify(body), /DUMMYNETWORKTEST/);
});

test("a key Google really rejects is still reported as rejected", async () => {
  setAIClientFactoryForTests(() => ({
    models: { list: async () => { throw Object.assign(new Error("API key not valid. Please pass a valid API key."), { status: 400 }); } },
  }));
  const response = await fetch(base + "/api/setup/verify", {
    method: "POST", headers: authHeaders(session), body: JSON.stringify({}),
  });
  const body = await response.json();
  const gemini = (body.results || []).find(c => c.id === "GEMINI_API_KEY");
  assert.equal(gemini.reason, "rejected", "a real rejection keeps its own reason");
});

test("an offline Gemini call answers 503 NETWORK_UNREACHABLE, not a key error", async () => {
  // The real client shape is models.generateContent; a fake that lacks it would
  // fail with a TypeError and quietly prove nothing, so it throws the network
  // error the same way the SDK transports a DNS failure.
  setAIClientFactoryForTests(() => ({
    models: {
      list: async () => [],
      generateContent: async () => { throw fetchFailure("EAI_AGAIN"); },
    },
  }));
  const response = await fetch(base + "/api/script", {
    method: "POST", headers: authHeaders(session),
    body: JSON.stringify({ topic: "सूर्य", durationMinutes: 1 }),
  });
  const body = await response.json();
  assert.equal(response.status, 503, "an unreachable provider is 503, got " + response.status + " " + JSON.stringify(body).slice(0, 160));
  assert.equal(body.code, "NETWORK_UNREACHABLE");
  assert.equal(body.reason.includes("EAI_AGAIN"), true, "cause code stays actionable: " + body.reason);
  assert.doesNotMatch(JSON.stringify(body), /AIza/, "no key material in the error body");
  assert.doesNotMatch(JSON.stringify(body), /DUMMYNETWORKTEST/);
});
