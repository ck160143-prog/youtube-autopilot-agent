"use strict";

// Full topic -> MP4 pipeline, including a rigged character whose mouth is
// animated on the real Rhubarb cue timeline. The Gemini client is a
// deterministic fake (no network, no key); everything after the provider is
// real: image validation, audio normalisation, lip-sync analysis, sprite
// overlay, FFmpeg render, captions and persistence.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "test-key-not-real";
process.env.FFMPEG_PRESET = "ultrafast";

const { app, setAIClientFactoryForTests, resetAIClientFactory } = require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");
const ffmpegTools = require("../lib/ffmpeg");
const lipsync = require("../lib/lipsync");

const FFMPEG = process.env.FFMPEG_PATH || "";

// Real speech-like audio (not silence): Rhubarb needs energy in the signal to
// produce mouth cues, and a silent buffer must stay "closed mouth".
async function pcmToneBase64(seconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-e2e-tone-"));
  const raw = path.join(dir, "tone.pcm");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=190:duration=" + seconds,
    "-af", "volume=0.7,tremolo=f=4:d=0.9",
    "-ac", "1", "-ar", "24000", "-f", "s16le", "-y", raw,
  ]);
  return fs.readFileSync(raw).toString("base64");
}

function fakeGemini(pngBase64) {
  return {
    models: {
      generateContent: async args => {
        if (!args.config) {
          return { text: JSON.stringify({
            title: "टोटो की नदी",
            scenes: [1, 2, 3].map(index => ({
              title: "दृश्य " + index,
              narration: "टोटो नदी किनारे आया और मुस्कुराया।",
              dialogue: [{ character: "टोटो", text: "वाह, कितनी सुंदर नदी है!" }],
              imagePrompt: "A cute tiger near a river, wide shot",
              transition: "fade",
            })),
          }) };
        }
        const modalities = args.config.responseModalities || [];
        if (modalities.includes("IMAGE")) {
          return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pngBase64 } }] } }] };
        }
        return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: toneBase64 } }] } }] };
      },
    },
  };
}

let server;
let base;
let session;
let spriteBase64;
let scenePng;
let toneBase64;
let riggedCharacterId;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "e2e_user");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-e2e-sprites-"));
  const mouth = path.join(dir, "mouth.png");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=96x64:d=1",
    "-vf", "drawbox=x=24:y=20:w=48:h=24:color=white:t=fill", "-frames:v", "1", "-y", mouth,
  ]);
  spriteBase64 = fs.readFileSync(mouth).toString("base64");

  const scene = path.join(dir, "scene.png");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x2a6b4a:s=640x640:d=1",
    "-frames:v", "1", "-y", scene,
  ]);
  scenePng = fs.readFileSync(scene).toString("base64");
  toneBase64 = await pcmToneBase64(2);
});

test.after(() => { server.close(); resetAIClientFactory(); });

async function call(url, options) {
  return fetch(base + url, { ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}) });
}

test("a rigged character is animated on the real cue timeline inside the full render", { timeout: 400000 }, async () => {
  if (!FFMPEG) return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  if (!lipsync.resolveEngine()) return test.skip("lip-sync engine not installed (optional)");

  // 1. Character + real mouth sprites.
  const createdCharacter = await call("/api/characters", {
    method: "POST",
    body: JSON.stringify({ name: "टोटो", look: "नन्हा बाघ", outfit: "नीली टी-शर्ट" }),
  });
  const character = (await createdCharacter.json()).character;
  riggedCharacterId = character.id;

  const rig = await call("/api/characters/" + encodeURIComponent(character.id) + "/rig", {
    method: "POST",
    body: JSON.stringify({
      mouth: { A: spriteBase64, B: spriteBase64, X: spriteBase64 },
      anchor: { x: 0.38, y: 0.55, width: 0.24 },
    }),
  });
  assert.equal(rig.status, 200);
  assert.equal((await rig.json()).animationReady, true);

  // 2. Project + one-click automation with the fake provider.
  setAIClientFactoryForTests(() => fakeGemini(scenePng));
  const created = await call("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      topic: "टोटो और नदी", durationMinutes: 1, sceneCount: 3,
      style: "3d-cartoon", aspect: "1:1",
    }),
  });
  const project = (await created.json()).project;

  const started = await call("/api/projects/" + project.id + "/automate", { method: "POST" });
  assert.equal(started.status, 202);

  let final = null;
  for (let i = 0; i < 240; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const state = await call("/api/projects/" + project.id);
    final = await state.json();
    if (["completed", "failed", "interrupted"].includes(final.project.status)) break;
  }
  assert.equal(final.project.status, "completed", JSON.stringify(final.project.progress));
  assert.ok(final.project.render && final.project.render.videoPath, "a real MP4 must exist");
  assert.ok(fs.existsSync(final.project.render.videoPath));
  assert.ok(final.project.render.hasVideo && final.project.render.hasAudio);

  // 3. The lip-sync overlay actually ran on the rendered scenes.
  assert.ok(final.project.render.lipSync, "render must report lip-sync statistics");
  assert.ok(final.project.render.lipSync.scenes >= 1,
    "at least one scene must be mouth-animated, got " + JSON.stringify(final.project.render.lipSync));
  assert.ok(final.project.render.lipSync.cues > 0);
  assert.ok(final.project.render.captions === "burned" || final.project.render.captions === "soft");

  // 4. The narration really was analysed (cue cache next to the audio).
  const audioDir = path.join(dataDir, "projects", project.id, "scenes");
  const cacheFiles = fs.readdirSync(audioDir).filter(name => name.endsWith(".lipsync.json"));
  assert.ok(cacheFiles.length >= 1, "cue cache must exist for the analysed narration");

  // 5. Download gives the same bytes that were rendered.
  const download = await call("/api/projects/" + project.id + "/download");
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type") || "", /video\/mp4/);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.length, fs.statSync(final.project.render.videoPath).size);
});

test("a character without a rig renders normally, with no fake animation", { timeout: 300000 }, async () => {
  if (!FFMPEG) return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  // Remove the rig first: without sprites the same story must not animate.
  if (riggedCharacterId) {
    const removed = await call("/api/characters/" + encodeURIComponent(riggedCharacterId) + "/rig", { method: "DELETE" });
    assert.equal(removed.status, 200);
  }
  setAIClientFactoryForTests(() => fakeGemini(scenePng));
  const created = await call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ topic: "बिना rig वाला किरदार", durationMinutes: 1, sceneCount: 3, aspect: "1:1" }),
  });
  const project = (await created.json()).project;
  const started = await call("/api/projects/" + project.id + "/automate", { method: "POST" });
  assert.equal(started.status, 202);
  let final = null;
  for (let i = 0; i < 200; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    final = await (await call("/api/projects/" + project.id)).json();
    if (["completed", "failed"].includes(final.project.status)) break;
  }
  assert.equal(final.project.status, "completed");
  assert.equal(final.project.render.lipSync.scenes, 0, "no rig means no animation");
});
