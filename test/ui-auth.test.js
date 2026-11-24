"use strict";

// Browser-level test of the sign-in gate: the dashboard boots logged out, the
// first registration becomes the owner and hides the gate, page-level fetches
// carry the session cookie + CSRF token, and signing out closes the API again.
// Skipped, never faked, when jsdom is not installed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-ui-"));
process.env.APP_REGISTRATION_KEY = "team-key";

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (_) {
  JSDOM = null;
}

const { app } = require("../server");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function probe(window, script) {
  window.eval("window.__probe = null;");
  window.eval(script);
  return (async () => {
    for (let i = 0; i < 40; i += 1) {
      if (window.__probe) return window.__probe;
      await sleep(100);
    }
    return null;
  })();
}

const POST_PROJECT = [
  "(function(){",
  "  fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },",
  "    body: JSON.stringify({ topic: 'ब्राउज़र से बना प्रोजेक्ट' }) })",
  "    .then(function (r) { return r.text().then(function (t) { window.__probe = { status: r.status, body: t }; }); })",
  "    .catch(function (e) { window.__probe = { error: String(e && e.message || e) }; });",
  "})();",
].join("\n");

const GET_PROJECTS = [
  "(function(){ fetch('/api/projects')",
  "  .then(function (r) { window.__probe = { status: r.status }; })",
  "  .catch(function (e) { window.__probe = { error: String(e && e.message || e) }; }); })();",
].join("\n");

test("the dashboard gates the app behind sign-in and wires CSRF", { timeout: 60000 }, async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

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
      // jsdom has no fetch: give it Node's, with a cookie jar standing in for
      // the browser's cookie store.
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
  const { window } = dom;
  try {
    await sleep(700);
    assert.equal(window.document.getElementById("authGate").hidden, false, "gate must be visible when logged out");
    assert.equal(window.document.getElementById("authBar").hidden, true, "user bar must be hidden when logged out");

    window.document.getElementById("authUsername").value = "browser_user";
    window.document.getElementById("authPassword").value = "browser-pass-123";
    window.document.getElementById("authRegisterBtn").click();
    await sleep(1200);

    assert.equal(window.document.getElementById("authGate").hidden, true, "gate must hide after signing in");
    assert.equal(window.document.getElementById("authBar").hidden, false, "user bar must show after signing in");
    assert.match(window.babaAuth.username(), /browser_user/);
    assert.ok(window.babaAuth.csrfToken().length > 15, "CSRF token must be stored in page memory");

    const created = await probe(window, POST_PROJECT);
    assert.ok(created, "the in-page POST never finished");
    assert.equal(created.status, 201, "project creation must succeed with session + CSRF: " + created.body);

    await window.babaAuth.logout();
    await sleep(700);
    assert.equal(window.document.getElementById("authGate").hidden, false, "gate must return after sign out");

    const closed = await probe(window, GET_PROJECTS);
    assert.ok(closed, "the in-page GET never finished");
    assert.equal(closed.status, 401, "API must be closed after sign out");

    const realErrors = pageErrors.filter(message => !/Could not parse CSS/.test(message));
    assert.deepEqual(realErrors, [], "no uncaught page errors");
  } finally {
    window.close();
    server.close();
  }
});
