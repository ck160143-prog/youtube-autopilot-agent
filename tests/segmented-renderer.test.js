"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { splitHindiScript, planDurationSegments, orderAndValidateAssets, parseDurationFromFfmpeg, estimateNarrationSeconds } = require("../segmented-renderer");

test("script splitting preserves every character and never truncates long Hindi scripts", () => {
  const script = ("यह एक लंबा हिंदी वाक्य है। ".repeat(600)).trim();
  const segments = splitHindiScript(script, { maxChars: 900 });
  assert.ok(segments.length > 3);
  assert.equal(segments.map(x => x.text).join(" ").replace(/\s+/g, " ").trim(),
    script.replace(/\s+/g, " ").trim());
  assert.ok(segments.every(x => x.text.length <= 900));
  assert.ok(segments.every(x => x.estimatedDurationSeconds > 0));
});
for (const minutes of [5, 10, 15, 30]) {
  test(minutes + "-minute target produces a complete ordered segment plan", () => {
    const plan = planDurationSegments(minutes);
    assert.equal(plan.reduce((n, x) => n + x.targetSeconds, 0), minutes * 60);
    assert.equal(plan[0].startSeconds, 0);
    assert.equal(plan.at(-1).startSeconds + plan.at(-1).targetSeconds, minutes * 60);
  });
}
test("unsupported target durations are rejected rather than silently approximated", () => {
  assert.throws(() => planDurationSegments(3), /5, 10, 15, or 30/);
});
test("audio and video assets must be complete and ordered", () => {
  const ordered = orderAndValidateAssets([{segment:2,path:"b.mp4"},{segment:1,path:"a.mp4"}],2,"video");
  assert.deepEqual(ordered.map(x => x.path),["a.mp4","b.mp4"]);
  assert.throws(() => orderAndValidateAssets([{segment:1,path:"a"}],2,"audio"),/count/);
  assert.throws(() => orderAndValidateAssets([{segment:2,path:"b"}],1,"audio"),/sequence/);
});
test("FFmpeg duration parser handles hours and fractional seconds", () => {
  assert.equal(parseDurationFromFfmpeg("Duration: 00:30:12.50, start: 0"),1812.5);
  assert.equal(parseDurationFromFfmpeg("no duration"),null);
});
test("narration estimate is based on word count", () => {
  assert.equal(estimateNarrationSeconds("एक दो तीन",120),1.5);
});
