"use strict";

// Upload safety: preflight validates everything but never uploads, and the real
// upload route refuses to run without an explicit confirmation header.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-yt-"));
// This file makes more than 5 /api/youtube/upload calls (the production bucket
// limit per minute). The multiplier is the documented test knob; production
// keeps limit 5 unless API_RATE_LIMIT_MULTIPLIER is set in the environment.
process.env.API_RATE_LIMIT_MULTIPLIER = "10";

const { app } = require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");

let server;
let base;
let session;
const networkCalls = [];

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "yt_user");

  // Any call to Google's APIs from this test process is recorded and blocked.
  const realFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/googleapis\.com/.test(url)) {
      networkCalls.push(url);
      return new Response(JSON.stringify({ error: { message: "blocked in test" } }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, options);
  };
});

test.after(() => server.close());

async function call(url, options) {
  return fetch(base + url, { ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}) });
}

test("preflight reports what is missing and never uploads", async () => {
  const response = await call("/api/youtube/upload/preflight", {
    method: "POST",
    body: JSON.stringify({ size: 1024 * 1024, title: "परीक्षण", privacy: "private" }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.wouldUpload, false);
  assert.equal(body.ok, false);
  const byId = Object.fromEntries(body.checks.map(item => [item.id, item]));
  assert.equal(byId.OAUTH_CONFIG.ok, false);
  assert.equal(byId.CHANNEL_CONNECTED.ok, false);
  assert.equal(byId.VIDEO_SIZE_LIMIT.ok, true);
  assert.equal(byId.TITLE.ok, true);
  assert.deepEqual(networkCalls, [], "preflight must not contact Google when not asked to verify a token");
});

test("preflight validates metadata the same way the upload does", async () => {
  const response = await call("/api/youtube/upload/preflight", {
    method: "POST",
    body: JSON.stringify({ size: 1024, title: "", privacy: "everyone" }),
  });
  const body = await response.json();
  const byId = Object.fromEntries(body.checks.map(item => [item.id, item]));
  assert.equal(byId.TITLE.ok, false);
  assert.equal(byId.PRIVACY.ok, false);
});

test("preflight flags a project whose MP4 is not rendered", async () => {
  const created = await call("/api/projects", {
    method: "POST", body: JSON.stringify({ topic: "render नहीं हुआ" }),
  });
  const project = (await created.json()).project;
  const response = await call("/api/youtube/upload/preflight", {
    method: "POST",
    body: JSON.stringify({ projectId: project.id, title: "x" }),
  });
  const body = await response.json();
  assert.equal(body.checks.find(item => item.id === "VIDEO_FILE").ok, false);
  assert.equal(body.ok, false);
});

test("upload is refused without an explicit confirmation header", async () => {
  const response = await call("/api/youtube/upload", {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: Buffer.from("not-a-real-video"),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "CONFIRM_REQUIRED");
  assert.deepEqual(networkCalls, [], "no upload request may reach Google");
});

test("preflight cannot be used to publish anything", async () => {
  const response = await call("/api/youtube/upload/preflight", {
    method: "POST",
    body: JSON.stringify({ size: 5 * 1024 * 1024, title: "टेस्ट", privacy: "public", publish: true }),
  });
  const body = await response.json();
  assert.equal(body.wouldUpload, false);
  assert.match(body.note, /upload/i);
  assert.equal(networkCalls.length, 0);
});

test("tags and categoryId are validated the way YouTube enforces them", async () => {
  // Pure rules first: the upload route and the preflight must agree, and the
  // 500-character cap is counted over the comma-joined string.
  const { normalizeYoutubeTags } = require("../server");
  assert.equal(normalizeYoutubeTags(["taj mahal", "रहस्य", " "]).tags.length, 2);
  assert.equal(normalizeYoutubeTags(["x".repeat(61)]).tags.length, 0, "a tag over 60 chars is dropped");
  assert.equal(normalizeYoutubeTags(Array.from({ length: 40 }, (_, i) => "t" + i)).tags.length, 30, "max 30 tags");
  const long = Array.from({ length: 30 }, (_, i) => "tag" + i + "x".repeat(20));
  assert.equal(normalizeYoutubeTags(long).ok, false, "over 500 characters must fail");

  // Then one real preflight call (the upload bucket allows 5/minute).
  const body = await (await call("/api/youtube/upload/preflight", {
    method: "POST",
    body: JSON.stringify({ size: 1024, title: "टेस्ट", tags: ["taj mahal", "हिंदी कार्टून", "रहस्य"] }),
  })).json();
  const byId = Object.fromEntries((body.checks || []).map(item => [item.id, item]));
  assert.equal(byId.TAGS.ok, true, "short tags must pass");
  assert.match(byId.TAGS.detail, /3 tags/);
  assert.equal(byId.CATEGORY.ok, true, "a default categoryId must be present");
  assert.match(byId.CATEGORY.detail, /categoryId: 22/);
  assert.deepEqual(networkCalls, [], "preflight never contacts Google");
});

test("upload sends tags and categoryId in the insert body", () => {
  // Guarded by reading the source: the snippet must carry categoryId (YouTube
  // rejects an insert without it) and the tags array when present.
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const snippet = source.slice(source.indexOf("uploadType=resumable&part=snippet,status"));
  const body = snippet.slice(0, snippet.indexOf("status: {"));
  assert.match(body, /categoryId,/, "insert body must include categoryId");
  assert.match(body, /tags/, "insert body must include tags when present");
});
