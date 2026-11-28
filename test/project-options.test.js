"use strict";

// The render options used to exist only inside the pipeline: createProject had
// no motion/music/soundEffects, so every video came out with the same camera
// move and the same audio layers no matter what the user picked. These tests
// pin the whole path - API -> project -> pipeline -> render options - because a
// value that is stored but never read is the same bug in a different place.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "opts-"));
process.env.GEMINI_API_KEY = "dummy-key-for-options";

const { createProject } = require("../lib/projects");
const pipeline = require("../lib/pipeline");
const { app } = require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");

let server;
let base;
let session;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "options_user");
});

test.after(() => server && server.close());

const call = (url, options) => fetch(base + url, {
  ...(options || {}),
  headers: authHeaders(session, (options && options.headers) || {}),
});

// ---------- project model ----------

test("a project records the camera and audio choices, with safe defaults", () => {
  const plain = createProject({ topic: "x" });
  assert.equal(plain.motion, "kenburns-in", "default camera must stay the historical one");
  assert.equal(plain.music, true);
  assert.equal(plain.soundEffects, true);

  const chosen = createProject({ topic: "x", motion: "parallax", music: false, soundEffects: false });
  assert.equal(chosen.motion, "parallax");
  assert.equal(chosen.music, false);
  assert.equal(chosen.soundEffects, false);

  // An unknown motion must not reach FFmpeg: it would be silently ignored there.
  const bad = createProject({ topic: "x", motion: "warp-speed" });
  assert.equal(bad.motion, "kenburns-in");
});

test("the create route accepts the options and rejects nothing valid", async () => {
  const response = await call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ topic: "पैरालैक्स टेस्ट", durationMinutes: 1, motion: "parallax-reverse", music: false }),
  });
  assert.equal(response.status, 201);
  const project = (await response.json()).project;
  assert.equal(project.motion, "parallax-reverse");
  assert.equal(project.music, false);

  // And it survives a store round-trip, not just the in-memory object.
  const read = await call("/api/projects/" + project.id);
  const stored = (await read.json()).project;
  assert.equal(stored.motion, "parallax-reverse", "the choice must be persisted, not just echoed");
  assert.equal(stored.music, false);
});

// ---------- pipeline wiring ----------

test("the pipeline renders with the project's motion, not the default", async () => {
  // Capture what renderProject is handed without running FFmpeg at all.
  const renderer = require("../lib/renderer");
  const original = renderer.renderProject;
  let captured = null;
  renderer.renderProject = async options => {
    captured = options;
    return {
      videoPath: "/tmp/fake.mp4", size: 1, duration: 1, hasVideo: true, hasAudio: true,
      captions: "none", chunks: 1, scenes: 1,
    };
  };
  try {
    const project = createProject({ topic: "मोशन टेस्ट", motion: "parallax", music: false, soundEffects: false });
    project.story = { scenes: [{ index: 1, narration: "x", dialogue: [] }] };
    project.assets = { scenes: {} };

    // buildTimeline needs real assets; drive the timeline path directly instead.
    const store = {
      dirFor: () => fs.mkdtempSync(path.join(os.tmpdir(), "opts-dir-")),
      save: () => {},
    };
    await pipeline.render(project, {
      store,
      runFfmpeg: async () => {},
      skipTimelineCheck: true,
    }).catch(() => { /* timeline may be empty; options are captured before that */ });

    // A null capture must fail, not pass quietly: the whole point is that the
    // value reaches the renderer.
    assert.ok(captured, "renderProject must have been called");
    assert.equal(captured.motion, "parallax", "the project's camera must reach the renderer");
    assert.equal(captured.music, false, "music off must reach the renderer");
    assert.equal(captured.soundEffects, false);
  } finally {
    renderer.renderProject = original;
  }
});
