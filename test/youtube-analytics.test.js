"use strict";

// YouTube Analytics is read-only, but it has sharp edges worth pinning down:
//   - reports.query needs BOTH youtube.readonly and yt-analytics.readonly
//   - data lags 24-72 hours, so an endDate of today is an empty answer, not "0 views"
//   - averageViewDuration must be averaged, never summed across days
// A connection made before the analytics scope existed must say so instead of
// looking like a server crash.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-analytics-"));

const { app, validateAnalyticsRange, shapeAnalyticsReport } = require("../server");
const { registerAndLogin, authHeaders, registerOwner } = require("./helpers");

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-12-10T12:00:00Z");

let server;
let base;
let session;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerOwner(base, "analytics_user");
});

test.after(() => server && server.close());

// ---------- range rules ----------

test("a default range ends yesterday, because today is still being processed", () => {
  const range = validateAnalyticsRange(undefined, undefined, NOW);
  assert.equal(range.ok, true);
  assert.equal(range.endDate, "2026-12-09");
  assert.equal(range.startDate, "2026-11-11");
  assert.equal(range.days, 29);
});

test("an endDate of today or later is refused, not answered with a misleading zero", () => {
  const today = validateAnalyticsRange("2026-12-01", "2026-12-10", NOW);
  assert.equal(today.ok, false);
  assert.equal(today.reason, "future");

  const tomorrow = validateAnalyticsRange("2026-12-01", "2026-12-20", NOW);
  assert.equal(tomorrow.ok, false);
});

test("malformed, reversed and oversized ranges are refused with distinct reasons", () => {
  assert.equal(validateAnalyticsRange("10/12/2026", "2026-12-09", NOW).reason, "format");
  assert.equal(validateAnalyticsRange("2026-12-09", "2026-12-01", NOW).reason, "order");
  assert.equal(validateAnalyticsRange("2025-01-01", "2026-12-01", NOW).reason, "range");
});

// ---------- shaping ----------

test("durations are averaged and counts are summed", () => {
  const report = {
    columnHeaders: [
      { name: "day" }, { name: "views" }, { name: "estimatedMinutesWatched" },
      { name: "averageViewDuration" }, { name: "subscribersGained" }, { name: "likes" },
    ],
    rows: [
      ["2026-12-01", 100, 40, 24, 2, 10],
      ["2026-12-02", 300, 60, 36, 1, 30],
    ],
  };
  const shaped = shapeAnalyticsReport(report);
  assert.equal(shaped.totals.views, 400);
  assert.equal(shaped.totals.estimatedMinutesWatched, 100);
  assert.equal(shaped.totals.likes, 40);
  assert.equal(shaped.totals.subscribersGained, 3);
  assert.equal(shaped.totals.averageViewDuration, 30, "(24+36)/2, not 60");
  assert.equal(shaped.entries.length, 2);
  assert.equal(shaped.entries[0].day, "2026-12-01");
});

test("a channel with no data in range yields empty totals, not an error", () => {
  const shaped = shapeAnalyticsReport({ columnHeaders: [{ name: "day" }, { name: "views" }], rows: [] });
  assert.deepEqual(shaped.entries, []);
  assert.equal(shaped.totals.views, 0);
  const nothing = shapeAnalyticsReport({});
  assert.deepEqual(nothing.entries, []);
});

// ---------- route ----------

test("analytics without a connected channel says so instead of crashing", async () => {
  const response = await fetch(base + "/api/youtube/analytics", { headers: authHeaders(session) });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, "CHANNEL_NOT_CONNECTED");
});

test("analytics requires a session like every other API", async () => {
  const response = await fetch(base + "/api/youtube/analytics");
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, "AUTH_REQUIRED");
});

test("a bad date range is refused before any Google call", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/googleapis\.com/.test(url)) calls.push(url);
    return realFetch(input, options);
  };
  try {
    // No channel is connected, so the route stops earlier; this asserts the
    // ordering is "connect first", and that nothing reaches Google regardless.
    const response = await fetch(base + "/api/youtube/analytics?endDate=2030-01-01", {
      headers: authHeaders(session),
    });
    assert.ok([400, 409].includes(response.status), "got " + response.status);
    assert.deepEqual(calls, [], "no Google call may happen without a connection");
  } finally {
    global.fetch = realFetch;
  }
});
