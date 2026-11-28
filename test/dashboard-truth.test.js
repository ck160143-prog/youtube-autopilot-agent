"use strict";

// Phase 4 dashboard truth tests: the Character Library must reload after a
// fresh sign-in, both YouTube panels must agree, and the capability/progress
// panels must not share a label. Skipped, never faked, when jsdom is missing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-truth-"));

const REPO = path.join(__dirname, "..");
// Owner creation needs the bootstrap token; importing the helper installs it.
const { OWNER_BOOTSTRAP_TOKEN } = require("./helpers");
const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");

const { app } = require("../server");

let JSDOM;
let VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (_) { JSDOM = null; }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, ms) {
  const limit = ms || 8000;
  const start = Date.now();
  while (Date.now() - start < limit) {
    try { if (fn()) return true; } catch (_) { /* keep polling */ }
    await sleep(100);
  }
  return false;
}

async function openPage(base) {
  const virtualConsole = new VirtualConsole();
  const pageErrors = [];
  virtualConsole.on("jsdomError", error => pageErrors.push(String(error && error.message || error)));
  let cookie = "";
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
    },
  });
  return { window: dom.window, pageErrors, close: () => dom.window.close() };
}

async function signIn(window, username, password, mode) {
  window.document.getElementById("authUsername").value = username;
  window.document.getElementById("authPassword").value = password;
  if (mode === "register") {
    // The owner door asks for the bootstrap token; the page shows the field only
    // while that door is the open one.
    const tokenField = window.document.getElementById("authBootstrapToken");
    if (tokenField && !tokenField.hidden) tokenField.value = process.env.OWNER_BOOTSTRAP_TOKEN;
  }
  const button = window.document.getElementById(mode === "register" ? "authRegisterBtn" : "authLoginBtn");
  button.click();
  const ok = await waitFor(() => window.document.getElementById("authGate").hidden === true, 8000);
  assert.equal(ok, true, "sign-in did not complete (" + mode + ")");
}

test("static: capability and progress panels carry different, explicit labels", () => {
  assert.match(html, /सिस्टम क्षमता/, "the capability panel must say it is a capability, not project progress");
  assert.match(html, /इस प्रोजेक्ट की प्रगति/, "the checkpoint panel must say it is this project's progress");
  assert.doesNotMatch(html, /वास्तविक स्थिति — /, "the ambiguous old capability label must be gone");
});

test("static: the lip-sync note follows the installed engine instead of a fixed claim", () => {
  // The old static note said lip-sync was always BLOCKED, which became false the
  // moment the WASM engine was installed. The copy is now driven by
  // /api/capabilities, and the behavioural coverage lives in
  // test/ui-lipsync-status.test.js.
  assert.match(html, /caps\.lipSync && caps\.lipSync\.available/,
    "the note must read the real capability, not a constant");
  assert.match(html, /P2\.lipSyncAvailable = Boolean/, "the capability must be remembered for the render panel");
  assert.doesNotMatch(html, /Character animation और lip-sync: ⛔ BLOCKED — यह बग नहीं है/,
    "the stale unconditional BLOCKED claim must be gone");
  assert.match(html, /3D character animation अभी उपलब्ध नहीं है/,
    "copy must still be honest about 3D, which really is unavailable");
});

test("static: duration copy matches the real scene plan and warns above 1 minute", () => {
  assert.match(html, /<option value="1" selected>1 मिनट<\/option>/, "1 minute must stay the default");
  assert.match(html, /10 दृश्य/, "copy must match the real 10-scene plan for 1 minute");
  assert.match(html, /id="durationHint"/, "a dedicated duration warning element is required");
  assert.doesNotMatch(html, /अधिकतम 3 स्थिर दृश्य/, "the stale 3-scene copy must be gone");
});

test("static: topic/style mismatch gets a hint element and a checker", () => {
  assert.match(html, /id="topicStyleHint"/, "a topic/style hint element is required");
  assert.match(html, /function checkTopicStyleMatch/, "the mismatch checker must exist");
  assert.match(html, /onchange="checkTopicStyleMatch\(\)"/, "style changes must re-check the match");
});

test("static: both YouTube panels render through one shared function", () => {
  assert.match(html, /async function refreshConnectionStatus/, "one shared connection-status function is required");
  assert.match(html, /id="setupYouTubeStatus"/, "the setup panel needs its own YouTube line");
  assert.match(html, /आखिरी जाँच/, "both panels must show when the status was last checked");
});

