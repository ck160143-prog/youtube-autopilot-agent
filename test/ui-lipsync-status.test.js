"use strict";

// The dashboard used to print "lip-sync: ⛔ BLOCKED" unconditionally, even on a
// deployment where the Rhubarb engine is installed, and it never showed whether
// animation reached the finished MP4. Both are user-visible lies, so both are
// pinned here against the real markup.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch (_) { JSDOM = null; }
const run = JSDOM ? test : test.skip;

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// P2.api reads response.text() and parses it, so the stub must provide it.
function jsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text, json: async () => body };
}

async function boot(fetchImpl) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/",
    beforeParse(window) {
      window.fetch = fetchImpl;
      if (!window.navigator.clipboard) {
        window.navigator.clipboard = { writeText: async () => {} };
      }
    },
  });
  await dom.window.p2.init();
  return dom;
}

run("the capability line reports the engine that is really installed", async () => {
  const dom = await boot(async url => {
    if (String(url).includes("/api/capabilities")) {
      return jsonResponse({
        features: { story: "available", sceneImages: "available", voice: "available", render: "available", captions: "available", music: "available" },
        lipSync: { available: true, source: "wasm" },
        ffmpeg: { available: true, version: "9.0.2" },
        blockedReasons: [],
      });
    }
    return jsonResponse({});
  });
  const w = dom.window;
  await w.p2.loadCapabilities();
  const text = w.document.getElementById("p2Capabilities").textContent;
  assert.equal(w.p2.lipSyncAvailable, true);
  assert.ok(/✅ उपलब्ध \(wasm\)/.test(text), "expected the installed engine to be shown: " + text);
  assert.ok(!/BLOCKED/.test(text.replace(/3D/g, "")), "stale BLOCKED claim still rendered: " + text);
  dom.window.close();
});

run("the capability line still says BLOCKED when no engine exists", async () => {
  const dom = await boot(async url => {
    if (String(url).includes("/api/capabilities")) {
      return jsonResponse({
        features: {}, lipSync: { available: false, source: "none" },
        ffmpeg: { available: true, version: "9.0.2" }, blockedReasons: [],
      });
    }
    return jsonResponse({});
  });
  const w = dom.window;
  await w.p2.loadCapabilities();
  const text = w.document.getElementById("p2Capabilities").textContent;
  assert.equal(w.p2.lipSyncAvailable, false);
  assert.ok(/⛔ BLOCKED/.test(text), "a missing engine must still be reported: " + text);
  dom.window.close();
});

run("a render without animation says so instead of staying silent", async () => {
  const project = {
    id: "p1", status: "completed", topic: "t", sceneCount: 1,
    render: {
      size: 2 * 1024 * 1024, duration: 60, captions: "burned", music: { source: "synthesized" },
      layout: { width: 1280, height: 720 }, lipSync: { scenes: 0, cues: 0, shapes: [] },
      videoPath: "/data/projects/p1/render/final.mp4",
    },
    story: { scenes: [] },
  };
  const dom = await boot(async () => jsonResponse({ project }));
  const w = dom.window;
  w.p2.lipSyncAvailable = true;
  await w.p2.renderProjectView(project);
  const line = w.document.getElementById("p2LipSyncInfo");
  assert.ok(line, "the render panel must state the lip-sync outcome");
  assert.ok(/नहीं लगा/.test(line.textContent), "expected an honest 'not applied' note: " + line.textContent);
  assert.ok(/rig/.test(line.textContent), "the reason should name the likely cause: " + line.textContent);
  dom.window.close();
});

run("a render with animation reports the real counts", async () => {
  const project = {
    id: "p2", status: "completed", topic: "t", sceneCount: 6,
    render: {
      size: 2.9 * 1024 * 1024, duration: 60, captions: "burned", music: { source: "synthesized" },
      layout: { width: 1280, height: 720 }, lipSync: { scenes: 6, cues: 12, shapes: ["B"] },
      videoPath: "/data/projects/p2/render/final.mp4",
    },
    story: { scenes: [] },
  };
  const dom = await boot(async () => jsonResponse({ project }));
  const w = dom.window;
  w.p2.lipSyncAvailable = true;
  await w.p2.renderProjectView(project);
  const line = w.document.getElementById("p2LipSyncInfo").textContent;
  assert.ok(/6 दृश्य/.test(line) && /12 मुँह cues/.test(line) && /B/.test(line), "got: " + line);
  dom.window.close();
});

test("a finished project offers a restore action that really calls the API", async () => {
  const calls = [];
  const project = {
    id: "p3", status: "completed", topic: "t", sceneCount: 1,
    render: { size: 1024, duration: 60, videoPath: "/tmp/x.mp4", lipSync: { scenes: 0, cues: 0 } },
    story: { scenes: [] },
  };
  const dom = await boot(async (url, options) => {
    calls.push(String(url) + " " + ((options && options.method) || "GET"));
    if (String(url).includes("/restore")) {
      return jsonResponse({ restored: 3, driver: "local", bytes: 2048 });
    }
    return jsonResponse({ projects: [project], project });
  });
  const w = dom.window;
  w.p2.renderProjectList();
  const buttons = Array.from(w.document.querySelectorAll("#p2ProjectList button"));
  const restore = buttons.find(b => /वापस लाएँ/.test(b.textContent));
  assert.ok(restore, "a restore control must exist for a completed project: " +
    buttons.map(b => b.textContent).join(" | "));
  restore.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(calls.some(c => /\/api\/projects\/p3\/restore POST/.test(c)), "restore must hit the API: " + calls.join(" ; "));
  assert.ok(/3 फ़ाइलें/.test(w.document.body.textContent), "the outcome must be reported");
  dom.window.close();
});
