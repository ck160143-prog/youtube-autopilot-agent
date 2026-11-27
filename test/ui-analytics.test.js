"use strict";

// The analytics panel must render real numbers from the API, and must say
// "no data" honestly instead of silently showing zeros as if they were views.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-ui-an-"));

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (_) {
  JSDOM = null;
}

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function boot(payload) {
  const virtualConsole = new VirtualConsole();
  return new JSDOM(html, {
    url: "http://127.0.0.1/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // Only /api/youtube/analytics answers; every boot-time call gets empty JSON.
      window.fetch = url => {
        const target = String(url);
        if (target.indexOf("/api/youtube/analytics") !== -1) {
          return Promise.resolve(new Response(JSON.stringify(payload), {
            status: payload.__status || 200, headers: { "Content-Type": "application/json" },
          }));
        }
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      };
    },
  }).window;
}

async function waitFor(fn, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

test("the analytics panel shows the numbers the API returned", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot({
    startDate: "2026-11-01", endDate: "2026-11-29", days: 29,
    entries: [{ day: "2026-11-01", views: 200 }],
    totals: { views: 200, estimatedMinutesWatched: 78, averageViewDuration: 24, subscribersGained: 4, likes: 18 },
    note: "YouTube Analytics में 24–72 घंटे की देरी होती है।",
  });
  try {
    window.loadAnalytics();
    const table = await waitFor(() => window.document.querySelector(".analytics-table"));
    assert.ok(table, "a table must be rendered");
    const text = table.textContent;
    assert.match(text, /200/, "views must appear");
    assert.match(text, /78/, "watch minutes must appear");
    assert.match(text, /24/, "average view duration must appear");
    assert.match(text, /18/, "likes must appear");
    assert.match(window.document.getElementById("analyticsStatus").textContent, /✅/);
  } finally {
    window.close();
  }
});

test("an empty report says there is no data instead of pretending zeros are views", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot({
    startDate: "2026-11-01", endDate: "2026-11-29", days: 29,
    entries: [], totals: { views: 0 }, note: "देरी 24–72 घंटे।",
  });
  try {
    window.loadAnalytics();
    const status = await waitFor(() => {
      const text = window.document.getElementById("analyticsStatus").textContent;
      return text && text.indexOf("…") === -1 ? text : null;
    });
    assert.ok(status, "a final status line must appear");
    assert.match(status, /कोई डेटा नहीं/);
    assert.match(status, /त्रुटि नहीं/, "it must say this is not an error");
  } finally {
    window.close();
  }
});

test("a server error is shown as an error, not as empty analytics", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot({ __status: 409, error: "इस connection में Analytics की अनुमति नहीं है।" });
  try {
    window.loadAnalytics();
    const status = await waitFor(() => {
      const text = window.document.getElementById("analyticsStatus").textContent;
      return text && text.indexOf("…") === -1 ? text : null;
    });
    assert.match(status, /❌/);
    assert.match(status, /अनुमति/);
    assert.equal(window.document.querySelector(".analytics-table"), null, "no table on error");
  } finally {
    window.close();
  }
});
