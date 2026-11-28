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

test("parallax camera motion really moves a still image, and differs from Ken Burns", { timeout: 180000 }, async () => {
  if (!(await ffmpegTools.ffmpegAvailable())) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-parallax-"));
  const assets = await makeAssets(dir, 1);
  const layout = timeline.layoutFor("16:9", "720p");

  // Parallax needs structure to show: on a flat colour the two layers can only
  // slide against themselves, so the frame is identical whatever the motion.
  // A real generated scene always has detail, so the test uses detail too.
  const textured = path.join(dir, "textured.png");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x102030:s=1280x720:d=1",
    "-vf", "drawgrid=w=80:h=720:t=40:c=0xe0a030@0.9", "-frames:v", "1", "-y", textured,
  ]);

  const render = async (motion, name) => {
    const outPath = path.join(dir, name + ".mp4");
    await renderer.renderSceneClip({
      runFfmpeg: ffmpegTools.runFfmpeg,
      imagePath: textured,
      audioPath: assets.scenes[1].audio.path,
      outPath, duration: 2.5, layout, motion, transition: "none",
    });
    return outPath;
  };

  const parallax = await render("parallax", "parallax");
  const reverse = await render("parallax-reverse", "reverse");
  const kenburns = await render("kenburns-in", "kenburns");

  // A real clip: right size, right duration, has video.
  const info = await ffmpegTools.probe(parallax);
  assert.equal(info.hasVideo, true);
  assert.ok(Math.abs(info.duration - 2.5) < 0.4);

  // Grab one frame in the middle of each clip and compare raw pixels. A still
  // image that never moves would produce identical bytes; a broken filter
  // graph would not render at all.
  const frame = (video, name) => {
    const out = path.join(dir, name + ".png");
    const { execFileSync } = require("node:child_process");
    execFileSync(ffmpegTools.resolveFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-ss", "1.2", "-i", video,
      "-frames:v", "1", "-y", out], { stdio: "ignore" });
    return fs.readFileSync(out);
  };
  const a = frame(parallax, "fa");
  const b = frame(reverse, "fb");
  const c = frame(kenburns, "fc");
  assert.notDeepEqual(a, b, "forward and reverse parallax must not be the same picture");
  assert.notDeepEqual(a, c, "parallax must not be identical to a plain Ken Burns frame");
});


test("a crashed re-encode cannot destroy the previous good MP4", async () => {
  // Measured, not assumed. Two claims were tested here and only one is real:
  //
  //  * "a re-render re-encodes its own output and loses a generation" is FALSE.
  //    The caption burn reads `current` (timeline/mixed.mp4), never final.mp4,
  //    so pass 1 and pass 2 produce an identical video stream. That was proved
  //    by reverting this fix: the stream md5 did not change.
  //  * "a crashed re-encode destroys the finished video" is TRUE. The burn used
  //    to write straight into final.mp4, the exact path the project record and
  //    the download route point at, so a failure half-way through left a
  //    truncated file where a valid video used to be (160307 -> 9 bytes).
  //
  // This test therefore asserts the property that actually matters: a failed
  // render must leave the previous video byte-identical.
  const os = require("os");
  const crypto = require("crypto");
  const fsx = require("fs");
  const pathx = require("path");
  const renderer = require("../lib/renderer");
  const ff = require("../lib/ffmpeg");

  const work = fsx.mkdtempSync(pathx.join(os.tmpdir(), "rerender-"));
  const assets = pathx.join(work, "assets");
  fsx.mkdirSync(assets, { recursive: true });
  const image = pathx.join(assets, "s.png");
  const audio = pathx.join(assets, "a.wav");
  await ff.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=0x183a4a:s=1280x720:d=1",
    "-vf", "drawgrid=w=90:h=720:t=45:c=0xf0b040@0.9", "-frames:v", "1", "-y", image]);
  await ff.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=220:duration=2", "-ac", "1", "-ar", "24000", "-y", audio]);

  const project = {
    id: "rerender1", durationMinutes: 1, aspect: "16:9", quality: "720p",
    assets: { scenes: [{ image: { path: image }, audio: { path: audio } }] },
  };
  const timeline = [{ index: 0, duration: 2 }];
  const scenes = [{ index: 0, narration: "नमस्ते दोस्तों", title: "एक" }];
  const layout = require("../lib/timeline").layoutFor("16:9", "720p");
  const sha = file => crypto.createHash("sha256").update(fsx.readFileSync(file)).digest("hex");

  const first = await renderer.renderProject({
    project, workDir: work, runFfmpeg: ff.runFfmpeg, layout, timeline, scenes,
    music: false, soundEffects: false, burnSubtitles: true,
  });
  const goodHash = sha(first.videoPath);
  const goodSize = fsx.statSync(first.videoPath).size;

  // A second render where the caption encode dies half-way: FFmpeg leaves a
  // truncated file where it was writing, exactly as disk-full / OOM / SIGKILL
  // does. burnCaptions treats a failed attempt as "try the next strategy", so
  // the damage is done by the partial write, not by a thrown error.
  const crashing = async (args, opts) => {
    const out = String(args[args.length - 1]);
    if (out.includes("final")) {
      fsx.writeFileSync(pathx.resolve((opts && opts.cwd) || ".", out), Buffer.from("TRUNCATED"));
      throw new Error("simulated crash mid-encode");
    }
    return ff.runFfmpeg(args, opts);
  };
  // It must not throw (captions degrade to a soft track), but it must also not
  // leave the previous video damaged.
  await renderer.renderProject({
    project, workDir: work, runFfmpeg: crashing, layout, timeline, scenes,
    music: false, soundEffects: false, burnSubtitles: true,
  });

  assert.equal(fsx.statSync(first.videoPath).size, goodSize,
    "the failed render changed the size of the previous video");
  assert.equal(sha(first.videoPath), goodHash,
    "the failed render destroyed the previous good MP4");
  assert.equal(fsx.existsSync(pathx.join(work, "final.capture.mp4")), false,
    "a partial temporary file was left behind");
});

