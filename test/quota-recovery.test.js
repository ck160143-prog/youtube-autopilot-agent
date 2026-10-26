const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isQuotaError,
  extractRetryHint,
  quotaInfo,
  withTemporaryRetries
} = require("../server");

test("429 RESOURCE_EXHAUSTED is classified as quota and provides a clear hint", () => {
  const error = Object.assign(new Error("429 RESOURCE_EXHAUSTED: retry in 17h56m"), { status: 429 });
  assert.equal(isQuotaError(error), true);
  assert.match(extractRetryHint(error), /17h56m/i);
  const info = quotaInfo(error, "gemini-image-test", "image generation");
  assert.match(info.message, /429 RESOURCE_EXHAUSTED/);
  assert.match(info.message, /17h56m/);
});

test("quota errors are never retried", async () => {
  let calls = 0;
  await assert.rejects(
    withTemporaryRetries(async () => {
      calls++;
      throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 });
    }),
    /RESOURCE_EXHAUSTED/
  );
  assert.equal(calls, 1, "quota must stop after one provider request");
});

test("temporary 503 errors use bounded retries", async () => {
  let calls = 0;
  const result = await withTemporaryRetries(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});
