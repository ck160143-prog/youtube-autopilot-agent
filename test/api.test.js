const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-"));

const assert = require("node:assert/strict");
const { app, isQuotaError, getStatus, resetAIClientFactory } = require("../server");
const { authedHeaders } = require("./helpers");

async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("health endpoint reports server status without exposing secrets", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/health");
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(Object.hasOwn(data, "apiKey"), false);
  });
});

test("script and SEO reject missing topics before calling Gemini", async () => {
  await withServer(async base => {
    for (const endpoint of ["/api/script", "/api/seo"]) {
      const response = await fetch(base + endpoint, {
        method: "POST",
        headers: await authedHeaders(base),
        body: JSON.stringify({})
      });
      assert.equal(response.status, 400, endpoint);
      assert.ok((await response.json()).error);
    }
  });
});

test("voice rejects empty text before calling Gemini", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/voice", {
      method: "POST",
      headers: await authedHeaders(base),
      body: JSON.stringify({ text: "   " })
    });
    assert.equal(response.status, 400);
  });
});

test("unknown API paths return JSON 404", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/not-a-real-route", { headers: await authedHeaders(base) });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
  });
});

test("image generation reports a blocked state, not a 500, when the API key is missing", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  resetAIClientFactory();
  try {
    await withServer(async base => {
      const response = await fetch(base + "/api/images", {
        method: "POST",
        headers: await authedHeaders(base),
        body: JSON.stringify({ script: "एक छोटी हिंदी कहानी का परीक्षण।" })
      });
      // A missing key is a configuration state, never a server fault.
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.blocked, true);
      assert.match(body.error, /GEMINI_API_KEY/);
      assert.ok(Array.isArray(body.setup.steps) && body.setup.steps.length >= 3,
        "the response must tell the user how to fix it");
      assert.equal(JSON.stringify(body).includes(previousKey || "\u0000"), false);
    });
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    resetAIClientFactory();
  }
});

test("quota classification avoids treating generic billing wording as quota exhaustion", () => {
  assert.equal(isQuotaError({ status: 429, message: "RESOURCE_EXHAUSTED" }), true);
  assert.equal(isQuotaError({ status: 403, message: "Billing account disabled" }), false);
  assert.equal(getStatus({ status: 503 }), 503);
});

test("script generation returns a setup error when the API key is missing", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  resetAIClientFactory();
  try {
    await withServer(async base => {
      const response = await fetch(base + "/api/script", {
        method: "POST",
        headers: await authedHeaders(base),
        body: JSON.stringify({ topic: "हिंदी प्रेरणा", duration: 5, language: "हिंदी" })
      });
      // Missing key is a blocked state with the steps to fix it, not a generic 500.
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.blocked, true);
      assert.match(body.error, /GEMINI_API_KEY/);
      assert.ok(Array.isArray(body.setup.steps) && body.setup.steps.length >= 3,
        "the response must tell the user how to fix it");
      assert.equal(JSON.stringify(body).includes(previousKey || "\u0000"), false);
    });
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    resetAIClientFactory();
  }
});
