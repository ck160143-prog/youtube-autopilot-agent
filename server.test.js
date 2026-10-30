"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("./server");

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

test("unknown API endpoint returns a JSON 404", async () => {
  const response = await fetch(baseUrl + "/api/not-a-real-route");
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.match(body.error, /API endpoint नहीं मिला/);
});

test("stop test server", async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
