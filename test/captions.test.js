"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const captions = require("../lib/captions");

test("long narration is split into readable caption lines", () => {
  const text = "टोटो जंगल में इधर-उधर देखता रहा और फिर धीरे-धीरे आगे बढ़ने लगा।";
  const lines = captions.splitCaptionText(text, 20);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.length <= 24, "line stays short: " + line);
});

test("SRT output is valid and uses comma milliseconds", () => {
  const srt = captions.buildSrt([{ start: 0, end: 2.5, text: "नमस्ते दुनिया" }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,500\nनमस्ते दुनिया\n$/);
});

test("caption cues fill the scene time and never overlap", () => {
  const cues = captions.buildSegments([
    { start: 10, end: 20, text: "पहला वाक्य यह है। दूसरा वाक्य यह है। तीसरा वाक्य यह है।" },
  ]);
  assert.ok(cues.length >= 2);
  assert.equal(cues[0].start, 10);
  assert.ok(Math.abs(cues[cues.length - 1].end - 20) < 0.05, "last cue ends with the scene");
  for (let i = 1; i < cues.length; i++) {
    assert.ok(cues[i].start >= cues[i - 1].start);
    assert.ok(cues[i].end > cues[i].start);
  }
});

test("ASS output escapes braces and newlines", () => {
  const ass = captions.buildAss([{ start: 0, end: 1, text: "हैलो {दुनिया}\nदूसरी पंक्ति" }], { width: 720, height: 1280 });
  assert.match(ass, /PlayResX: 720/);
  assert.match(ass, /PlayResY: 1280/);
  assert.match(ass, /\\{दुनिया\\}/);
  assert.match(ass, /\\N/);
  assert.match(ass, /Noto Sans Devanagari/);
});

test("empty narration produces no cues", () => {
  assert.deepEqual(captions.buildSegments([{ start: 0, end: 5, text: "   " }]), []);
});

test("segments come from the timeline, not from guesswork", () => {
  const segments = captions.segmentsFromTimeline(
    [{ index: 1, start: 0, end: 3, duration: 3 }],
    [{ index: 1, narration: "यह असली narration है।" }]
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "यह असली narration है।");
  assert.equal(segments[0].end, 3);
});

test("caption font is big enough to read on a phone at 720p and 1080p", () => {
  // Regression: 4.5% of height gave 32px at 720p. A 1280px-wide frame shown on a
  // ~400px phone screen scales that to ~10px, which viewers cannot read.
  for (const height of [720, 1080, 1920]) {
    const ass = captions.buildAss([{ start: 0, end: 2, text: "परीक्षण पंक्ति" }], { width: Math.round(height * 16 / 9), height });
    const style = ass.split("\n").find(line => line.startsWith("Style: Caption,"));
    const fontSize = Number(style.split(",")[2]);
    assert.ok(fontSize >= height * 0.06,
      "font " + fontSize + "px at " + height + "p is below 6% of height");
    assert.ok(fontSize <= height * 0.09, "font must not overwhelm the frame at " + height + "p");
  }
});

test("an explicit fontSize still wins over the default", () => {
  const ass = captions.buildAss([{ start: 0, end: 2, text: "x" }], { width: 1280, height: 720, fontSize: 20 });
  assert.match(ass, /Style: Caption,[^,]+,20,/);
});
