"use strict";

// POST /api/youtube/disconnect existed with no UI at all, so a user could not
// end their own YouTube connection from the dashboard. These tests pin the
// behaviour against the real markup: the control is offered only when a channel
// is connected, it asks before acting, and it reports failures instead of
// pretending to have worked.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch (_) { JSDOM = null; }
const run = JSDOM ? test : test.skip;

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function jsonResponse(body, ok = true, status = 200) {
  const text = JSON.stringify(body);
  return { ok, status, text: async () => text, json: async () => body };
}

async function boot(routes, options = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/",
    beforeParse(window) {
      window.fetch = async (url, opts) => {
        calls.push(String(url) + " " + String((opts && opts.method) || "GET"));
        const key = Object.keys(routes).find(match => String(url).includes(match));
        return key ? routes[key]() : jsonResponse({});
      };
      window.confirm = () => (options.confirm === undefined ? true : options.confirm);
      if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  await dom.window.p2.init();
  return { dom, w: dom.window, calls };
}

run("disconnect is disabled when no channel is connected", async () => {
  const { w, dom } = await boot({
    "/api/youtube/status": () => jsonResponse({ configured: true, connected: false }),
  });
  await w.refreshConnectionStatus();
  const btn = w.document.getElementById("youtubeDisconnectBtn");
  assert.ok(btn, "a disconnect control must exist");
  assert.equal(btn.disabled, true, "nothing is connected, so disconnect must be disabled");
  dom.window.close();
});

run("disconnect is enabled for a connected channel and calls the API once confirmed", async () => {
  let connected = true;
  const { w, dom, calls } = await boot({
    "/api/youtube/status": () => jsonResponse({
      configured: true, connected,
      channel: connected ? { id: "UC123", title: "टेस्ट चैनल" } : null,
    }),
    "/api/youtube/disconnect": () => { connected = false; return jsonResponse({ success: true }); },
  });
  await w.refreshConnectionStatus();
  const btn = w.document.getElementById("youtubeDisconnectBtn");
  assert.equal(btn.disabled, false, "a connected channel must be disconnectable");

  await w.disconnectYouTube();
  assert.ok(calls.some(c => /\/api\/youtube\/disconnect POST/.test(c)), "disconnect must hit the API: " + calls.join(" ; "));
  const status = w.document.getElementById("channelStatus").textContent;
  assert.ok(!/✅/.test(status), "the panel must stop showing a connected channel: " + status);
  assert.equal(w.document.getElementById("youtubeDisconnectBtn").disabled, true,
    "after disconnecting, the control must switch itself off");
  dom.window.close();
});

run("a cancelled confirmation makes no request", async () => {
  const { w, dom, calls } = await boot({
    "/api/youtube/status": () => jsonResponse({ configured: true, connected: true, channel: { id: "UC1", title: "x" } }),
  }, { confirm: false });
  await w.refreshConnectionStatus();
  await w.disconnectYouTube();
  assert.equal(calls.filter(c => /disconnect/.test(c)).length, 0, "no request may be sent: " + calls.join(" ; "));
  dom.window.close();
});

run("a failed disconnect says so and leaves the control usable", async () => {
  const { w, dom } = await boot({
    "/api/youtube/status": () => jsonResponse({ configured: true, connected: true, channel: { id: "UC1", title: "x" } }),
    "/api/youtube/disconnect": () => jsonResponse({ error: "सर्वर त्रुटि" }, false, 500),
  });
  await w.refreshConnectionStatus();
  await w.disconnectYouTube();
  const status = w.document.getElementById("channelStatus").textContent;
  assert.match(status, /Disconnect विफल/, "a failure must be reported, not swallowed: " + status);
  assert.match(status, /सर्वर त्रुटि/, "the server's reason must be surfaced");
  assert.equal(w.document.getElementById("youtubeDisconnectBtn").disabled, false, "the user must be able to retry");
  dom.window.close();
});
