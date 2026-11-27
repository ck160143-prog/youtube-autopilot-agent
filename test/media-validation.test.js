"use strict";

// Media validation reality checks: a valid file signature is not proof of a
// usable asset. These tests feed real files (solid colour, noise, tiny audio)
// through the app's own validators and assert what actually happens.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ffmpegTools = require("../lib/ffmpeg");
const media = require("../lib/media");
const pipeline = require("../lib/pipeline");

const available = ffmpegTools.ffmpegAvailableSync();
const SKIP = available ? false : "FFmpeg binary not available (set FFMPEG_PATH)";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-media-"));

async function makeImage(file, source) {
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", source, "-frames:v", "1", "-y", file,
  ]);
  return file;
}

test("a one-colour image is detected as blank", { timeout: 60000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const solid = await makeImage(path.join(workDir, "solid.png"), "color=c=gray:s=320x240");
  const result = await media.detectBlankImage({ imagePath: solid });
  assert.equal(result.checked, true, "signalstats produced no luma values");
  assert.equal(result.blank, true, "a flat colour must be reported blank, spread=" + result.spread);
});

test("a real illustration is not reported blank", { timeout: 60000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const varied = await makeImage(path.join(workDir, "varied.png"), "testsrc2=s=320x240");
  const result = await media.detectBlankImage({ imagePath: varied });
  assert.equal(result.blank, false, "a varied image must not be reported blank, spread=" + result.spread);
});

test("generateAssets refuses a blank image instead of rendering an empty scene", { timeout: 60000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const solid = await makeImage(path.join(workDir, "blank-scene.png"), "color=c=white:s=320x240");
  const blankBase64 = fs.readFileSync(solid).toString("base64");

  const project = {
    id: "blank-check",
    story: { characters: [], scenes: [{ index: 1, narration: "यह एक दृश्य है।", imagePrompt: "test" }] },
    assets: { scenes: {} },
  };
  const store = { dirFor: id => path.join(workDir, id), save: () => {} };
  const provider = {
    image: { generate: async () => ({ mimeType: "image/png", imageBase64: blankBase64, source: "test" }) },
    voice: { generate: async () => ({ mimeType: "audio/L16;rate=24000", audioBase64: "" }) },
  };

  await assert.rejects(
    () => pipeline.generateAssets(project, { provider, store, runFfmpeg: ffmpegTools.runFfmpeg }),
    error => /blank/i.test(String(error.message)),
    "a blank scene image must fail the asset step"
  );
});

test("saveAudio refuses a clip shorter than a spoken word", { timeout: 60000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const pcm = path.join(workDir, "tiny.pcm");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1",
    "-ac", "1", "-ar", "24000", "-f", "s16le", "-y", pcm,
  ]);
  const audioBase64 = fs.readFileSync(pcm).toString("base64");
  const sceneDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-scene-"));
  await assert.rejects(
    () => pipeline.saveAudio(sceneDir, 1, { mimeType: "audio/L16;rate=24000", audioBase64 }, ffmpegTools.runFfmpeg),
    error => /आवाज़/.test(String(error.message)),
    "a 0.1s clip must be rejected as unusable narration"
  );
});

test("an undecodable image is rejected instead of hanging the renderer", { timeout: 60000 }, async () => {
  if (SKIP) return test.skip(SKIP);
  const valid = await makeImage(path.join(workDir, "valid.png"), "color=c=blue:s=64x64");
  const bytes = fs.readFileSync(valid);
  // PNG signature intact, payload truncated: the signature check in saveImage
  // passes, but FFmpeg cannot decode it. That used to hang the render worker.
  const corrupt = path.join(workDir, "corrupt.png");
  fs.writeFileSync(corrupt, Buffer.concat([bytes.subarray(0, 16), Buffer.from([0, 1, 2, 3, 4])]));
  const result = await media.detectBlankImage({ imagePath: corrupt });
  assert.equal(result.blank, true, "an undecodable image must be rejected");
  assert.equal(result.reason, "undecodable");
});

test("saveImage still rejects bytes that do not match the declared type", () => {
  const sceneDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-sig-"));
  assert.throws(
    () => pipeline.saveImage(sceneDir, 1, { mimeType: "image/png", imageBase64: Buffer.from("not a png").toString("base64") }),
    /signature/,
    "a mislabelled payload must never reach FFmpeg"
  );
});
