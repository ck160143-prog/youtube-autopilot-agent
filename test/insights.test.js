"use strict";

// Analytics -> advice. The rule this file protects: no invented numbers.
// Advice may only come from rows the API returned, and an empty or tiny dataset
// must produce "not enough data", never a confident recommendation.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-insights-"));
process.env.APP_SESSION_SECRET = "insights-session-secret-0123456789abcdef";

const insights = require("../lib/insights");
const { app } = require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");

let server;
let base;
let session;

// Same encryption the server uses for the YouTube session cookie, so the route
// sees a genuinely "connected" channel without any real Google account.
function youtubeCookie(payload) {
  const key = crypto.createHash("sha256").update(process.env.APP_SESSION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return "baba_youtube_session=" + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

const SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly";

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "insights_user");
});

test.after(() => server && server.close());

// ---------- pure rules ----------

test("no data produces no advice at all", () => {
  const result = insights.buildInsights({ entries: [], totals: {} });
  assert.equal(result.enoughData, false);
  assert.deepEqual(result.suggestions, []);
  assert.deepEqual(result.observations, []);
  assert.match(result.verdict, /कोई अनुमान नहीं/);
});

test("fewer than 50 views is reported as too little data, not as a failure", () => {
  const result = insights.buildInsights({
    entries: [{ day: "2026-11-01", views: 3 }],
    totals: { views: 3, averageViewDuration: 20 },
  });
  assert.equal(result.enoughData, false);
  assert.ok(result.observations.some(o => /पर्याप्त व्यूज़ नहीं/.test(o)));
  assert.deepEqual(result.suggestions, [], "a handful of views must not trigger a confident plan");
});

test("a trend on a handful of views never becomes advice", () => {
  // Regression: the trend branch used to run before the views gate, so 21 views
  // spread over two "weeks" produced "build a series" — advice from noise.
  const entries = [];
  for (let i = 1; i <= 14; i += 1) {
    entries.push({ day: "2026-11-" + String(i).padStart(2, "0"), views: i <= 7 ? 1 : 2 });
  }
  const result = insights.buildInsights({
    entries,
    totals: { views: 21, estimatedMinutesWatched: 5, averageViewDuration: 30 },
  });
  assert.equal(result.enoughData, false);
  assert.deepEqual(result.suggestions, [], "thin data must not carry a trend recommendation");
  // The observation itself is still honest and visible.
  assert.ok(result.observations.some(o => /%/.test(o)), "the measured percentage may still be reported");
});

test("a real trend on enough views does produce advice", () => {
  const entries = [];
  for (let i = 1; i <= 14; i += 1) {
    entries.push({ day: "2026-11-" + String(i).padStart(2, "0"), views: i <= 7 ? 500 : 100 });
  }
  const result = insights.buildInsights({ entries, totals: { views: 4200, averageViewDuration: 45 } });
  assert.equal(result.enoughData, true);
  assert.ok(result.suggestions.length >= 1);
});

test("weekly trend is computed from real day rows", () => {
  const entries = [];
  for (let i = 1; i <= 14; i += 1) {
    entries.push({ day: "2026-11-" + String(i).padStart(2, "0"), views: i <= 7 ? 100 : 30 });
  }
  const weeks = insights.weeklyBuckets(entries);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].views, 700);
  assert.equal(weeks[1].views, 210);
});

test("declining views and short attention produce specific advice", () => {
  const entries = [];
  for (let i = 1; i <= 14; i += 1) {
    entries.push({ day: "2026-11-" + String(i).padStart(2, "0"), views: i <= 7 ? 500 : 100 });
  }
  const result = insights.buildInsights({
    entries,
    totals: { views: 4200, estimatedMinutesWatched: 900, averageViewDuration: 45, subscribersGained: 2, likes: 10 },
  });
  assert.equal(result.enoughData, true);
  assert.ok(result.observations.some(o => /%/.test(o)), "a trend percentage must be reported");
  assert.ok(result.suggestions.some(s => /गिर रहे/.test(s) || /पहले 15 सेकंड/.test(s)));
});

test("CTR and retention are declared unavailable instead of being invented", () => {
  const result = insights.buildInsights({ entries: [{ day: "2026-11-01", views: 100 }], totals: { views: 100 } });
  const names = result.notAvailable.map(n => n.metric);
  assert.ok(names.some(n => /CTR/.test(n)));
  assert.ok(names.some(n => /Retention/.test(n)));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /"ctr"\s*:/i, "no CTR value may be fabricated");
});

// ---------- route ----------

function stubGoogle(rows) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/youtubeanalytics\.googleapis\.com/.test(url)) {
      calls.push(url);
      return new Response(JSON.stringify({
        columnHeaders: [
          { name: "day" }, { name: "views" }, { name: "estimatedMinutesWatched" },
          { name: "averageViewDuration" }, { name: "subscribersGained" }, { name: "likes" },
        ],
        rows,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, options);
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test("insights are built from the rows Google returned", async () => {
  const rows = [];
  for (let i = 1; i <= 14; i += 1) rows.push(["2026-11-" + String(i).padStart(2, "0"), 200, 40, 50, 2, 8]);
  const stub = stubGoogle(rows);
  const cookie = youtubeCookie({
    access_token: "fake-token", expires_at: Date.now() + 3600000, scope: SCOPE,
    channel: { id: "UC123", title: "BABA AI" },
  });
  try {
    const response = await fetch(base + "/api/youtube/insights", {
      headers: Object.assign(authHeaders(session), { Cookie: session.cookie + "; " + cookie }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(stub.calls.length, 1, "exactly one reports.query call");
    assert.equal(body.totals.views, 2800, "14 days x 200 views");
    assert.equal(body.days, 14);
    assert.ok(body.observations.length > 0);
    assert.ok(body.metricsAvailable.includes("views"));
    assert.match(body.note, /CTR/);
    assert.equal("ctr" in body, false, "CTR must not appear as a value");
  } finally {
    stub.restore();
  }
});

test("an empty channel gives an honest 'no data' answer, not zeros dressed as advice", async () => {
  const stub = stubGoogle([]);
  const cookie = youtubeCookie({ access_token: "fake-token", expires_at: Date.now() + 3600000, scope: SCOPE });
  try {
    const response = await fetch(base + "/api/youtube/insights", {
      headers: Object.assign(authHeaders(session), { Cookie: session.cookie + "; " + cookie }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.enoughData, false);
    assert.deepEqual(body.suggestions, []);
    assert.match(body.verdict, /कोई अनुमान नहीं/);
  } finally {
    stub.restore();
  }
});

test("insights need a connected channel and the analytics scope", async () => {
  const noChannel = await fetch(base + "/api/youtube/insights", { headers: authHeaders(session) });
  assert.equal(noChannel.status, 409);
  assert.equal((await noChannel.json()).code, "CHANNEL_NOT_CONNECTED");

  const staleCookie = youtubeCookie({
    access_token: "fake-token", expires_at: Date.now() + 3600000,
    scope: "https://www.googleapis.com/auth/youtube.upload",
  });
  const stale = await fetch(base + "/api/youtube/insights", {
    headers: Object.assign(authHeaders(session), { Cookie: session.cookie + "; " + staleCookie }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "ANALYTICS_SCOPE_MISSING");
});

test("insights require a session like every other API", async () => {
  const response = await fetch(base + "/api/youtube/insights");
  assert.equal(response.status, 401);
});
