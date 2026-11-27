"use strict";

// Audio mix reality check: background music and SFX are synthesized, so their
// level is a code decision, not a recording's. These tests measure the actual
// output with FFmpeg's volumedetect so "music is on" means "music is audible".

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const ffmpegTools = require("../lib/ffmpeg");
const media = require("../lib/media");
const renderer = require("../lib/renderer");

const execFileP = promisify(execFile);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-audio-"));

const available = ffmpegTools.ffmpegAvailableSync();
const SKIP = available ? false : "FFmpeg binary not available (set FFMPEG_PATH)";

async function volumeStats(file) {
  const bin = ffmpegTools.resolveFfmpegPath();
  const { stderr } = await execFileP(bin, [
    "-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-",
  ], { maxBuffer: 1 << 24 });
  const mean = Number((stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/) || [])[1]);
  const max = Number((stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/) || [])[1]);
  return { mean, max };
}

test("the synthesized music bed is audible, not a near-silent placeholder", { timeout: 120000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const bed = path.join(workDir, "music-bed.m4a");
  await media.synthesizeMusicBed({ runFfmpeg: ffmpegTools.runFfmpeg, duration: 4, outPath: bed });
  const stats = await volumeStats(bed);
  assert.ok(Number.isFinite(stats.mean), "volumedetect returned no mean volume");
  assert.ok(stats.mean > -40, "music bed is too quiet to hear: mean " + stats.mean + " dB (needs > -40)");
  assert.ok(stats.max < -1, "music bed must not clip: max " + stats.max + " dB");
});

test("music survives the mix when there is no narration to duck it", { timeout: 120000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const silent = path.join(workDir, "silent.mp4");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:d=4",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", silent,
  ]);

  const bed = path.join(workDir, "mix-bed.m4a");
  await media.synthesizeMusicBed({ runFfmpeg: ffmpegTools.runFfmpeg, duration: 4, outPath: bed });

  const out = path.join(workDir, "mixed.mp4");
  await renderer.mixAudio({
    runFfmpeg: ffmpegTools.runFfmpeg,
    videoPath: silent,
    musicPath: bed,
    outPath: out,
  });

  const stats = await volumeStats(out);
  assert.ok(stats.mean > -45, "music is inaudible after the mix: mean " + stats.mean + " dB (needs > -45)");
});

test("the SFX track has audible transients", { timeout: 120000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const timeline = [
    { index: 1, start: 0, end: 4, duration: 4 },
    { index: 2, start: 4, end: 8, duration: 4 },
    { index: 3, start: 8, end: 12, duration: 4 },
  ];
  const track = await media.buildSfxTrack({
    runFfmpeg: ffmpegTools.runFfmpeg,
    timeline,
    workDir,
  });
  assert.ok(track && track.path, "SFX track was not produced");
  const stats = await volumeStats(track.path);
  assert.ok(stats.max > -25, "SFX transients are too quiet: max " + stats.max + " dB (needs > -25)");
});
