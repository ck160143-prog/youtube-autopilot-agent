"use strict";

// The setup panel used to render a "warning" check as a hard ⛔ and never showed
// warning guides or summaries at all, so an unconfigured backup was invisible.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch (_) { JSDOM = null; }
const run = JSDOM ? test : test.skip;

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function jsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text, json: async () => body };
}

test("a warning check is drawn as a warning, with its guide and a summary", async () => {
  const payload = {
    ok: true,
    checks: [
      { id: "GEMINI_API_KEY", label: "Gemini API key", status: "ok", detail: "configured", required: true },
      { id: "BACKUP_STORAGE", label: "Backup storage", status: "warning", detail: "not configured — a redeploy loses every project and MP4", required: false },
    ],
    missing: [],
    warnings: ["BACKUP_STORAGE"],
    setupGuide: [],
    warningGuide: [{
      id: "BACKUP_STORAGE",
      title: "Backup storage सेट करें",
      steps: ["R2 या B2 पर bucket बनाएँ", "STORAGE_S3_ENDPOINT सेट करें", "Secret Render में ही रखें"],
    }],
  };
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "http://localhost/",
    beforeParse(window) {
      window.fetch = async () => jsonResponse(payload);
      if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const w = dom.window;
  await w.babaSetup.load();

  const checks = w.document.getElementById("setupChecks").textContent;
  assert.match(checks, /⚠️ Backup storage/, "a warning must not be drawn as BLOCKED: " + checks);
  assert.ok(!/⛔ Backup storage/.test(checks), "warning rendered as a hard block");

  const guide = w.document.getElementById("setupGuide").textContent;
  assert.match(guide, /STORAGE_S3_ENDPOINT/, "the warning guide must be rendered");

  const status = w.document.getElementById("setupStatus").textContent;
  assert.match(status, /BACKUP_STORAGE/, "the summary must name the warning: " + status);
  assert.match(status, /मिट सकते हैं/, "the summary must say what is at risk");
  dom.window.close();
});

test("with no warnings the status stays clean", async () => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "http://localhost/",
    beforeParse(window) {
      window.fetch = async () => jsonResponse({
        ok: true,
        checks: [{ id: "GEMINI_API_KEY", label: "Gemini API key", status: "ok", detail: "configured", required: true }],
        missing: [], warnings: [], setupGuide: [], warningGuide: [],
      });
      if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const w = dom.window;
  await w.babaSetup.load();
  const status = w.document.getElementById("setupStatus").textContent;
  assert.match(status, /तैयार/);
  assert.ok(!/ध्यान दें/.test(status), "no warning text when there is nothing wrong: " + status);
  dom.window.close();
});
