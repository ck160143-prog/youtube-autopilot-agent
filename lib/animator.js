"use strict";

// 2D puppet animation: swap a character's mouth sprite according to a real
// lip-sync cue timeline. No cues or no sprites means no animation — this module
// never invents movement.

const fs = require("fs");
const path = require("path");

// Overlaying one sprite per cue is exact but expensive, so long cue lists are
// thinned evenly. Closed-mouth (X) cues need no sprite: the base frame already
// shows the closed mouth.
const MAX_OVERLAYS = 40;
const MAX_SPRITE_BYTES = 2 * 1024 * 1024;

function requiredSprites(cues) {
  return Array.from(new Set(cues.map(cue => cue.value).filter(value => value !== "X")));
}

function pickCues(cues) {
  if (cues.length <= MAX_OVERLAYS) return cues;
  const step = cues.length / MAX_OVERLAYS;
  const picked = [];
  for (let i = 0; i < MAX_OVERLAYS; i += 1) picked.push(cues[Math.floor(i * step)]);
  return picked.sort((a, b) => a.start - b.start);
}

function validateSprite(file) {
  if (!file || !fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_SPRITE_BYTES) return null;
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) return null;
  return file;
}

// anchor: { x, y, width } as fractions of the frame, so the same rig works at
// 720p and 1080p.
function anchorPixels(anchor, width, height) {
  const safe = anchor && typeof anchor === "object" ? anchor : {};
  const w = Math.max(8, Math.round((Number(safe.width) || 0.22) * width));
  const x = Math.round((Number(safe.x) || 0.39) * width);
  const y = Math.round((Number(safe.y) || 0.55) * height);
  return { x: Math.max(0, Math.min(width - w, x)), y: Math.max(0, Math.min(height - 8, y)), width: w };
}

/**
 * Burn mouth sprites onto an already-rendered scene clip.
 * Returns { path, cuesApplied, shapes } or null when there is nothing to do.
 */
async function applyMouthCues(options) {
  const { runFfmpeg, videoPath, cues, sprites, anchor, width, height, outPath } = options;
  if (!Array.isArray(cues) || !cues.length) return null;
  const available = {};
  for (const [shape, file] of Object.entries(sprites || {})) {
    const valid = validateSprite(file);
    if (valid) available[shape] = valid;
  }
  const usable = pickCues(cues).filter(cue => cue.value === "X" || available[cue.value]);
  const overlayCues = usable.filter(cue => cue.value !== "X");
  if (!overlayCues.length) return null;

  const box = anchorPixels(anchor, width, height);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath];
  const filters = [];
  let previous = "0:v";

  overlayCues.forEach((cue, i) => {
    const inputIndex = i + 1;
    const duration = Math.max(0.04, cue.end - cue.start);
    args.push("-loop", "1", "-t", duration.toFixed(3), "-i", available[cue.value]);
    filters.push("[" + inputIndex + ":v]scale=" + box.width + ":-1,format=rgba[m" + i + "]");
    const label = i === overlayCues.length - 1 ? "vout" : "v" + i;
    filters.push("[" + previous + "][m" + i + "]overlay=x=" + box.x + ":y=" + box.y +
      ":enable='between(t," + cue.start.toFixed(3) + "," + cue.end.toFixed(3) + ")'[" + label + "]");
    previous = label;
  });

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart",
    outPath
  );
  await runFfmpeg(args, { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (!fs.existsSync(outPath) || !fs.statSync(outPath).size) {
    throw Object.assign(new Error("Mouth overlay render नहीं हुआ।"), { statusCode: 500 });
  }
  return {
    path: outPath,
    cuesApplied: overlayCues.length,
    shapes: Array.from(new Set(overlayCues.map(cue => cue.value))),
  };
}

// Decide, honestly, whether a scene can be animated with what is on disk.
function animationReadiness(character, cues) {
  const rig = character && character.rig;
  if (!rig || !rig.mouth) {
    return { ready: false, reason: "character के पास mouth sprites नहीं हैं (rig नहीं है)।" };
  }
  if (!cues || !cues.length) {
    return { ready: false, reason: "इस दृश्य के लिए lip-sync cues नहीं मिले।" };
  }
  const shapes = Array.from(new Set(cues.map(cue => cue.value).filter(value => value !== "X")));
  const missing = shapes.filter(shape => !validateSprite(rig.mouth[shape]));
  if (!shapes.length) return { ready: false, reason: "audio में कोई बोलने वाला हिस्सा नहीं मिला।" };
  if (missing.length) {
    return { ready: false, reason: "missing mouth sprites: " + missing.join(", ") };
  }
  return { ready: true, shapes };
}

module.exports = { applyMouthCues, animationReadiness, requiredSprites, anchorPixels, MAX_OVERLAYS };
