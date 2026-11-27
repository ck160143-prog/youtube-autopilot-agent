"use strict";

// The research panel must show what was actually stored, and it must be loud
// about an unsourced claim. A brief with no trusted links may never look verified.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-ui-res-"));

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (_) {
  JSDOM = null;
  VirtualConsole = null;
}

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function boot(routes) {
  const virtualConsole = new VirtualConsole();
  return new JSDOM(html, {
    url: "http://127.0.0.1/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (url, options) => {
        const target = String(url);
        for (const key of Object.keys(routes)) {
          if (target.indexOf(key) !== -1) {
            const route = routes[key];
            const body = typeof route === "function" ? route(options || {}) : route;
            return Promise.resolve(new Response(JSON.stringify(body.body || body), {
              status: body.status || 200,
              headers: { "Content-Type": "application/json" },
            }));
          }
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

const BRIEF = {
  topic: "ताज महल के रहस्य",
  summary: "ताज महल आगरा में यमुना किनारे है।",
  language: "हिंदी",
  claims: [
    { fact: "इसे शाहजहाँ ने बनवाया", sourceUrls: ["https://en.wikipedia.org/wiki/Taj_Mahal"] },
    { fact: "इसमें 28 प्रकार के रत्न लगे हैं", sourceUrls: [] },
  ],
  sources: [{ url: "https://en.wikipedia.org/wiki/Taj_Mahal", title: "Taj Mahal", publisher: "en.wikipedia.org" }],
  sourcedClaims: 1,
  notice: "स्रोत केवल भरोसेमंद संदर्भ साइटों से रखे गए हैं।",
};

test("the research panel renders claims, links and the unsourced warning", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot({ "/research": { research: BRIEF } });

  window.renderResearchBrief(BRIEF);
  const panel = window.document.getElementById("researchPanel");

  const text = panel.textContent;
  assert.match(text, /शाहजहाँ/, "the stored claim must be visible");
  assert.match(text, /1\/2/, "sourced vs total claims must be shown honestly");
  const link = panel.querySelector('a[href="https://en.wikipedia.org/wiki/Taj_Mahal"]');
  assert.ok(link, "a sourced claim must link to its source");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.match(text, /बिना स्रोत/, "an unsourced claim must be labelled, not hidden");
});

test("running research on a project shows the saved brief", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  let posted = null;
  const window = boot({
    // Most specific route first: keys are matched in insertion order.
    "/research": (options) => {
      if (String(options.method || "GET").toUpperCase() === "POST") {
        posted = true;
        return { status: 201, body: { research: BRIEF } };
      }
      return { status: 404, body: { error: "अभी research तैयार नहीं है।" } };
    },
    "/api/projects": { project: { id: "p1", topic: "ताज महल" } },
  });

  await window.p2.init();
  window.p2.currentProjectId = function () { return "p1"; };

  await window.runResearch();

  assert.equal(posted, true, "the POST must hit the project research route");
  assert.match(window.document.getElementById("researchPanel").textContent, /शाहजहाँ/);
  assert.match(window.document.getElementById("researchStatus").textContent, /Research तैयार/);
});

test("research without a project, or without a key, says so instead of pretending", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot({ "/research": { status: 503, body: { blocked: true, error: "GEMINI_API_KEY सेट नहीं है।" } } });
  await window.p2.init();

  window.p2.currentProjectId = function () { return null; };
  await window.runResearch();
  assert.match(window.document.getElementById("researchStatus").textContent, /पहले/);

  window.p2.currentProjectId = function () { return "p1"; };
  await window.runResearch();
  const status = window.document.getElementById("researchStatus").textContent;
  assert.match(status, /BLOCKED/);
  assert.match(status, /GEMINI_API_KEY/);
  assert.equal(window.document.getElementById("researchPanel").textContent, "", "a failed run must not paint a brief");
});
