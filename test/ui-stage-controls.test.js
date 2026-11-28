"use strict";

// POST /projects/:id/{story,assets,render} existed and were used by no UI at
// all, so a failed assets or render step left the user with no option but to
// re-run the whole (paid) generation. These tests pin the controls against the
// real markup, including the case that matters: nothing is clickable while a
// job is running, and per-stage prerequisites are enforced on screen.

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

async function boot(project, options = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/",
    beforeParse(window) {
      window.fetch = async (url, opts) => {
        calls.push(String(url) + " " + String((opts && opts.method) || "GET"));
        return jsonResponse({ project });
      };
      window.confirm = () => (options.confirm === undefined ? true : options.confirm);
      if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  await dom.window.p2.init();
  return { w: dom.window, dom, calls };
}

function buttons(w) {
  return Array.from(w.document.querySelectorAll('#p2StageControls button'))
    .map(b => ({ text: b.textContent, disabled: b.disabled, element: b }));
}

test("stage controls appear with the project and call only their own stage", async () => {
  const project = { id: "p9", status: "failed", topic: "t", sceneCount: 3, story: { scenes: [] }, assets: { scenes: [] } };
  const { w, dom, calls } = await boot(project);
  w.p2.selectProject("p9");
  w.p2.renderProjectView(project);

  const found = buttons(w);
  assert.equal(found.length, 3, "three stage controls are expected: " + found.map(b => b.text).join(" | "));
  assert.ok(found.every(b => b.disabled === false), "a failed project must let every stage be retried");
  assert.ok(found.some(b => /आवाज़/.test(b.text)), "the assets stage must be offered");
  assert.ok(found.some(b => /MP4/.test(b.text)), "the render stage must be offered");

  const render = found.find(b => /MP4/.test(b.text));
  render.element.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(calls.some(c => /\/api\/projects\/p9\/render POST/.test(c)), "render must hit its route: " + calls.join(" ; "));
  assert.ok(!calls.some(c => /\/automate/.test(c)), "a single stage must not restart the whole pipeline");
  dom.window.close();
});

test("controls are disabled while a job is running", async () => {
  const project = { id: "p8", status: "rendering", topic: "t", sceneCount: 3, story: { scenes: [] }, assets: { scenes: [] } };
  const { w, dom } = await boot(project);
  w.p2.renderProjectView(project);
  const found = buttons(w);
  assert.ok(found.length === 3);
  assert.ok(found.every(b => b.disabled), "clicking a stage while rendering must be impossible");
  dom.window.close();
});

test("assets and render need a story first", async () => {
  const project = { id: "p7", status: "draft", topic: "t", sceneCount: 3, assets: { scenes: [] } };
  const { w, dom } = await boot(project);
  w.p2.renderProjectView(project);
  const found = buttons(w);
  const assets = found.find(b => /आवाज़/.test(b.text));
  const render = found.find(b => /MP4/.test(b.text));
  assert.equal(assets.disabled, true, "assets without a story must be blocked on screen");
  assert.equal(render.disabled, true, "render without a story must be blocked on screen");
  assert.match(assets.element.title, /कहानी/, "the reason must be explained");
  dom.window.close();
});

test("rewriting the story asks first, because it discards assets", async () => {
  const project = { id: "p6", status: "completed", topic: "t", sceneCount: 3, story: { scenes: [] }, assets: { scenes: [] } };
  let calls = [];
  const { w, dom } = await boot(project, { confirm: false });
  w.p2.selectProject("p6");
  w.p2.renderProjectView(project);
  const story = buttons(w).find(b => /कहानी/.test(b.text));
  story.element.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(!calls.some(c => /\/story POST/.test(c)), "a cancelled confirmation must not rewrite the story");
  dom.window.close();
});
