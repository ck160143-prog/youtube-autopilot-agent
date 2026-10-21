const test = require("node:test");
const assert = require("node:assert/strict");
const { withTemporaryRetries, extractRetryHint, quotaInfo } = require("../server.js");

test("429 RESOURCE_EXHAUSTED is never retried", async () => {
  let calls = 0;
  const quotaError = Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 });
  await assert.rejects(
    withTemporaryRetries(async () => {
      calls += 1;
      throw quotaError;
    }),
    /RESOURCE_EXHAUSTED/
  );
  assert.equal(calls, 1);
});

test("temporary 503 gets only two bounded retries (three total attempts)", async () => {
  let calls = 0;
  const temporaryError = Object.assign(new Error("temporary unavailable"), { status: 503 });
  await assert.rejects(
    withTemporaryRetries(async () => {
      calls += 1;
      throw temporaryError;
    }),
    /temporary unavailable/
  );
  assert.equal(calls, 3);
});

test("quota notice includes configured model and Google's retry hint", () => {
  const error = Object.assign(new Error('429 RESOURCE_EXHAUSTED; retryDelay: "20s"'), { status: 429 });
  assert.equal(extractRetryHint(error), "20s");
  const info = quotaInfo(error, "gemini-2.5-flash-image");
  assert.equal(info.model, "gemini-2.5-flash-image");
  assert.match(info.message, /gemini-2\.5-flash-image/);
  assert.match(info.message, /20s/);
  assert.match(info.message, /RESOURCE_EXHAUSTED/);
});
