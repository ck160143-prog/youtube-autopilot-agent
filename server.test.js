"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app, getPcmDurationSeconds } = require("./server");

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
