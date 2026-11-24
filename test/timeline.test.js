"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const timeline = require("../lib/timeline");

test("aspect ratios produce the expected canvas and fps", () => {
  assert.deepEqual(
    { w: timeline.layoutFor("16:9").width, h: timeline.layoutFor("16:9").height },
    { w: 1280, h: 720 }
  );
  assert.deepEqual(
    { w: timeline.layoutFor("9:16").width, h: timeline.layoutFor("9:16").height },
    { w: 720, h: 1280 }
  );
  assert.deepEqual(
    { w: timeline.layoutFor("1:1").width, h: timeline.layoutFor("1:1").height },
    { w: 720, h: 720 }
  );
  assert.equal(timeline.layoutFor("nonsense").aspect, "16:9", "unknown aspect falls back");
  assert.equal(timeline.layoutFor("16:9", "1080p").width, 1920);
  assert.equal(timeline.layoutFor("16:9").fps, 24);
});

test("timeline scales measured narration to the requested runtime", () => {
  const scenes = Array.from({ length: 4 }, (_, index) => ({ index: index + 1, narration: "एक दो तीन" }));
  const entries = timeline.planTimeline(scenes, {
    durations: { 1: 10, 2: 10, 3: 10, 4: 10 },
    targetSeconds: 60,
  });
  const total = timeline.totalSeconds(entries);
  assert.ok(Math.abs(total - 60) < 0.2, "total should land on the target, got " + total);
  assert.equal(entries[0].start, 0);
  assert.ok(Math.abs(entries[0].end - entries[0].start - entries[0].duration) < 0.01);
  assert.ok(Math.abs(entries[1].start - entries[0].end) < 0.01, "scenes are contiguous");
  assert.equal(entries[3].end.toFixed(2), total.toFixed(2));
});

test("timeline falls back to a word-count estimate when audio is missing", () => {
  const scenes = [
    { index: 1, narration: "छोटा वाक्य" },
    { index: 2, narration: Array.from({ length: 60 }, () => "शब्द").join(" ") },
  ];
  const entries = timeline.planTimeline(scenes, { targetSeconds: 20 });
  assert.ok(entries[1].duration > entries[0].duration, "longer narration gets a longer scene");
  assert.ok(Math.abs(timeline.totalSeconds(entries) - 20) < 0.2,
    "total lands on target, got " + timeline.totalSeconds(entries));
  const clamped = timeline.planTimeline(scenes, { targetSeconds: 300, maxScene: 22 });
  assert.equal(clamped[1].duration, 22, "max scene length is respected");
});

test("no scene is shorter than the readability floor", () => {
  const scenes = Array.from({ length: 10 }, (_, index) => ({ index: index + 1, narration: "एक" }));
  const entries = timeline.planTimeline(scenes, { targetSeconds: 5, minScene: 2.5 });
  for (const entry of entries) assert.ok(entry.duration >= 2.5, "scene " + entry.index + " too short");
});

test("chunk plan covers every scene exactly once", () => {
  const chunks = timeline.chunkPlan(25, 10);
  assert.deepEqual(chunks.map(c => [c.startScene, c.endScene]), [[1, 10], [11, 20], [21, 25]]);
  assert.equal(timeline.chunkPlan(0).length, 0);
  assert.equal(timeline.chunkPlan(5, 10).length, 1);
});
