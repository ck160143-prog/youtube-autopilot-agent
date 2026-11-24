"use strict";

// Bundled Devanagari font. The sandbox (and Render/containers like it) has no
// system fonts, so without this file libass draws empty boxes. The test burns a
// real Hindi caption with the bundled font and checks pixels, not just config.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fonts = require("../lib/fonts");
const captions = require("../lib/captions");
const renderer = require("../lib/renderer");
const ffmpegTools = require("../lib/ffmpeg");

const FFMPEG = process.env.FFMPEG_PATH || "";

function readPngGray(file) {
  // Minimal PNG reader for the 8-bit grayscale frames this test produces.
  const data = fs.readFileSync(file);
  assert.equal(data.toString("ascii", 1, 4), "PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8, "expected 8-bit PNG");
      assert.equal(chunk[9], 0, "expected grayscale PNG");
    }
    if (type === "IDAT") idat.push(chunk);
    offset += 12 + length;
  }
  const raw = require("zlib").inflateSync(Buffer.concat(idat));
  const stride = width;
  const out = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x > 0 ? line[x - 1] : 0;
      const up = previous[x];
      const upLeft = x > 0 ? previous[x - 1] : 0;
      if (filter === 1) line[x] = (line[x] + left) & 255;
      else if (filter === 2) line[x] = (line[x] + up) & 255;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      }
    }
    line.copy(out, y * stride);
    previous = line;
  }
  return { width, height, pixels: out };
}

test("a Devanagari font ships with the package", () => {
  const file = fonts.resolveFontFile();
  assert.ok(file, "resolveFontFile must find the bundled font");
  assert.equal(path.basename(file), "NotoSansDevanagari-Regular.ttf");
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 100 * 1024, "font file must be a real font, not a stub");
  assert.ok(["00010000", "4f54544f", "74727565"].includes(bytes.subarray(0, 4).toString("hex")),
    "file must start with a TrueType/OpenType signature");
  assert.equal(fs.existsSync(path.join(__dirname, "..", "fonts", "OFL.txt")), true, "OFL licence must ship too");
  assert.equal(typeof fonts.FAMILY, "string");
  assert.equal(fonts.resolveFontDir(), path.join(__dirname, "..", "fonts"));
});

test("CAPTION_FONT_FILE still overrides the bundled font", () => {
  const previous = process.env.CAPTION_FONT_FILE;
  process.env.CAPTION_FONT_FILE = path.join(__dirname, "..", "fonts", "OFL.txt");
  try {
    assert.equal(fonts.resolveFontFile(), process.env.CAPTION_FONT_FILE);
  } finally {
    if (previous === undefined) delete process.env.CAPTION_FONT_FILE;
    else process.env.CAPTION_FONT_FILE = previous;
  }
});

test("the caption style requests the Devanagari family", () => {
  const ass = captions.buildAss([{ start: 0, end: 2, text: "नमस्ते दुनिया" }], { width: 640, height: 360 });
  assert.match(ass, /Style: Caption,Noto Sans Devanagari/);
  assert.match(ass, /नमस्ते दुनिया/);
});

test("burning a Hindi caption with the bundled font draws real glyphs", { timeout: 120000 }, async () => {
  if (!FFMPEG || !fs.existsSync(FFMPEG)) return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-font-"));
  const frame = path.join(dir, "frame.png");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x101010:s=640x360:d=1",
    "-frames:v", "1", "-y", frame,
  ]);
  const clip = path.join(dir, "clip.mp4");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", frame, "-t", "1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip,
  ]);

  const assPath = path.join(dir, "captions.ass");
  fs.writeFileSync(assPath, captions.buildAss(
    [{ start: 0, end: 1, text: "नमस्ते दुनिया, यह हिंदी में है" }],
    { width: 640, height: 360 }
  ));

  const withFont = await renderer.burnCaptions({
    runFfmpeg: ffmpegTools.runFfmpeg,
    videoPath: "clip.mp4", assPath: "captions.ass", outPath: "with-font.mp4",
    cwd: dir, fontsDir: fonts.resolveFontDir(),
  });
  assert.equal(withFont.hasVideo, true);

  const extract = async (video, name) => {
    const png = path.join(dir, name);
    await ffmpegTools.runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", video,
      "-vf", "crop=iw:ih*0.3:0:ih*0.7,format=gray", "-frames:v", "1", "-y", png,
    ]);
    return readPngGray(png);
  };

  const band = await extract(withFont.path, "band-font.png");
  const bright = band.pixels.filter(value => value > 180).length;
  assert.ok(bright > 50, "caption text must actually be drawn (bright pixels: " + bright + ")");

  // Same burn without the bundled font: libass falls back to empty boxes, so
  // the frames must differ. Identical frames would mean the font was ignored.
  const noFont = await renderer.burnCaptions({
    runFfmpeg: ffmpegTools.runFfmpeg,
    videoPath: "clip.mp4", assPath: "captions.ass", outPath: "no-font.mp4",
    cwd: dir, fontsDir: null,
  });
  const bandNoFont = await extract(noFont.path, "band-nofont.png");
  assert.equal(band.pixels.equals(bandNoFont.pixels), false,
    "the bundled font must change the rendered pixels, proving libass used it");
});
