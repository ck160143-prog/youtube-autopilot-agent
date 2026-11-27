"use strict";

// Scheduled publishing. YouTube has no scheduler endpoint: status.publishAt is
// the only mechanism, and Google accepts it only while privacyStatus is
// "private". A past timestamp publishes immediately instead of erroring, and a
// video that has been public once can never be scheduled again — so the app has
// to reject those cases itself, before any bytes are uploaded.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-sched-"));
process.env.API_RATE_LIMIT_MULTIPLIER = "10";

const { app, validateScheduleAt, buildVideoStatus } = require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");

let server;
let base;
let session;
const googleCalls = [];

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "sched_user");

  const realFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/googleapis\.com/.test(url)) {
      googleCalls.push({ url, body: options && options.body });
      return new Response(JSON.stringify({ error: { message: "blocked in test" } }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, options);
  };
});

test.after(() => server && server.close());

function call(url, options) {
  return fetch(base + url, {
    ...(options || {}),
    headers: authHeaders(session, (options && options.headers) || {}),
  });
}

// ---------- pure rules ----------

test("no publishAt means an immediate upload, unchanged behaviour", () => {
  for (const value of [undefined, null, ""]) {
    const result = validateScheduleAt(value);
    assert.equal(result.ok, true);
    assert.equal(result.publishAt, null);
  }
  assert.deepEqual(buildVideoStatus({ privacy: "public", publishAt: null }),
    { selfDeclaredMadeForKids: false, privacyStatus: "public" });
});

test("a future timestamp is accepted and normalised to UTC ISO", () => {
  const now = Date.parse("2026-12-01T00:00:00Z");
  const result = validateScheduleAt("2026-12-05T14:30:00Z", now);
  assert.equal(result.ok, true);
  assert.equal(result.publishAt, "2026-12-05T14:30:00.000Z");
});

test("a past or too-soon timestamp is refused, because YouTube would publish it now", () => {
  const now = Date.parse("2026-12-01T00:00:00Z");
  const past = validateScheduleAt("2026-11-01T00:00:00Z", now);
  assert.equal(past.ok, false);
  assert.equal(past.reason, "past");

  const twoMinutes = validateScheduleAt("2026-12-01T00:02:00Z", now);
  assert.equal(twoMinutes.ok, false, "2 minutes out would publish almost immediately");
  assert.equal(twoMinutes.reason, "past");
});

test("a nonsense timestamp is refused instead of becoming Invalid Date", () => {
  const result = validateScheduleAt("kal subah", Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("a scheduled video is always forced private, whatever privacy was asked for", () => {
  // This is the rule Google enforces: public + publishAt = invalidPublishAt.
  for (const privacy of ["public", "unlisted", "private"]) {
    const status = buildVideoStatus({ privacy, publishAt: "2026-12-05T14:30:00.000Z" });
    assert.equal(status.privacyStatus, "private", "privacy " + privacy + " must become private");
    assert.equal(status.publishAt, "2026-12-05T14:30:00.000Z");
  }
});

// ---------- real route ----------

test("preflight reports the schedule and never contacts Google", async () => {
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const response = await call("/api/youtube/upload/preflight", {
    method: "POST",
    body: JSON.stringify({ size: 1024, title: "टेस्ट", publishAt: future, privacy: "public" }),
  });
  const body = await response.json();
  const byId = Object.fromEntries(body.checks.map(item => [item.id, item]));
  assert.equal(byId.SCHEDULE.ok, true);
  assert.match(byId.SCHEDULE.detail, /private रहेगा/);
  assert.equal(body.wouldUpload, false);

  const bad = await call("/api/youtube/upload/preflight", {
    method: "POST",
    body: JSON.stringify({ size: 1024, title: "टेस्ट", publishAt: "2020-01-01T00:00:00Z" }),
  });
  const badById = Object.fromEntries((await bad.json()).checks.map(item => [item.id, item]));
  assert.equal(badById.SCHEDULE.ok, false, "a past schedule must fail the preflight");
  assert.deepEqual(googleCalls, [], "preflight must not contact Google");
});

test("upload refuses a past publishAt before sending the file", async () => {
  const saved = {
    YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI,
    APP_SESSION_SECRET: process.env.APP_SESSION_SECRET,
  };
  process.env.YOUTUBE_CLIENT_ID = "test-client-id";
  process.env.YOUTUBE_CLIENT_SECRET = "test-client-secret";
  process.env.YOUTUBE_REDIRECT_URI = "http://127.0.0.1/api/youtube/callback";
  process.env.APP_SESSION_SECRET = "test-session-secret-0123456789abcdefghij";
  try {
    const response = await call("/api/youtube/upload", {
      method: "POST",
      headers: {
        "Content-Type": "video/mp4",
        "x-confirm-upload": "yes",
        "x-video-title": "t",
        "x-video-publish-at": "2020-01-01T00:00:00Z",
      },
      body: Buffer.from("not-a-real-video"),
    });
    assert.equal(response.status, 400, "a past schedule must be refused");
    assert.equal((await response.json()).code, "INVALID_PUBLISH_AT");
    assert.deepEqual(googleCalls, [], "no bytes may leave for Google");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
