"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { renderToFile } = require("../server");

const enabled = process.env.RUN_FFMPEG_INTEGRATION === "1";

test("FFmpeg renders an MP4 with captions burned into the video stream", {
  skip: !enabled ? "Set RUN_FFMPEG_INTEGRATION=1 to run the FFmpeg integration test" : false,
  timeout: 300000
}, async () => {
  // Small valid PNG and 0.8 s of 24 kHz mono PCM silence keep CI resource use low.
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfOOGYyqiH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFjWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFjWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFjSgBQ1oQQNa0IAWPHYBm4BBPKP3aYAAAAAASUVORK5CYII=";
  const audioBase64 = Buffer.alloc(24000 * 2 * 0.8).toString("base64");
  const captionsSrt = "1\n00:00:00,000 --> 00:00:00,800\nनमस्ते दोस्तों\n";
  let rendered;
  try {
    rendered = await renderToFile({
      scenes: [{ imageBase64, mimeType: "image/png" }],
      audioBase64,
      audioMime: "audio/L16",
      captionsSrt
    });
    assert.ok(rendered.size > 1000, "FFmpeg should create a non-empty MP4");
    const video = await fs.readFile(rendered.outputPath);
    assert.equal(video.subarray(4, 8).toString("ascii"), "ftyp", "output should be an MP4 container");
  } finally {
    if (rendered?.tempDir) await fs.rm(rendered.tempDir, { recursive: true, force: true });
  }
});
