"use strict";

// End-to-end API test for the Phase 2 pipeline. The Gemini client is replaced
// with a deterministic fake (no network), but everything after the provider is
// real: image signature validation, WAV normalisation, timeline, FFmpeg render,
// project persistence, resume and download.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-data-"));
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "test-key-not-real";
process.env.GEMINI_SCRIPT_MODEL = "test-script-model";
process.env.GEMINI_IMAGE_MODEL = "test-image-model";
process.env.GEMINI_TTS_MODEL = "test-tts-model";
process.env.FFMPEG_PRESET = "ultrafast";

const { app, setAIClientFactoryForTests, resetAIClientFactory } = require("../server");
const { authedHeaders } = require("./helpers");
const ffmpegTools = require("../lib/ffmpeg");

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pcmBase64(seconds) {
  const bytes = Buffer.alloc(Math.round(24000 * 2 * seconds));
  return bytes.toString("base64");
}

function storyJson() {
  return JSON.stringify({
    title: "टोटो और जंगल की खोज",
    scenes: [1, 2, 3].map(index => ({
      title: "दृश्य " + index,
      narration: "टोटो जंगल में आगे बढ़ता रहा और उसे एक नदी दिखाई दी।",
      dialogue: [{ character: "टोटो", text: "चलो, आगे चलते हैं!" }],
      imagePrompt: "A cute tiger walking near a river, wide shot",
      transition: "fade",
    })),
  });
}

function fakeGemini() {
  return {
    models: {
      generateContent: async args => {
        if (!args.config) return { text: storyJson() };
        const modalities = args.config.responseModalities || [];
        if (modalities.includes("IMAGE")) {
          return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_1X1 } }] } }] };
        }
        return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: pcmBase64(2) } }] } }] };
      },
    },
  };
}

let server;
let base;

test("start server", async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

async function api(url, options) {
  const headers = await authedHeaders(base);
  const merged = { ...(options || {}) };
  merged.headers = Object.assign({}, headers, (options && options.headers) || {});
  const response = await fetch(base + url, merged);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
  return { status: response.status, body, headers: response.headers };
}

async function waitFor(projectId, timeoutMs = 200000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { body } = await api("/api/projects/" + projectId);
    const status = body.project && body.project.status;
    if (status === "completed" || status === "failed") return body.project;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("project did not finish in time");
}

test("character CRUD persists a reusable character", async () => {
  const created = await api("/api/characters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "टोटो", voiceGender: "male", look: "orange tiger", outfit: "Blue T-shirt" }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.character.name, "टोटो");
  const listed = await api("/api/characters");
  assert.equal(listed.body.characters.length, 1);
  const bad = await api("/api/characters", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "" }),
  });
  assert.equal(bad.status, 400);
});

test("capabilities report the real feature matrix and blocked animation", async () => {
  const { body } = await api("/api/capabilities");
  assert.equal(body.features.story, "available");
  assert.equal(body.features.sceneImages, "available");
  assert.equal(body.features.voice, "available");
  // No character in this test has an animation rig, so the feature is honestly
  // blocked even though the engine itself may be installed.
  assert.equal(body.features.characterAnimation, "blocked");
  assert.equal(body.features.lipSync, "blocked");
  assert.ok(body.blockedReasons.some(reason => /animation|rig|engine/i.test(reason)));
  assert.ok(Array.isArray(body.animationReadyCharacters));
  assert.equal(typeof body.animationMode, "string");
});

test("one-click automation produces a real MP4 from story to render", { timeout: 240000, skip: ffmpegTools.ffmpegAvailableSync() ? false : "FFmpeg binary not available (set FFMPEG_PATH)" }, async () => {
  setAIClientFactoryForTests(fakeGemini);
  try {
    const created = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: "टोटो और जंगल की खोज",
        durationMinutes: 1,
        sceneCount: 3,
        style: "3d-cartoon",
        aspect: "1:1",
        quality: "720p",
      }),
    });
    assert.equal(created.status, 201);
    const id = created.body.project.id;
    assert.equal(created.body.project.status, "draft");

    const started = await api("/api/projects/" + id + "/automate", { method: "POST" });
    assert.equal(started.status, 202);

    const project = await waitFor(id);
    assert.equal(project.status, "completed", "project error: " + project.error);
    assert.equal(project.story.scenes.length, 3);
    assert.ok(project.timeline.length === 3, "timeline is stored");
    assert.ok(project.render && project.render.size > 10000, "render result has a real size");
    assert.equal(project.render.hasVideo, true);
    assert.equal(project.render.hasAudio, true);
    assert.ok(project.render.duration > 10, "video is longer than 10s: " + project.render.duration);
    assert.ok(["burned", "soft"].includes(project.render.captions), "captions mode reported");
    assert.equal(project.render.music.source, "synthesized");

    for (const index of [1, 2, 3]) {
      assert.ok(project.assets.scenes[index].image.path, "image " + index + " stored");
      assert.ok(project.assets.scenes[index].audio.seconds > 1, "voice " + index + " has a real duration");
    }

    const video = await fetch(base + "/api/projects/" + id + "/video", { headers: await authedHeaders(base) });
    assert.equal(video.status, 200);
    assert.match(video.headers.get("content-type") || "", /video\/mp4/);
    const bytes = Buffer.from(await video.arrayBuffer());
    assert.ok(bytes.length > 10000, "downloaded MP4 has bytes");
    assert.equal(bytes.toString("ascii", 4, 8), "ftyp", "payload is a real MP4 container");

    const srt = await fetch(base + "/api/projects/" + id + "/captions", { headers: await authedHeaders(base) });
    assert.equal(srt.status, 200);
    assert.match(await srt.text(), /00:00:0/);

    const sceneImage = await fetch(base + "/api/projects/" + id + "/scenes/1/image", { headers: await authedHeaders(base) });
    assert.equal(sceneImage.status, 200);
    const imageBytes = Buffer.from(await sceneImage.arrayBuffer());
    assert.equal(imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);

    const listed = await api("/api/projects");
    assert.equal(listed.body.projects.length, 1);
    assert.equal(listed.body.projects[0].status, "completed");
  } finally {
    resetAIClientFactory();
  }
});

test("missing API key blocks story generation instead of faking it", async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { status, body } = await api("/api/story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "परीक्षण" }),
    });
    assert.equal(status, 503);
    assert.equal(body.blocked, true);
    assert.match(body.error, /GEMINI_API_KEY/);
  } finally {
    process.env.GEMINI_API_KEY = previous;
  }
});

test("unknown project returns JSON 404", async () => {
  const { status, body } = await api("/api/projects/does-not-exist");
  assert.equal(status, 404);
  assert.match(body.error, /नहीं मिला/);
});

test("stop server", async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
