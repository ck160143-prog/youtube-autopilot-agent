"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app, getPcmDurationSeconds, setAIClientFactoryForTests, resetAIClientFactory, resetGeminiCooldownForTests } = require("./server");

test("PCM duration uses decoded bytes and 24 kHz mono 16-bit defaults", () => {
  const oneSecondPcm = Buffer.alloc(24000 * 2);
  assert.equal(getPcmDurationSeconds(oneSecondPcm.toString("base64")), 1);
  assert.equal(getPcmDurationSeconds(Buffer.alloc(12000).toString("base64")), 0.25);
  assert.equal(getPcmDurationSeconds(""), 0);
});

let server;
let baseUrl;

test("start test server", async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test("health endpoint returns JSON without exposing credentials", async () => {
  const response = await fetch(baseUrl + "/api/health");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.geminiKeyConfigured, "boolean");
  assert.equal(JSON.stringify(body).includes(process.env.GEMINI_API_KEY || "secret-value-not-present"), false);
});

test("script generation stops immediately when primary Gemini model hits 429 quota", async () => {
  resetGeminiCooldownForTests();
  const oldKey = process.env.GEMINI_API_KEY;
  const oldPrimary = process.env.GEMINI_SCRIPT_MODEL;
  const oldFallback = process.env.GEMINI_SCRIPT_FALLBACK_MODEL;
  process.env.GEMINI_API_KEY = "test-key-not-real";
  process.env.GEMINI_SCRIPT_MODEL = "gemini-3.8-flash";
  process.env.GEMINI_SCRIPT_FALLBACK_MODEL = "gemini-2.5-flash-lite";
  const called = [];
  setAIClientFactoryForTests(() => ({
    models: {
      async generateContent(args) {
        called.push(args.model);
        if (args.model === "gemini-3.8-flash") {
          const error = new Error("429 RESOURCE_EXHAUSTED: quota exhausted");
          error.status = 429;
          throw error;
        }
        return { text: "नई हिंदी स्क्रिप्ट" };
      }
    }
  }));
  try {
    const response = await fetch(baseUrl + "/api/script", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "ताजमहल के रहस्य", duration: 5, language: "हिंदी" })
    });
    const body = await response.json();
    assert.equal(response.status, 429);
    assert.match(body.error, /quota/i);
    assert.deepEqual(called, ["gemini-3.8-flash"]);
  } finally {
    resetAIClientFactory();
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    if (oldPrimary === undefined) delete process.env.GEMINI_SCRIPT_MODEL; else process.env.GEMINI_SCRIPT_MODEL = oldPrimary;
    if (oldFallback === undefined) delete process.env.GEMINI_SCRIPT_FALLBACK_MODEL; else process.env.GEMINI_SCRIPT_FALLBACK_MODEL = oldFallback;
  }
});

test("script generation falls back when a configured Gemini model ID returns 404", async () => {
  resetGeminiCooldownForTests();
  const oldKey = process.env.GEMINI_API_KEY;
  const oldPrimary = process.env.GEMINI_SCRIPT_MODEL;
  const oldFallback = process.env.GEMINI_SCRIPT_FALLBACK_MODEL;
  process.env.GEMINI_API_KEY = "test-key-not-real";
  process.env.GEMINI_SCRIPT_MODEL = "stale-model-id";
  process.env.GEMINI_SCRIPT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
  const called = [];
  setAIClientFactoryForTests(() => ({
    models: {
      async generateContent(args) {
        called.push(args.model);
        if (args.model === "stale-model-id") {
          const error = new Error("404 model not found");
          error.status = 404;
          throw error;
        }
        return { text: "Fallback से बनी स्क्रिप्ट" };
      }
    }
  }));
  try {
    const response = await fetch(baseUrl + "/api/script", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "ताजमहल के रहस्य", duration: 5, language: "हिंदी" })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.script, "Fallback से बनी स्क्रिप्ट");
    assert.deepEqual(called, ["stale-model-id", "gemini-3.5-flash-lite"]);
  } finally {
    resetAIClientFactory();
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    if (oldPrimary === undefined) delete process.env.GEMINI_SCRIPT_MODEL; else process.env.GEMINI_SCRIPT_MODEL = oldPrimary;
    if (oldFallback === undefined) delete process.env.GEMINI_SCRIPT_FALLBACK_MODEL; else process.env.GEMINI_SCRIPT_FALLBACK_MODEL = oldFallback;
  }
});

test("invalid render input returns a JSON 400, not an HTML proxy-style error", async () => {
  const response = await fetch(baseUrl + "/api/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenes: [], audioBase64: "" })
  });
  const contentType = response.headers.get("content-type") || "";
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(contentType, /application\/json/i);
  assert.match(body.error, /scene images.*audio/i);
});

test("malformed JSON requests receive a safe JSON 400", async () => {
  const response = await fetch(baseUrl + "/api/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{broken"
  });
  const contentType = response.headers.get("content-type") || "";
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(contentType, /application\/json/i);
  assert.match(body.error, /JSON सही नहीं है/);
});

test("unknown render job status and download return JSON 404", async () => {
  const statusResponse = await fetch(baseUrl + "/api/render/status/not-a-real-job");
  const statusBody = await statusResponse.json();
  assert.equal(statusResponse.status, 404);
  assert.match(statusBody.error, /Render job नहीं मिला/);

  const downloadResponse = await fetch(baseUrl + "/api/render/download/not-a-real-job");
  const downloadBody = await downloadResponse.json();
  assert.equal(downloadResponse.status, 404);
  assert.match(downloadBody.error, /Render job नहीं मिला/);
});

test("unknown API endpoint returns a JSON 404", async () => {
  const response = await fetch(baseUrl + "/api/not-a-real-route");
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.match(body.error, /API endpoint नहीं मिला/);
});

test("stop test server", async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test("inline browser JavaScript in index.html parses without syntax errors", () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const html = fs.readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "index.html should contain inline JavaScript");
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(match[1], { filename: "index.html:inline-script-" + (index + 1) }),
      "inline script " + (index + 1) + " must parse");
  }
});
