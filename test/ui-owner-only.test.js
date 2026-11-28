"use strict";

// The login screen used to offer "create a new account" unconditionally, which
// contradicts owner-only access: the door is closed, so the signup form must not
// be offered, and a signed-in non-owner must be told why they are stuck.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch (_) { JSDOM = null; }
const run = JSDOM ? test : test.skip;

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function boot(status) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "http://localhost/",
    beforeParse(window) {
      window.fetch = async (url) => ({
        ok: true, status: 200,
        json: async () => (String(url).includes("/api/auth/status") ? status : {}),
        text: async () => JSON.stringify(status),
      });
      if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  return dom;
}

test("signup is hidden when the server says signup is closed", async () => {
  const dom = boot({ registrationOpen: false, bootstrap: false, privateAccess: true, authenticated: false });
  const w = dom.window;
  await w.babaRefreshAccessState();
  const button = w.document.getElementById("authRegisterBtn");
  const fields = w.document.getElementById("authRegisterFields");
  assert.equal(button.hidden, true, "a closed instance must not offer a signup button");
  assert.equal(fields.hidden, true, "and must not ask for a registration key");
  assert.match(w.document.getElementById("authAccessNote").textContent, /owner-only|निजी/);
  dom.window.close();
});

test("the very first account is offered, because without it nothing can be private", async () => {
  const dom = boot({ registrationOpen: true, bootstrap: true, privateAccess: false, authenticated: false });
  const w = dom.window;
  await w.babaRefreshAccessState();
  assert.equal(w.document.getElementById("authRegisterBtn").hidden, false);
  assert.match(w.document.getElementById("authAccessNote").textContent, /मालिक|owner/);
  dom.window.close();
});

test("if the state cannot be read, signup stays hidden", async () => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "http://localhost/",
    beforeParse(window) {
      window.fetch = async () => { throw new Error("offline"); };
      if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const w = dom.window;
  await w.babaRefreshAccessState();
  assert.equal(w.document.getElementById("authRegisterBtn").hidden, true,
    "closed is the safe answer when the server cannot be asked");
  dom.window.close();
});
