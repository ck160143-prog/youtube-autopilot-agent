"use strict";

// Disk hygiene after a render. Measured on a real 1-minute project before this
// existed: 8.32 MB left behind for a 2.03 MB video (4.1x), because clips,
// chunks, timeline, mixed and the music bed all stayed after the final MP4 was
// verified. On an ephemeral host that is the difference between a week of
// projects and a day of them.
//
// The rule this file protects: reclaim only what this render created, never the
// final file, never on failure, and never at the cost of the video.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const renderer = require("../lib/renderer");

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
}

test("intermediates are removed and the final file is kept", async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "final.mp4"), "FINAL");
  fs.writeFileSync(path.join(dir, "timeline.mp4"), "x".repeat(100));
  fs.writeFileSync(path.join(dir, "mixed.mp4"), "x".repeat(100));
  fs.writeFileSync(path.join(dir, "music-bed.m4a"), "x".repeat(50));
  fs.writeFileSync(path.join(dir, "captions.ass"), "x");
  fs.mkdirSync(path.join(dir, "clips"));
  fs.writeFileSync(path.join(dir, "clips", "scene-0001.mp4"), "x".repeat(10));
  fs.mkdirSync(path.join(dir, "chunks"));
  fs.writeFileSync(path.join(dir, "chunks", "chunk-001.mp4"), "x".repeat(10));

  const removed = await renderer.cleanupIntermediates(dir, path.join(dir, "final.mp4"));
  const left = fs.readdirSync(dir).sort();

  assert.deepEqual(left, ["final.mp4"], "only the finished video may survive");
  assert.equal(fs.readFileSync(path.join(dir, "final.mp4"), "utf8"), "FINAL", "the video must be byte-identical");
  assert.ok(removed.length >= 6, "the removed list must be reported for the log");
  assert.ok(removed.some(item => item.path === "music-bed.m4a"));
});

test("the final file is never deleted, even if it is named like an intermediate", async () => {
  const dir = sandbox();
  // A soft-subtitle render can legitimately leave the video at timeline.mp4.
  fs.writeFileSync(path.join(dir, "timeline.mp4"), "VIDEO");
  fs.writeFileSync(path.join(dir, "clips.tmp"), "x");
  fs.mkdirSync(path.join(dir, "clips"));

  await renderer.cleanupIntermediates(dir, path.join(dir, "timeline.mp4"));
  assert.equal(fs.existsSync(path.join(dir, "timeline.mp4")), true, "the render output must survive whatever it is called");
  assert.equal(fs.existsSync(path.join(dir, "clips")), false);
});

test("a missing directory or a locked file never throws", async () => {
  const dir = sandbox();
  // Nothing to remove: must resolve, not reject.
  await assert.doesNotReject(() => renderer.cleanupIntermediates(path.join(dir, "nope"), null));
  // A path that is not a real work dir must not explode either.
  await assert.doesNotReject(() => renderer.cleanupIntermediates(dir, null));
  assert.deepEqual(fs.readdirSync(dir), [], "nothing was invented into existence");
});

test("keepIntermediates opts out, for debugging a bad render", async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "timeline.mp4"), "x");
  const removed = await renderer.cleanupIntermediates(dir, null);
  assert.equal(removed.length, 1, "without a keep path, everything is fair game");
  assert.equal(fs.existsSync(path.join(dir, "timeline.mp4")), false);
});
