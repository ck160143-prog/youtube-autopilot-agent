"use strict";

// Insights UI. The hard rule: when the data is thin, the panel shows the honest
// verdict and no suggestions at all. Missing metrics are listed as missing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-ui-ins-"));

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
      window.fetch = url => {
        if (String(url).indexOf("/api/youtube/insights") !== -1) {
          return Promise.resolve(new Response(JSON.stringify(payload), {
            status: payload.__status || 200, headers: { "Content-Type": "application/json" },
          }));
        }
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      };
    },
  }).window;
}

const FULL = {
  enoughData: true,
  days: 14,
  totals: { views: 2800, minutes: 560, avgDuration: 48, subs: 12, likes: 90 },
  observations: ["पिछले हफ़्ते 1400 व्यूज़ थे, इससे पिछले हफ़्ते 1400 थे (0% बदलाव)।"],
  suggestions: ["पहले 15 सेकंड में मुख्य सवाल रखें, ध्यान बनाए रखने के लिए।"],
  notAvailable: [
    { metric: "CTR (impressions click-through)", why: "channel-owner reports में impressions नहीं मिलते।" },
    { metric: "Retention curve", why: "audienceRetention अलग report type है।" },
  ],
  verdict: "डेटा पर्याप्त है; सुझाव सिर्फ इसी अवधि के असली आंकड़ों से बने हैं।",
};

const THIN = {
  enoughData: false,
  days: 1,
  totals: { views: 3, minutes: 1, avgDuration: 20, subs: 0, likes: 0 },
  observations: ["पर्याप्त व्यूज़ नहीं (3 < 50)।"],
  suggestions: [],
  notAvailable: FULL.notAvailable,
  verdict: "डेटा कम है, इसलिए कोई अनुमान नहीं लगाया गया।",
};

test("the insights panel shows real totals and the suggestions", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot(FULL);
  await window.p2.init();
  await window.loadInsights();

  const panel = window.document.getElementById("insightsPanel");
  const text = panel.textContent;
  assert.match(text, /2800/, "the real view count must be displayed");
  assert.match(text, /560/, "watch time must be displayed");
  assert.match(text, /पहले 15 सेकंड/, "the suggestion must be rendered");
  assert.match(window.document.getElementById("insightsStatus").textContent, /1 सुझाव/);
});

test("CTR and retention are shown as unavailable, never as numbers", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot(FULL);
  await window.p2.init();
  await window.loadInsights();

  const missing = window.document.querySelector(".insights-missing");
  assert.ok(missing, "missing metrics must have their own section");
  assert.match(missing.textContent, /CTR/);
  assert.match(missing.textContent, /Retention/);
  // No fabricated percentage anywhere in the panel.
  assert.doesNotMatch(missing.textContent, /\d+\s*%/, "a missing metric must not carry a made-up value");
});

test("thin data shows no suggestions, only the honest 'no estimate' verdict", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot(THIN);
  await window.p2.init();
  await window.loadInsights();

  const panel = window.document.getElementById("insightsPanel");
  assert.match(panel.textContent, /कोई अनुमान नहीं/);
  assert.doesNotMatch(panel.textContent, /आगे क्या सुधारें/, "there must be no suggestion section");
  assert.match(window.document.getElementById("insightsStatus").textContent, /डेटा कम है/);
});

test("an API error is reported as an error, not as advice", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot({ __status: 409, error: "YouTube चैनल जुड़ा नहीं है।" });
  await window.p2.init();
  await window.loadInsights();

  assert.match(window.document.getElementById("insightsStatus").textContent, /चैनल जुड़ा नहीं/);
  assert.equal(window.document.getElementById("insightsPanel").textContent, "");
});
