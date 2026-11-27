"use strict";

// Caption generation. Narration text is distributed across each scene's real
// duration proportional to its length, then split into short readable lines.
// Output is SRT (for YouTube/manual use) and ASS (for burn-in).

const MAX_LINE_CHARS = 42;
const MAX_LINES = 1;

function escapeAss(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function splitCaptionText(text, maxChars = MAX_LINE_CHARS) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function formatSrtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  return pad(hrs) + ":" + pad(mins) + ":" + pad(secs) + "," + pad(millis, 3);
}

function formatAssTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return pad(hrs) + ":" + pad(mins) + ":" + pad(Math.floor(secs)) + "." + pad(Math.floor((secs % 1) * 100), 2);
}

// segments: [{start, end, text}] -> timed caption cues
function buildSegments(segments, options = {}) {
  const maxChars = Number(options.maxChars) || MAX_LINE_CHARS;
  const cues = [];
  for (const segment of segments || []) {
    const duration = Math.max(0.4, Number(segment.end) - Number(segment.start));
    const lines = splitCaptionText(segment.text, maxChars);
    if (!lines.length) continue;
    // One line per cue: a cue that lingers for the whole scene is unreadable.
    // Each cue gets a share of the scene time proportional to its length.
    const groups = [];
    for (let i = 0; i < lines.length; i += MAX_LINES) {
      groups.push(lines.slice(i, i + MAX_LINES).join("\n"));
    }
    const weight = groups.reduce((sum, group) => sum + group.replace(/\n/g, "").length, 0) || 1;
    let cursor = Number(segment.start);
    for (const group of groups) {
      const share = (group.replace(/\n/g, "").length / weight) * duration;
      cues.push({
        start: Number(cursor.toFixed(3)),
        end: Number(Math.min(Number(segment.end), cursor + share).toFixed(3)),
        text: group,
      });
      cursor += share;
    }
  }
  return cues;
}

function buildSrt(cues) {
  return (cues || []).map((cue, index) =>
    (index + 1) + "\n" +
    formatSrtTime(cue.start) + " --> " + formatSrtTime(cue.end) + "\n" +
    cue.text + "\n"
  ).join("\n");
}

function buildAss(cues, options = {}) {
  const width = Number(options.width) || 1280;
  const height = Number(options.height) || 720;
  // 4.5% of height (32px at 720p) is a film-subtitle size: on a phone, where a
  // 1280px frame is shown ~400px wide, that lands near 10px and is unreadable.
  // 6.4% (46px at 720p, 69px at 1080p) is the readable short-video size.
  const fontSize = Number(options.fontSize) || Math.max(28, Math.round(height * 0.064));
  const font = options.font || "Noto Sans Devanagari";
  const marginV = Math.round(height * 0.06);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: " + width,
    "PlayResY: " + height,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, " +
      "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, " +
      "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption," + font + "," + fontSize + ",&H00FFFFFF,&H000000FF,&H00101010,&H90000000," +
      "0,0,0,0,100,100,0,0,1," + Math.max(2, Math.round(fontSize / 12)) + ",1,2," +
      Math.round(width * 0.06) + "," + Math.round(width * 0.06) + "," + marginV + ",1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = (cues || []).map(cue =>
    "Dialogue: 0," + formatAssTime(cue.start) + "," + formatAssTime(cue.end) +
    ",Caption,,0,0,0,," + escapeAss(cue.text)
  );
  return header.concat(events).join("\n") + "\n";
}

// scene narration -> caption segments using real timeline timing
function segmentsFromTimeline(timeline, scenes) {
  return (timeline || []).map(entry => {
    const scene = (scenes || []).find(item => Number(item.index) === Number(entry.index)) || {};
    return { start: entry.start, end: entry.end, text: scene.narration || "" };
  }).filter(segment => segment.text.trim());
}

module.exports = {
  MAX_LINE_CHARS,
  splitCaptionText,
  buildSegments,
  buildSrt,
  buildAss,
  formatSrtTime,
  formatAssTime,
  escapeAss,
  segmentsFromTimeline,
};
