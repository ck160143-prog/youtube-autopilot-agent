"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { renderThumbnailToFile } = require("../server");

const enabled = process.env.RUN_FFMPEG_THUMBNAIL_INTEGRATION === "1";

test("FFmpeg creates a real JPEG thumbnail with composited title text", {
  skip: !enabled ? "Set RUN_FFMPEG_THUMBNAIL_INTEGRATION=1 to run the FFmpeg thumbnail integration test" : false,
  timeout: 60000
}, async () => {
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNwy1tAEmIY1TCqYfhqAABniFQQGbydlQAAAABJRU5ErkJggg==";
  let rendered;
  try {
    rendered = await renderThumbnailToFile({
      imageBase64,
      mimeType: "image/png",
      title: "पप्पू की मजेदार गाँव वाली शरारत"
    });
    assert.ok(rendered.size > 1000, "thumbnail should contain a non-empty JPEG");
    const bytes = await fs.readFile(rendered.outputPath);
    assert.equal(bytes[0], 0xff, "JPEG must start with SOI marker");
    assert.equal(bytes[1], 0xd8, "JPEG must start with SOI marker");
    assert.equal(bytes[bytes.length - 2], 0xff, "JPEG must end with EOI marker");
    assert.equal(bytes[bytes.length - 1], 0xd9, "JPEG must end with EOI marker");
  } finally {
    if (rendered?.tempDir) await fs.rm(rendered.tempDir, { recursive: true, force: true });
  }
});
