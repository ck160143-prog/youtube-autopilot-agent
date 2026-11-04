"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createGrowthRouter } = require("../growth");

async function withServer(run, options = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/growth", createGrowthRouter({
    getOwner: options.getOwner || (() => "channel-123"),
    getStore: options.getStore || (async () => ({ pool: { query: async () => ({ rows: [] }) } })),
    getAccessToken: options.getAccessToken || (async () => "access-token"),
    aiClientFactory: options.aiClientFactory,
    fetchImpl: options.fetchImpl || (async () => ({ ok: true, json: async () => ({}) }))
  }));
  const server = app.listen(0, "127.0.0.1");
  try { await run("http://127.0.0.1:" + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("growth overview rejects requests without a verified channel", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/growth/overview");
    assert.equal(response.status, 401);
  }, { getOwner: () => null });
});

test("growth overview reads authenticated channel and Analytics API values and persists a snapshot", async () => {
  let apiCalls = 0, dbWrites = 0;
  await withServer(async base => {
    const response = await fetch(base + "/api/growth/overview");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.channel.id, "channel-123");
    assert.equal(body.channel.subscribers, 321);
    assert.equal(body.last28Days.views, 90);
    assert.equal(body.last28Days.minutes, 180);
    assert.equal(body.last28Days.gained, 7);
    assert.equal(dbWrites, 1);
  }, {
    fetchImpl: async url => {
      apiCalls++;
      if (String(url).includes("/youtube/v3/channels")) return { ok: true, json: async () => ({ items: [{ id: "channel-123", snippet: { title: "GajabGuru" }, statistics: { subscriberCount: "321", viewCount: "9000", videoCount: "40" } }] }) };
      return { ok: true, json: async () => ({ rows: [["2026-11-03", 90, 180, 7]] }) };
    },
    getStore: async () => ({ pool: { query: async (sql,args) => {
      if (String(sql).includes("INSERT INTO baba_channel_metrics")) { dbWrites++; assert.equal(args[0], "channel-123"); assert.equal(args[1], 321); }
      return { rows: [] };
    } } })
  });
  assert.equal(apiCalls, 2);
});

test("trend endpoint validates query length before calling YouTube", async () => {
  let calls = 0;
  await withServer(async base => {
    const response = await fetch(base + "/api/growth/trending?q=x");
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  }, { fetchImpl: async () => { calls++; return { ok: true, json: async () => ({}) }; } });
});

test("trend endpoint returns real YouTube video IDs and view counts", async () => {
  let calls = 0;
  await withServer(async base => {
    const response = await fetch(base + "/api/growth/trending?q=Hindi%20AI");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.videos.length, 1);
    assert.equal(body.videos[0].id, "video-1");
    assert.equal(body.videos[0].views, 1234);
  }, { fetchImpl: async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ items: [{ id: { videoId: "video-1" } }] }) };
    return { ok: true, json: async () => ({ items: [{ id: "video-1", snippet: { title: "Hindi AI", channelTitle: "Channel", publishedAt: "2026-11-03T00:00:00Z" }, statistics: { viewCount: "1234" } }] }) };
  } });
});

test("promotion endpoint validates type and persists only for the verified channel", async () => {
  let queryArgs;
  await withServer(async base => {
    const bad = await fetch(base + "/api/growth/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Offer", promotionType: "other" }) });
    assert.equal(bad.status, 400);
    const good = await fetch(base + "/api/growth/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Brand deal", promotionType: "sponsorship", amount: 2500, currency: "INR", url: "https://brand.example" }) });
    assert.equal(good.status, 201);
    assert.equal(queryArgs[0], "channel-123");
    assert.equal(queryArgs[1], "Brand deal");
    assert.equal(queryArgs[2], "sponsorship");
  }, { getStore: async () => ({ pool: { query: async (_sql, args) => { queryArgs = args; return { rows: [{ id: "promo-1", name: args[1] }] }; } } }) });
});

test("monetization inputs reject negative values and clearly identify manual data", async () => {
  await withServer(async base => {
    const bad = await fetch(base + "/api/growth/monetization", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicWatchHours: -1, shortsViews90d: 0 }) });
    assert.equal(bad.status, 400);
    const read = await fetch(base + "/api/growth/monetization");
    const body = await read.json();
    assert.equal(body.basis.includes("user-entered"), true);
  });
});

test("niche research returns generated estimates with an explicit non-guarantee disclaimer", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    await withServer(async base => {
      const response = await fetch(base + "/api/growth/niches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interest: "technology" }) });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.niches[0].niche, "Hindi AI Tools");
      assert.match(body.disclaimer, /estimates only/i);
    }, {
      aiClientFactory: () => ({ models: { generateContent: async () => ({ text: JSON.stringify({ niches: [{ niche: "Hindi AI Tools", competition: "medium", estimatedPotentialScore: 72, monetizationPaths: ["affiliate"] }] }) }) } })
    });
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
