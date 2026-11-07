"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const TARGET_MINUTES = new Set([5, 10, 15, 30]);
const DEFAULT_SEGMENT_SECONDS = 60;
const MAX_SEGMENT_CHARS = 3200;

function estimateNarrationSeconds(text, wordsPerMinute = 125) {
  const words = String(text || "").trim().split(/\s+/u).filter(Boolean).length;
  return words ? words * 60 / Math.max(60, Math.min(220, Number(wordsPerMinute) || 125)) : 0;
}
function splitHindiScript(script, options = {}) {
  const text = String(script || "").replace(/\r/g, "").trim();
  if (!text) throw new TypeError("A non-empty Hindi script is required");
  const maxChars = Math.max(500, Math.min(6000, Number(options.maxChars) || MAX_SEGMENT_CHARS));
  const wpm = Math.max(60, Math.min(220, Number(options.wordsPerMinute) || 125));
  const paragraphs = text.split(/\n\s*\n/u).map(x => x.trim()).filter(Boolean);
  const units = [];
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    const sentences = paragraph.match(/[^।.!?]+[।.!?]?/gu) || [paragraph];
    let chunk = "";
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        if (chunk) { units.push(chunk); chunk = ""; }
        for (let i = 0; i < sentence.length; i += maxChars) units.push(sentence.slice(i, i + maxChars).trim());
      } else if (!chunk) chunk = sentence;
      else if ((chunk + " " + sentence).length <= maxChars) chunk += " " + sentence;
      else { units.push(chunk); chunk = sentence; }
    }
    if (chunk) units.push(chunk);
  }
  return units.map((content, index) => ({
    segment: index + 1,
    id: "script-" + String(index + 1).padStart(4, "0"),
    text: content,
    estimatedDurationSeconds: Number(estimateNarrationSeconds(content, wpm).toFixed(2)),
    status: "pending"
  }));
}
function planDurationSegments(durationMinutes, segmentSeconds = DEFAULT_SEGMENT_SECONDS) {
  const minutes = Number(durationMinutes);
  if (!TARGET_MINUTES.has(minutes)) throw new RangeError("duration must be one of 5, 10, 15, or 30 minutes");
  const seconds = Math.max(15, Math.min(180, Number(segmentSeconds) || DEFAULT_SEGMENT_SECONDS));
  const total = minutes * 60, result = [];
  for (let start = 0, index = 0; start < total; start += seconds, index++) {
    result.push({ segment: index + 1, startSeconds: start, targetSeconds: Math.min(seconds, total - start) });
  }
  return result;
}
function orderAndValidateAssets(items, expectedCount, label) {
  if (!Array.isArray(items) || items.length !== expectedCount) throw new Error(label + " count does not match the segment plan");
  const sorted = [...items].sort((a, b) => Number(a.segment) - Number(b.segment));
  for (let i = 0; i < sorted.length; i++) {
    if (Number(sorted[i].segment) !== i + 1 || !sorted[i].path) throw new Error(label + " sequence is incomplete or has a missing path");
  }
  return sorted;
}
function parseDurationFromFfmpeg(stderr) {
  const match = String(stderr || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
async function renderStillSegment({ ffmpegPath, imagePath, audioPath, captionsPath, outputPath, timeoutMs = 180000, width = 1280, height = 720 }) {
  if (!ffmpegPath || !imagePath || !audioPath || !outputPath) throw new TypeError("FFmpeg, image, audio and output paths are required");
  const vf = ["scale=" + width + ":" + height + ":force_original_aspect_ratio=increase", "crop=" + width + ":" + height, "setsar=1", "format=yuv420p"];
  if (captionsPath) vf.push("subtitles='" + String(captionsPath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'") + "'");
  await execFileAsync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-threads", "1", "-y",
    "-loop", "1", "-framerate", "24", "-i", imagePath, "-i", audioPath,
    "-vf", vf.join(","), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
    "-crf", "24", "-r", "24", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", outputPath],
    { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 });
  const stat = await fs.stat(outputPath);
  if (stat.size < 1024) throw new Error("Rendered segment is unexpectedly small");
  return { path: outputPath, size: stat.size };
}
async function concatenateSegments({ ffmpegPath, segmentPaths, outputPath, timeoutMs = 300000, expectedDurationSeconds }) {
  if (!Array.isArray(segmentPaths) || !segmentPaths.length) throw new TypeError("At least one rendered segment is required");
  const dir = path.dirname(outputPath), listPath = path.join(dir, "concat-list.txt");
  const lines = segmentPaths.map(p => {
    if (String(p).includes("'") || String(p).includes("\n")) throw new Error("Unsafe concat path");
    return "file '" + path.resolve(p).replace(/\\/g, "/") + "'";
  });
  await fs.writeFile(listPath, lines.join("\n") + "\n", "utf8");
  try {
    await execFileAsync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-threads", "1", "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", outputPath], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    const stat = await fs.stat(outputPath);
    if (stat.size < 1024) throw new Error("Final MP4 is unexpectedly small");
    const probe = await execFileAsync(ffmpegPath, ["-hide_banner", "-i", outputPath, "-f", "null", "-"], { timeout: 60000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 }).catch(e => e);
    const stderr = probe.stderr || "";
    if (/Invalid data found|moov atom not found|could not find codec parameters/i.test(stderr)) throw new Error("Final MP4 failed FFmpeg media inspection");
    const duration = parseDurationFromFfmpeg(stderr);
    if (!duration) throw new Error("Final MP4 duration could not be verified");
    if (expectedDurationSeconds && Math.abs(duration - expectedDurationSeconds) > Math.max(3, expectedDurationSeconds * 0.02)) {
      throw new Error("Final MP4 duration differs from expected duration");
    }
    return { path: outputPath, size: stat.size, durationSeconds: duration, verified: true };
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
}
module.exports = { TARGET_MINUTES, DEFAULT_SEGMENT_SECONDS, estimateNarrationSeconds, splitHindiScript, planDurationSegments, orderAndValidateAssets, parseDurationFromFfmpeg, renderStillSegment, concatenateSegments };
