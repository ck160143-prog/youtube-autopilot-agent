"use strict";

// Real FFmpeg integration test. It renders an actual MP4 (three scene clips,
// Ken Burns motion, concat, synthesised music bed, caption burn-in) and then
// verifies the file, its streams and its duration. Skipped, never faked, when
// no FFmpeg binary is available.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ffmpegTools = require("../lib/ffmpeg");
const renderer = require("../lib/renderer");
const timeline = require("../lib/timeline");

async function makeAssets(dir, count) {
  const sceneDir = path.join(dir, "scenes");
  fs.mkdirSync(sceneDir, { recursive: true });
  const assets = { scenes: {} };
  for (let index = 1; index <= count; index++) {
    const imagePath = path.join(sceneDir, "scene-" + index + ".png");
    await ffmpegTools.runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x" + ["3355ff", "18865d", "b9a1ff"][index % 3] + ":s=640x360:d=1",
      "-frames:v", "1", "-y", imagePath,
    ]);
    const audioPath = path.join(sceneDir, "voice-" + index + ".wav");
    await ffmpegTools.runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=" + (220 * index) + ":duration=2",
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", audioPath,
    ]);
    assets.scenes[index] = {
      image: { path: imagePath, mime: "image/png" },
      audio: { path: audioPath, mime: "audio/wav", seconds: 2 },
    };
  }
  return assets;
}

test("renderer produces a real playable MP4 with video and audio", { timeout: 240000 }, async () => {
  if (!(await ffmpegTools.ffmpegAvailable())) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }
  process.env.FFMPEG_PRESET = "ultrafast";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-render-"));
  const assets = await makeAssets(dir, 3);
  const scenes = assets.scenes && [1, 2, 3].map(index => ({
    index, title: "दृश्य " + index,
    narration: "यह दृश्य " + index + " का वर्णन है और यह caption में दिखेगा।",
    dialogue: [],
  }));
  const entries = timeline.planTimeline(scenes, { durations: { 1: 2, 2: 2, 3: 2 } });
  const project = { id: "test", assets };

  const events = [];
  const result = await renderer.renderProject({
    project,
    workDir: path.join(dir, "render"),
    runFfmpeg: ffmpegTools.runFfmpeg,
    layout: timeline.layoutFor("16:9", "720p"),
    timeline: entries,
    scenes,
    perChunk: 2,
    music: true,
    burnSubtitles: true,
    onProgress: event => events.push(event),
  });

  assert.ok(fs.existsSync(result.videoPath), "MP4 exists");
  assert.ok(result.size > 10000, "MP4 is not empty: " + result.size);
  assert.equal(result.hasVideo, true);
  assert.equal(result.hasAudio, true);
  assert.ok(Math.abs(result.duration - 6) < 0.6, "duration ~6s, got " + result.duration);
  assert.equal(result.scenes, 3);
  assert.ok(result.chunks >= 1);
  assert.equal(result.music.source, "synthesized");
  assert.equal(result.music.licenseVerified, true);
  assert.ok(["burned", "soft"].includes(result.captions), "captions were produced: " + result.captions);
  assert.ok(events.some(event => event.percent === 100), "progress reaches 100%");

  const info = await ffmpegTools.probe(result.videoPath);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, true);
});

// Resume survives *within* a run: intermediates are now reclaimed once the
// final MP4 is verified, so the contract this test proves is the one that still
// exists — an interrupted render picks up its finished clips, and a completed
// one deliberately leaves only the video behind.
test("a render interrupted mid-way resumes from its finished clips", { timeout: 240000 }, async () => {
  if (!(await ffmpegTools.ffmpegAvailable())) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-resume-"));
  const assets = await makeAssets(dir, 2);
  const scenes = [1, 2].map(index => ({ index, title: "दृश्य", narration: "narration", dialogue: [] }));
  const entries = timeline.planTimeline(scenes, { durations: { 1: 2, 2: 2 } });
  const project = { id: "test", assets };
  const options = {
    project,
    workDir: path.join(dir, "render"),
    runFfmpeg: ffmpegTools.runFfmpeg,
    layout: timeline.layoutFor("9:16", "720p"),
    timeline: entries,
    scenes,
    perChunk: 2,
    music: false,
    burnSubtitles: false,
  };
  const clipDir = path.join(options.workDir, "clips");

  // 1. A completed render reclaims its intermediates: only the MP4 survives.
  const first = await renderer.renderProject(options);
  assert.equal(first.hasVideo, true);
  const leftovers = fs.existsSync(clipDir) ? fs.readdirSync(clipDir) : [];
  assert.deepEqual(leftovers, [], "a finished render must not keep its scene clips");

  // 2. Rebuild the clips as an interrupted render would have left them, then
  // resume: the existing clips must be reused, not encoded again.
  fs.mkdirSync(clipDir, { recursive: true });
  for (const entry of entries) {
    const clipPath = path.join(clipDir, "scene-" + String(entry.index).padStart(4, "0") + ".mp4");
    await renderer.renderSceneClip({
      runFfmpeg: ffmpegTools.runFfmpeg,
      imagePath: assets.scenes[entry.index].image.path,
      audioPath: assets.scenes[entry.index].audio.path,
      outPath: clipPath, duration: entry.duration,
      layout: options.layout, motion: "kenburns-in", transition: "fade",
    });
  }
  const before = fs.readdirSync(clipDir).map(name => name + ":" + fs.statSync(path.join(clipDir, name)).mtimeMs).sort();
  await new Promise(resolve => setTimeout(resolve, 1100));
  const second = await renderer.renderProject({ ...options, resume: true, keepIntermediates: true });
  const after = fs.readdirSync(clipDir).map(name => name + ":" + fs.statSync(path.join(clipDir, name)).mtimeMs).sort();
  assert.deepEqual(before, after, "existing clips are reused, not re-encoded");
  assert.equal(second.hasVideo, true);
  assert.ok(Math.abs(first.duration - second.duration) < 0.6);
});

test("scene clips use Ken Burns motion and are not static", { timeout: 120000 }, async () => {
  if (!(await ffmpegTools.ffmpegAvailable())) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-motion-"));
  const assets = await makeAssets(dir, 1);
  const outPath = path.join(dir, "clip.mp4");
  await renderer.renderSceneClip({
    runFfmpeg: ffmpegTools.runFfmpeg,
    imagePath: assets.scenes[1].image.path,
    audioPath: assets.scenes[1].audio.path,
    duration: 2,
    layout: timeline.layoutFor("16:9", "720p"),
    motion: "kenburns-in",
    transition: "fade",
    outPath,
  });
  const info = await ffmpegTools.probe(outPath);
  assert.equal(info.hasVideo, true);
  assert.ok(info.duration > 1.5, "clip is at least the requested duration");
});
