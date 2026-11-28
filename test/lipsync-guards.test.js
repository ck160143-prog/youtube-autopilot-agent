"use strict";

// Guard rails around the lip-sync analysis. Both were measured missing:
// MAX_AUDIO_SECONDS was declared but never enforced, and the WASM engine had no
// timeout at all, so a stuck analysis could hang a whole render.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const lipsync = require("../lib/lipsync");

const ff = require("../lib/ffmpeg");

// A real wav of the requested length: the WASM path always converts through
// FFmpeg first, so a hand-written .pcm would not exercise the real route.
async function wavFile(seconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lipsync-guard-"));
  const file = path.join(dir, "voice.wav");
  await ff.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=220:duration=" + seconds, "-ac", "1", "-ar", "16000", "-y", file]);
  return file;
}

// MAX_AUDIO_SECONDS is checked on the raw file, so this one can be sparse.
function pcmFile(seconds, rate = 16000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lipsync-guard-"));
  const file = path.join(dir, "voice.pcm");
  fs.writeFileSync(file, Buffer.alloc(Math.round(seconds * rate * 2)));
  return file;
}

test("an over-long clip is refused instead of exhausting the heap", async () => {
  // 121 s of 16 kHz 16-bit mono is just over MAX_AUDIO_SECONDS.
  const file = pcmFile(lipsync.MAX_AUDIO_SECONDS + 1);
  await assert.rejects(
    () => lipsync.analyseAudio({
      audioPath: file,
      engine: { source: "wasm" },
      runFfmpeg: async () => {},
      analyseWasm: async () => ({ mouthCues: [] }),
    }),
    error => {
      assert.equal(error.statusCode, 413);
      assert.equal(error.code, "LIPSYNC_AUDIO_TOO_LONG");
      return true;
    }
  );
});

test("a clip inside the limit is still analysed", async () => {
  const file = await wavFile(2);
  const result = await lipsync.analyseAudio({
    audioPath: file,
    engine: { source: "wasm" },
    runFfmpeg: ff.runFfmpeg,
    analyseWasm: async () => ({ mouthCues: [{ start: 0, end: 0.4, value: "B" }] }),
  });
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].value, "B");
});

test("a wedged WASM analysis times out instead of hanging the render", async () => {
  const file = await wavFile(1);
  const started = Date.now();
  // The stuck analysis is released afterwards so the abandoned promise does not
  // leak into the next test.
  let release;
  const stuck = new Promise(resolve => { release = resolve; });
  try {
    await assert.rejects(
      () => lipsync.analyseAudio({
        audioPath: file,
        engine: { source: "wasm" },
        runFfmpeg: ff.runFfmpeg,
        timeoutMs: 150,
        analyseWasm: () => stuck,
      }),
      error => {
        assert.equal(error.statusCode, 504);
        return true;
      }
    );
    const waited = Date.now() - started;
    assert.ok(waited < 5000, "timeout fired in " + waited + "ms");
  } finally {
    release({ mouthCues: [] });
  }
});

test("the real WASM engine, when installed, still produces cues", async t => {
  const engine = lipsync.resolveEngine();
  if (!engine) {
    t.skip("no lip-sync engine installed");
    return;
  }
  if (engine.source !== "wasm") {
    t.skip("native Rhubarb on PATH: covered by its own test");
    return;
  }
  // 1.2 s of modulated tone reads as speech-like activity to the recogniser.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lipsync-real-"));
  const wav = path.join(dir, "voice.wav");
  await ff.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=220:duration=1.2", "-af", "tremolo=f=4:d=0.9,volume=0.7",
    "-ac", "1", "-ar", "16000", "-y", wav]);
  const result = await lipsync.analyseAudio({ audioPath: wav, runFfmpeg: ff.runFfmpeg, timeoutMs: 60000 });
  assert.ok(result.cues.length > 0, "engine returned no cues");
  assert.equal(result.source, "Rhubarb Lip Sync (MIT)");
  assert.ok(result.durationSeconds > 1 && result.durationSeconds < 1.5);
});