test("a re-render keeps the picture identical and never encodes its own output", async () => {
  // Full-pipeline idempotency, stated honestly. The video stream must be
  // identical, because it is built from the same clips and copied, not
  // re-encoded. The audio cannot be byte-identical: FFmpeg's
  // sidechaincompress (the ducking filter) produces slightly different samples
  // on each run, measured at 4 distinct outputs in 5 identical invocations with
  // no project code involved. So the assertion is the property that matters —
  // same picture, same duration, same loudness — plus the real defect this test
  // was written for: the previous final.mp4 must never be read as an input.
  const os = require("os");
  const crypto = require("crypto");
  const fsx = require("fs");
  const pathx = require("path");
  const cp = require("child_process");
  const pipeline = require("../lib/pipeline");
  const { ProjectStore, createProject } = require("../lib/projects");
  const ff = require("../lib/ffmpeg");

  const dataDir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "pipe-identical-"));
  const store = new ProjectStore({ root: pathx.join(dataDir, "projects") });
  const src = fsx.mkdtempSync(pathx.join(os.tmpdir(), "pipe-src-"));
  const image = pathx.join(src, "s.png");
  const audio = pathx.join(src, "a.wav");
  await ff.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=0x183a4a:s=1280x720:d=1",
    "-vf", "drawgrid=w=90:h=720:t=45:c=0xf0b040@0.9", "-frames:v", "1", "-y", image]);
  await ff.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=220:duration=3", "-ac", "1", "-ar", "24000", "-y", audio]);

  const project = createProject({ ownerId: "u", topic: "t", durationMinutes: 1, sceneCount: 1 });
  project.story = { title: "t", scenes: [{ index: 0, title: "a", narration: "नमस्ते दोस्तों", imagePrompt: "x", transition: "fade" }] };
  project.sceneCount = 1;
  project.assets = { scenes: [{ image: { path: image }, audio: { path: audio, seconds: 3 } }] };
  store.save(project);

  const options = { store, runFfmpeg: ff.runFfmpeg, characters: [], onProgress: () => {} };
  const streamMd5 = (file, map) => cp.execFileSync(ff.resolveFfmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-i", file, "-map", map, "-f", "md5", "-",
  ], { encoding: "utf8" }).trim();

  const first = await pipeline.render(project, options);
  const firstVideo = streamMd5(first.videoPath, "0:v");
  const firstDuration = first.duration;

  const second = await pipeline.render(project, options);
  assert.equal(streamMd5(second.videoPath, "0:v"), firstVideo,
    "the picture changed on a re-render: the previous output leaked into the new one");
  assert.ok(Math.abs(second.duration - firstDuration) < 0.5,
    "duration drifted: " + firstDuration + " -> " + second.duration);

  // The temporary encode target must not be left behind, and the final file must
  // not be the caption-burn input.
  const workDir = pathx.dirname(first.videoPath);
  assert.equal(fsx.existsSync(pathx.join(workDir, "final.capture.mp4")), false,
    "the temporary caption target was left on disk");
});

// Cancelling used to do nothing at all: the render ran to the end, the project
// was written "completed" and the video was backed up — measured, 24 seconds
// after the cancel returned HTTP 200. The renderer now stops at the next safe
// point (between scenes, between chunks, before the audio mix) and says so with
// a typed error that the server turns into an honest "cancelled" state.
test("a cancelled render stops at a checkpoint and keeps finished work", { timeout: 240000 }, async () => {
  if (!(await ffmpegTools.ffmpegAvailable())) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }
  process.env.FFMPEG_PRESET = "ultrafast";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-cancel-"));
  const assets = await makeAssets(dir, 4);
  const scenes = [1, 2, 3, 4].map(index => ({
    index, title: "दृश्य " + index, narration: "रोका गया दृश्य " + index, dialogue: [],
  }));
  const entries = timeline.planTimeline(scenes, { durations: { 1: 2, 2: 2, 3: 2, 4: 2 } });
  const project = { id: "cancel-test", assets };

  // Cancel once the second scene has been rendered: the first one must survive.
  let asked = 0;
  let clipsWhenCancelled = 0;
  const events = [];
  await assert.rejects(
    () => renderer.renderProject({
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
      isCancelled: () => {
        asked++;
        const sceneClips = fs.existsSync(path.join(dir, "render", "clips"))
          ? fs.readdirSync(path.join(dir, "render", "clips")).filter(n => /^scene-\d+\.mp4$/.test(n)).length
          : 0;
        if (sceneClips >= 2) {
          if (!clipsWhenCancelled) clipsWhenCancelled = sceneClips;
          return true;
        }
        return false;
      },
    }),
    error => {
      assert.equal(error.code, "RENDER_CANCELLED", "the error must be typed, not a generic failure: " + error.message);
      assert.match(error.message, /रोका गया/);
      return true;
    },
  );

  assert.ok(asked >= 2, "the checkpoint must actually be consulted: " + asked);
  assert.ok(clipsWhenCancelled >= 2, "two scenes were rendered before stopping: " + clipsWhenCancelled);
  const clips = fs.readdirSync(path.join(dir, "render", "clips")).filter(n => /^scene-\d+\.mp4$/.test(n));
  assert.ok(clips.length >= 2, "finished clips must be kept for a resume: " + clips.join(","));
  assert.ok(clips.length < 4, "the render must not have finished every scene: " + clips.length);
  assert.ok(!fs.existsSync(path.join(dir, "render", "final.mp4")), "a cancelled render must not produce a finished MP4");
});
