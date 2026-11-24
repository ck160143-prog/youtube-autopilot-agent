"use strict";

// Android-friendly dashboard: responsive rules, touch-sized controls, a sticky
// shortcut bar, and a setup panel that reflects the real configuration.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-mobile-"));
process.env.APP_REGISTRATION_KEY = "team-key";

const REPO = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");

const { app } = require("../server");
const { registerAndLogin } = require("./helpers");

let JSDOM;
let VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (_) { JSDOM = null; }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("viewport allows a phone layout with safe-area insets", () => {
  const tag = html.match(/<meta name="viewport"[^>]*>/i);
  assert.ok(tag, "viewport meta is required");
  assert.match(tag[0], /width=device-width/);
  assert.match(tag[0], /initial-scale=1/);
  assert.match(tag[0], /viewport-fit=cover/);
});

test("responsive breakpoints exist for phones and small phones", () => {
  assert.match(html, /@media \(max-width:768px\)/);
  assert.match(html, /@media \(max-width:420px\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});

test("touch targets and input sizes are phone-safe", () => {
  assert.match(html, /--tap-min:46px/);
  assert.match(html, /input,select,textarea\{font-size:16px\}/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
});

test("the mobile shortcut bar is present and wired", () => {
  assert.match(html, /id="mobileBar"/);
  assert.match(html, /data-mobile="topic"/);
  assert.match(html, /data-mobile="projects"/);
  assert.match(html, /data-mobile="characters"/);
  assert.match(html, /scrollIntoView\(/);
});

test("the setup panel and rig upload panel exist in the dashboard", () => {
  assert.match(html, /id="setupCard"/);
  assert.match(html, /id="setupVerifyBtn"/);
  assert.match(html, /id="p2RigPanel"/);
  assert.match(html, /data-rig-shape/);
});

test("the dashboard renders the setup audit from the real API", { timeout: 60000 }, async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  let cookie = "";
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", error => errors.push(String(error && error.message || error)));

  const dom = new JSDOM(html, {
    url: base + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, options) => {
        const headers = Object.assign({}, (options && options.headers) || {});
        if (cookie) headers["Cookie"] = cookie;
        return fetch(new URL(input, base).toString(), Object.assign({}, options, { headers }))
          .then(response => {
            const raw = typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()[0]
              : response.headers.get("set-cookie");
            if (raw) cookie = String(raw).split(";")[0];
            return response;
          });
      };
      window.HTMLElement.prototype.scrollIntoView = function () { this.__scrolled = true; };
    },
  });
  const { window } = dom;
  try {
    await sleep(500);
    // Sign in so /api/setup is reachable.
    window.document.getElementById("authUsername").value = "mobile_user";
    window.document.getElementById("authPassword").value = "mobile-pass-123";
    window.document.getElementById("authRegisterBtn").click();
    await sleep(1500);

    assert.equal(window.document.getElementById("setupCard").hidden, false, "setup card must be visible");
    const checks = window.document.getElementById("setupChecks").textContent;
    assert.match(checks, /Gemini API key/);
    assert.match(checks, /FFmpeg/);
    assert.match(checks, /⛔|⚠️|✅/);
    // A missing key must surface the step-by-step guide.
    assert.match(window.document.getElementById("setupGuide").textContent, /GEMINI_API_KEY/);

    // Rig inputs are built for every Rhubarb mouth shape.
    const inputs = window.document.querySelectorAll("[data-rig-shape]");
    assert.equal(inputs.length, 9);

    // Mobile shortcut scrolls to the requested card.
    const button = window.document.querySelector('[data-mobile="characters"]');
    button.click();
    await sleep(100);
    assert.equal(window.document.getElementById("p2CharactersCard").__scrolled, true);
  } finally {
    window.close();
    server.close();
  }
});

test("one obvious start button exists on desktop and in the mobile bar", () => {
  assert.match(html, /id="heroStartBtn"/);
  assert.match(html, /id="mobileStartBtn"/);
  // Both call the same entry point, so there is exactly one way to start.
  assert.match(html, /id="heroStartBtn"[^>]*onclick="startBabaVideo\(\)"/);
  assert.match(html, /id="mobileStartBtn"[^>]*onclick="startBabaVideo\(\)"/);
  assert.match(html, /window\.startBabaVideo = function/);
  // The mobile CTA is a full-width 50px target, above the safe area.
  assert.match(html, /#mobileStartBtn\{width:100%;min-height:50px/);
  assert.match(html, /body\{padding-bottom:calc\(150px \+ env\(safe-area-inset-bottom\)\)\}/);
});

test("the one-click automation never uploads to YouTube by itself", () => {
  const start = html.indexOf("async function runFullAutomation()");
  assert.ok(start > 0, "runFullAutomation must exist");
  const end = html.indexOf("\n}\n", start);
  const body = html.slice(start, end);
  assert.equal(/uploadRenderedVideo|uploadVideoToYouTube/.test(body), false,
    "automation must stop at the MP4; upload is a separate, confirmed action");
  assert.match(body, /YouTube upload आपकी अनुमति के बिना नहीं होगा/);
  // The description next to the button must not promise an automatic upload.
  assert.equal(/MP4 तैयार होने पर YouTube पर Private upload करेगा/.test(html), false);
  assert.match(html, /कुछ भी अपने-आप अपलोड नहीं होगा/);
});
