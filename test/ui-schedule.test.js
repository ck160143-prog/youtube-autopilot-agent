"use strict";

// Browser-level check of the schedule field. The rule that matters: a filled
// datetime-local MUST become a UTC ISO publishAt in the upload metadata, and an
// empty one must leave the request exactly as it was before the feature existed
// (immediate upload, no publishAt key at all).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-ui-sched-"));

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (_) {
  JSDOM = null;
}

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function boot() {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // The dashboard fires session/setup fetches on load; stub them so this
      // test only exercises the metadata helper.
      window.fetch = () => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    },
  });
  return dom.window;
}

function metaFrom(window) {
  const header = window.videoMetaHeader("शीर्षक", "विवरण", "public");
  // b64utf8 is the same helper the upload path uses to build the header.
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

test("an empty schedule leaves the upload immediate and untouched", () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot();
  try {
    window.showUploadForm();
    const field = window.document.getElementById("ytPublishAt");
    assert.ok(field, "the upload form must offer a schedule field");
    assert.equal(field.value, "");
    const meta = metaFrom(window);
    assert.equal("publishAt" in meta, false, "no schedule must mean no publishAt key");
    assert.deepEqual(Object.keys(meta).sort(), ["description", "privacy", "title"]);
  } finally {
    window.close();
  }
});

test("a filled schedule becomes a UTC ISO publishAt", () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot();
  try {
    window.showUploadForm();
    const field = window.document.getElementById("ytPublishAt");
    field.value = "2026-12-05T14:30";           // datetime-local has no zone
    const meta = metaFrom(window);
    assert.ok(meta.publishAt, "the schedule must be carried in the metadata");
    assert.match(meta.publishAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "must be ISO 8601 UTC");
    assert.equal(new Date(meta.publishAt).getTime(), new Date("2026-12-05T14:30").getTime(),
      "the moment must not shift");
  } finally {
    window.close();
  }
});

test("a half-filled schedule value never becomes Invalid Date", () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot();
  try {
    window.showUploadForm();
    const field = window.document.getElementById("ytPublishAt");
    field.value = "not-a-date";
    const meta = metaFrom(window);
    assert.equal("publishAt" in meta, false, "an unparseable value must be dropped, not sent as NaN");
  } finally {
    window.close();
  }
});
