"use strict";

// Full-length render: a real 30-minute project (150 scenes) through the actual
// FFmpeg pipeline — every clip, chunked concat, music + SFX mix and caption
// burn-in. Opt-in because it takes many minutes: RUN_LONG_RENDER=1 npm test.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ffmpegTools = require("../lib/ffmpeg");
const renderer = require("../lib/renderer");
const timelineLib = require("../lib/timeline");
const fonts = require("../lib/fonts");

const SCENES = 150;
const SECONDS_PER_SCENE = 12;
const TOTAL_SECONDS = SCENES * SECONDS_PER_SCENE;

const HINDI_LINES = [
  "नमस्ते दोस्तों, आज की कहानी बहुत खास है।",
  "जंगल में एक छोटा सा गाँव था, जहाँ सब आपस में मिलकर रहते थे।",
  "तभी वहाँ एक रहस्यमयी बात सामने आई।",
  "चलिए आगे बढ़ते हैं और देखते हैं क्या होता है।",
];

test("a 30-minute project renders a real 1800-second MP4", { timeout: 2400000 }, async () => {
  if (process.env.RUN_LONG_RENDER !== "1") {
    return test.skip("long render skipped (set RUN_LONG_RENDER=1 to run the real 30-minute render)");
  }
  if (!(await ffmpegTools.ffmpegAvailable())) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-30min-"));
  const sceneDir = path.join(workDir, "scenes");
  fs.mkdirSync(sceneDir, { recursive: true });

  const project = {
    id: "long-render", aspect: "16:9", quality: "720p",
    assets: { scenes: {} },
  };
  const timeline = [];
  const scenes = [];
  const startedAt = Date.now();

  // 150 real scene images and narration clips (synthetic assets: the provider
  // key is not set in this environment, and a fake provider is not allowed).
  for (let index = 1; index <= SCENES; index += 1) {
    const imagePath = path.join(sceneDir, "scene-" + index + ".png");
    const hue = Math.round((index / SCENES) * 360);
    await ffmpegTools.runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x" + ["1b2a6b", "6b1b4f", "1b6b4a", "6b5a1b"][index % 4] + ":s=1280x720:d=1",
      "-vf", "hue=h=" + hue,
      "-frames:v", "1", "-y", imagePath,
    ]);
    const audioPath = path.join(sceneDir, "voice-" + index + ".wav");
    await ffmpegTools.runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=" + (180 + (index % 12) * 20) + ":duration=" + SECONDS_PER_SCENE,
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", audioPath,
    ]);
    project.assets.scenes[index] = {
      image: { path: imagePath, mime: "image/png" },
      audio: { path: audioPath, mime: "audio/wav", seconds: SECONDS_PER_SCENE },
    };
    timeline.push({ index, start: (index - 1) * SECONDS_PER_SCENE, end: index * SECONDS_PER_SCENE, duration: SECONDS_PER_SCENE });
    scenes.push({ index, narration: HINDI_LINES[index % HINDI_LINES.length] });
  }

  const progress = [];
  const result = await renderer.renderProject({
    project,
    workDir,
    runFfmpeg: ffmpegTools.runFfmpeg,
    layout: timelineLib.layoutFor("16:9", "720p"),
    timeline,
    scenes,
    resume: true,
    music: true,
    soundEffects: true,
    burnSubtitles: true,
    fontsDir: fonts.resolveFontDir(),
    onProgress: event => {
      if (event.stage === "completed" || event.percent === 80 || event.percent === 88 || event.percent === 94) {
        progress.push(event.percent + "% " + event.message);
      }
    },
  });

  const elapsed = (Date.now() - startedAt) / 1000;
  const stat = fs.statSync(result.videoPath);
  console.log("30-minute render: " + Math.round(result.duration) + " s, " +
    (stat.size / 1024 / 1024).toFixed(1) + " MB, " + Math.round(elapsed) + " s wall clock, " +
    result.chunks + " chunks, captions=" + result.captions);
  console.log("progress: " + progress.join(" | "));

  assert.equal(result.hasVideo, true);
  assert.equal(result.hasAudio, true);
  assert.equal(result.scenes, SCENES);
  assert.equal(result.chunks, Math.ceil(SCENES / 10));
  assert.ok(Math.abs(result.duration - TOTAL_SECONDS) <= 15,
    "duration must be ~" + TOTAL_SECONDS + " s, got " + result.duration);
  assert.ok(stat.size > 10 * 1024 * 1024, "a 30-minute 720p video must be a real file, got " + stat.size + " bytes");
  assert.equal(result.captions, "burned", "Hindi captions must be burned in, not dropped");
  assert.ok(result.music && result.music.source, "music bed must be reported");
  assert.ok(result.soundEffects && result.soundEffects.count > 0, "sound effects must be reported");

  // The rendered file must really be a 30-minute stream, not a truncated one.
  const probe = await ffmpegTools.probe(result.videoPath);
  assert.ok(probe.duration >= TOTAL_SECONDS - 15, "probed duration must match, got " + probe.duration);
  console.log("LONG RENDER OK");
});
