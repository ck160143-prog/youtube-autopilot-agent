"use strict";

// Rhubarb lip-sync integration: the real engine (native binary or the MIT WASM
// build) turns narration into a mouth-cue timeline, and the module refuses to
// invent cues when no engine is installed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lipsync = require("../lib/lipsync");
const ffmpegTools = require("../lib/ffmpeg");
// Honest skip: with no FFmpeg binary the render-based tests cannot run, and a
// failure would be a lie about the code rather than about the environment.
const SKIP_NO_FFMPEG = ffmpegTools.ffmpegAvailableSync()
  ? false
  : "FFmpeg binary not available (set FFMPEG_PATH)";


const FFMPEG = process.env.FFMPEG_PATH || "";

async function makeAudio(dir, seconds, name) {
  const file = path.join(dir, name || "narration.wav");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=190:duration=" + seconds, "-af", "volume=0.6,tremolo=f=4:d=0.9",
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", file,
  ]);
  return file;
}

test("cue normalising merges repeats and drops invalid shapes", () => {
  const cues = lipsync.normaliseCues([
    { start: 0, end: 0.1, value: "x" },
    { start: 0.1, end: 0.6, value: "B" },
    { start: 0.6, end: 0.9, value: "B" },
    { start: 0.9, end: 1.2, value: "Q" },
    { start: 1.2, end: 1.1, value: "A" },
  ]);
  assert.deepEqual(cues, [
    { start: 0, end: 0.1, value: "X" },
    { start: 0.1, end: 0.9, value: "B" },
  ]);
});

test("engine detection reports the real source", () => {
  const engine = lipsync.resolveEngine();
  if (!engine) {
    assert.equal(lipsync.engineLabel(), null);
    return test.skip("no lip-sync engine installed (optional)");
  }
  assert.ok(["native", "wasm"].includes(engine.source));
  assert.match(lipsync.engineLabel(), /Rhubarb/);
});

test("a real narration file produces a real mouth-cue timeline", { timeout: 180000, skip: SKIP_NO_FFMPEG }, async () => {
  const engine = lipsync.resolveEngine();
  if (!engine) return test.skip("no lip-sync engine installed (optional)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-lip-"));
  const audio = await makeAudio(dir, 2);

  const result = await lipsync.analyseAudio({ audioPath: audio, runFfmpeg: ffmpegTools.runFfmpeg });
  assert.ok(Array.isArray(result.cues) && result.cues.length > 0, "engine must return cues");
  assert.ok(result.durationSeconds >= 1.9, "duration must come from the real audio, got " + result.durationSeconds);
  for (const cue of result.cues) {
    assert.ok(cue.end > cue.start, "cues must be ordered and positive-length");
    assert.ok(["A", "B", "C", "D", "E", "F", "G", "H", "X"].includes(cue.value), "shape must be a Rhubarb shape");
  }
  assert.equal(result.source, "Rhubarb Lip Sync (MIT)");
});

test("analysis is cached beside the narration", { timeout: 180000, skip: SKIP_NO_FFMPEG }, async () => {
  const engine = lipsync.resolveEngine();
  if (!engine) return test.skip("no lip-sync engine installed (optional)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-lipcache-"));
  const audio = await makeAudio(dir, 1, "cache.wav");
  const first = await lipsync.analyseAudioCached({ audioPath: audio, runFfmpeg: ffmpegTools.runFfmpeg });
  assert.equal(first.cached, undefined);
  assert.ok(fs.existsSync(lipsync.cachedCuePath(audio)), "cue cache file must be written");
  const second = await lipsync.analyseAudioCached({ audioPath: audio, runFfmpeg: ffmpegTools.runFfmpeg });
  assert.equal(second.cached, true);
  assert.equal(second.cues.length, first.cues.length);
});

test("no engine means an explicit blocked error, never invented cues", { timeout: 60000, skip: SKIP_NO_FFMPEG }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-lipnone-"));
  const audio = await makeAudio(dir, 1, "no-engine.wav");
  await assert.rejects(
    () => lipsync.analyseAudio({ audioPath: audio, runFfmpeg: ffmpegTools.runFfmpeg, engine: false }),
    error => {
      assert.equal(error.code, "NO_LIPSYNC_ENGINE");
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /rhubarb/i);
      return true;
    }
  );
});

test("a missing audio file is rejected before any engine runs", async () => {
  await assert.rejects(
    () => lipsync.analyseAudio({ audioPath: "/nonexistent/narration.wav", runFfmpeg: ffmpegTools.runFfmpeg }),
    error => error.statusCode === 409
  );
});
