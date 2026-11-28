"use strict";

// Dashboard contract for the new controls. A control that is visible but sends
// nothing is worse than no control, so these tests watch the request body.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ui-opts-"));

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (_) {
  JSDOM = null;
}

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function boot(handler) {
  const virtualConsole = new VirtualConsole();
  const calls = [];
  const window = new JSDOM(html, {
    url: "http://127.0.0.1/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(w) {
      w.fetch = (url, options) => {
        calls.push({ url: String(url), options: options || {} });
        const result = handler ? handler(String(url), options || {}) : null;
        if (result) {
          return Promise.resolve(new Response(JSON.stringify(result.body || result), {
            status: result.status || 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      };
    },
  }).window;
  window.calls = calls;
  return window;
}

test("the dashboard offers the camera and audio choices", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot();
  const doc = window.document;

  const motion = doc.getElementById("p2Motion");
  const music = doc.getElementById("p2Music");
  assert.ok(motion, "a camera selector must exist");
  assert.ok(music, "an audio-layers selector must exist");

  const values = [...motion.options].map(o => o.value);
  for (const expected of ["kenburns-in", "parallax", "parallax-reverse", "none"]) {
    assert.ok(values.includes(expected), "missing camera option: " + expected);
  }
  assert.equal(motion.value, "kenburns-in", "the default must stay the historical one");

  // The 2.5D claim is labelled honestly next to the control.
  assert.match(doc.body.textContent, /असली 3D मॉडल नहीं/);
});

test("creating a project sends the chosen motion and audio switches", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot(url => {
    if (url === "/api/projects" ) return { status: 201, body: { project: { id: "p1" } } };
    return null;
  });
  const doc = window.document;

  doc.getElementById("p2Topic").value = "परीक्षण कहानी";
  doc.getElementById("p2Motion").value = "parallax";
  doc.getElementById("p2Music").value = "off";
  // The flow requires at least one cast member; make one look selected.
  const cast = doc.getElementById("p2Cast");
  cast.innerHTML = '<input type="checkbox" class="p2CastBox" value="c1" checked>';

  await window.p2.start();

  const created = window.calls.find(c => c.url === "/api/projects" && c.options.method === "POST");
  assert.ok(created, "the project must be created");
  const body = JSON.parse(created.options.body);
  assert.equal(body.motion, "parallax");
  assert.equal(body.music, false);
  assert.equal(body.soundEffects, false);
});

test("the cancel button calls the cancel endpoint instead of doing nothing", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot(url => {
    if (url.indexOf("/cancel") !== -1) return { body: { success: true } };
    return null;
  });
  const doc = window.document;
  const button = doc.getElementById("p2CancelBtn");
  assert.ok(button, "a stop control must exist");

  await window.p2.init();
  // Point the dashboard at a project, then stop it.
  window.p2.selectProject("p1");
  window.p2.refreshProject = async () => {};
  doc.getElementById("p2ProgressWrap").style.display = "block";
  await window.p2.cancel();

  const posted = window.calls.find(c => c.url.indexOf("/cancel") !== -1);
  assert.ok(posted, "cancel must hit the API");
  assert.equal(posted.options.method, "POST");
});

test("the stop control hides itself once a render is finished", async () => {
  if (!JSDOM) return test.skip("jsdom is not installed (npm install)");
  const window = boot();
  const doc = window.document;
  const button = doc.getElementById("p2CancelBtn");
  // 100% is set by setProgress at the end of a run.
  window.p2.setProgress(100);
  assert.equal(button.style.display, "none");
  window.p2.setProgress(40);
  assert.equal(button.style.display, "inline-block");
});