test("browser: characters reload after sign-out and sign-in without a page refresh", { timeout: 90000 }, async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await openPage(base);
  const { window } = page;

  try {
    await sleep(600);
    assert.equal(window.document.getElementById("authGate").hidden, false, "starts logged out");

    await signIn(window, "truth_user", "truth-pass-123", "register");
    await waitFor(() => window.document.getElementById("setupCard").hidden === false, 8000);

    // The real user flow: fill the form, click "किरदार सेव करें".
    const document = window.document;
    document.getElementById("p2CharName").value = "Toto";
    document.getElementById("p2CharGender").value = "male";
    document.getElementById("p2CharLook").value = "cute orange baby tiger, black stripes";
    document.getElementById("p2CharOutfit").value = "blue T-shirt";
    document.getElementById("p2CharColors").value = "orange";
    document.querySelector('button[onclick="p2.saveCharacter()"]').click();

    assert.ok(
      await waitFor(() => /Toto/.test(document.getElementById("p2CharacterList").textContent), 8000),
      "Toto must appear in the Character Library right after saving: " +
      JSON.stringify(document.getElementById("p2CharacterList").textContent)
    );

    await window.babaAuth.logout();
    await waitFor(() => document.getElementById("authGate").hidden === false, 8000);

    // After sign-out the previous account's characters must not stay on screen.
    assert.ok(
      await waitFor(() => !/Toto/.test(document.getElementById("p2CharacterList").textContent), 5000),
      "sign-out must clear the Character Library, but Toto was still visible: " +
      JSON.stringify(document.getElementById("p2CharacterList").textContent)
    );

    // The whole bug: this sign-in happens without reloading the document.
    await signIn(window, "truth_user", "truth-pass-123", "login");

    const reloaded = await waitFor(
      () => /Toto/.test(document.getElementById("p2CharacterList").textContent), 10000
    );
    assert.equal(
      reloaded, true,
      "Character Library stayed empty after sign-in: P2.loadCharacters() never ran again " +
      "(notify() clears its listeners). Actual text: " +
      JSON.stringify(document.getElementById("p2CharacterList").textContent)
    );

    const realErrors = page.pageErrors.filter(message => !/Could not parse CSS/.test(message));
    assert.deepEqual(realErrors, [], "no uncaught page errors");
  } finally {
    page.close();
    server.close();
  }
});

test("browser: both YouTube panels agree and are stamped with the last check", { timeout: 90000 }, async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await openPage(base);
  const { window } = page;

  try {
    await sleep(500);
    assert.equal(typeof window.refreshConnectionStatus, "function", "shared status function must be global");

    await window.refreshConnectionStatus();
    await sleep(400);

    const top = window.document.getElementById("channelStatus").textContent;
    const setup = window.document.getElementById("setupYouTubeStatus").textContent;
    assert.match(top, /सेट नहीं/, "with no OAuth env the top panel must say not configured: " + top);
    assert.match(setup, /सेट नहीं/, "the setup panel must say the same thing: " + setup);
    assert.match(top, /आखिरी जाँच/, "the top panel must be timestamped");
    assert.match(setup, /आखिरी जाँच/, "the setup panel must be timestamped");

    const realErrors = page.pageErrors.filter(message => !/Could not parse CSS/.test(message));
    assert.deepEqual(realErrors, [], "no uncaught page errors");
  } finally {
    page.close();
    server.close();
  }
});

test("browser: topic/style mismatch warns without blocking", { timeout: 90000 }, async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await openPage(base);
  const { window } = page;
  const document = window.document;

  try {
    await sleep(400);

    const topic = document.getElementById("topic");
    const style = document.getElementById("visualStyle");
    const hint = document.getElementById("topicStyleHint");

    topic.value = "Taj Mahal ke Rahasya";
    topic.dispatchEvent(new window.Event("input", { bubbles: true }));
    style.value = "3d-cartoon";
    style.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(150);

    assert.equal(hint.style.display, "block", "the mismatch hint must be visible");
    assert.match(hint.textContent, /सुझाव/, "the hint must be a suggestion, not a block");
    assert.match(hint.textContent, /सिनेमैटिक/, "the hint must name the better style");

    style.value = "cinematic";
    style.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(150);
    assert.notEqual(hint.style.display, "block", "no warning once the style matches the topic");

    const realErrors = page.pageErrors.filter(message => !/Could not parse CSS/.test(message));
    assert.deepEqual(realErrors, [], "no uncaught page errors");
  } finally {
    page.close();
    server.close();
  }
});

test("browser: the duration selector warns above the safe 1-minute default", { timeout: 90000 }, async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await openPage(base);
  const { window } = page;
  const document = window.document;

  try {
    await sleep(400);
    assert.equal(document.getElementById("duration").value, "1", "1 minute stays the default");

    const hint = document.getElementById("durationHint");
    const selector = document.getElementById("duration");
    selector.value = "5";
    selector.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(150);

    assert.match(hint.textContent, /5 मिनट/, "the warning must name the chosen length");
    assert.match(hint.textContent, /असफल हो सकता/, "the warning must name the real risk");

    selector.value = "1";
    selector.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(150);
    assert.doesNotMatch(hint.textContent, /असफल हो सकता/, "the safe default must not be flagged");

    const realErrors = page.pageErrors.filter(message => !/Could not parse CSS/.test(message));
    assert.deepEqual(realErrors, [], "no uncaught page errors");
  } finally {
    page.close();
    server.close();
  }
});

test("browser: every inline onclick handler resolves to a real function", { timeout: 90000 }, async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await openPage(base);
  const { window } = page;

  try {
    await sleep(500);
    const handlers = Array.from(html.matchAll(/onclick="([^"]*)"/g)).map(match => match[1]);
    const missing = [];
    for (const handler of handlers) {
      if (/^document\./.test(handler) || /^window\./.test(handler)) continue;
      const name = handler.split("(")[0].trim();
      let target = window;
      let found = true;
      for (const part of name.split(".")) {
        if (target && typeof target[part] !== "undefined") target = target[part];
        else { found = false; break; }
      }
      if (!found || typeof target !== "function") missing.push(name);
    }
    assert.deepEqual(missing, [], "these onclick handlers are not defined: " + missing.join(", "));
  } finally {
    page.close();
    server.close();
  }
});
