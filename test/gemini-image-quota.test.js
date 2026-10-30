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
  const info = quotaInfo(error, "gemini-3.1-flash-image");
  assert.equal(info.model, "gemini-3.1-flash-image");
  assert.match(info.message, /gemini-3\.1-flash-image/);
  assert.match(info.message, /20s/);
  assert.match(info.message, /RESOURCE_EXHAUSTED/);
});

test("image route preserves successful scenes and stops after a scene-level 429", async () => {
  const { app, setAIClientFactoryForTests, resetAIClientFactory } = require("../server.js");
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.GEMINI_IMAGE_MODEL;
  process.env.GEMINI_API_KEY = "test-only-key";
  process.env.GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
  let imageCalls = 0;
  setAIClientFactoryForTests(() => ({
    models: {
      generateContent: async (request) => {
        if (request.config?.responseMimeType === "application/json") {
          return { text: JSON.stringify({ scenes: [
            { title: "one", prompt: "scene one" },
            { title: "two", prompt: "scene two" },
            { title: "three", prompt: "scene three" }
          ] }) };
        }
        imageCalls += 1;
        if (imageCalls === 1) {
          return { candidates: [{ content: { parts: [
            { inlineData: { mimeType: "image/png", data: "dGVzdC1pbWFnZQ==" } }
          ] } }] };
        }
        throw Object.assign(new Error('429 RESOURCE_EXHAUSTED retryDelay: "30s"'), {
          status: 429, code: "RESOURCE_EXHAUSTED"
        });
      }
    }
  }));

  const server = app.listen(0);
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "test script" })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    // Wikimedia fallback may add real images after Gemini quota is exhausted.
    // Verify the successful Gemini scene is retained without assuming fallback count.
    assert.ok(body.images.some(image => image.imageBase64 === "dGVzdC1pbWFnZQ=="));

    assert.equal(imageCalls, 2, "must not request scene three after 429");
    assert.equal(body.quotaInfo.model, "gemini-3.1-flash-image");
    assert.match(body.quotaInfo.message, /30s/);
    assert.match(body.quotaInfo.message, /RESOURCE_EXHAUSTED/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    resetAIClientFactory();
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.GEMINI_IMAGE_MODEL;
    else process.env.GEMINI_IMAGE_MODEL = oldModel;
  }
});
