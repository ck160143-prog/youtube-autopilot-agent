"use strict";

// Timeline engine. One engine for every duration and aspect ratio: scene
// durations come from real narration audio when available, otherwise from a
// word-count estimate, then the whole timeline is scaled to the requested
// runtime. Long videos are split into render chunks so memory stays flat.

const ASPECTS = {
  "16:9": { width: 1280, height: 720, label: "YouTube landscape (16:9)" },
  "9:16": { width: 720, height: 1280, label: "YouTube Shorts (9:16)" },
  "1:1": { width: 720, height: 720, label: "Square (1:1)" },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAspect(aspect) {
  return Object.prototype.hasOwnProperty.call(ASPECTS, aspect) ? aspect : "16:9";
}

function layoutFor(aspect, quality) {
  const key = normalizeAspect(aspect);
  const base = ASPECTS[key];
  const scale = quality === "1080p" ? 1.5 : 1;
  return {
    aspect: key,
    label: base.label,
    width: Math.round(base.width * scale),
    height: Math.round(base.height * scale),
    fps: 24,
  };
}

// Scale scene durations so the total hits targetSeconds. Two passes keep the
// min/max clamps from drifting the total back off target.
function planTimeline(scenes, options = {}) {
  const list = Array.isArray(scenes) ? scenes : [];
  const targetSeconds = Number(options.targetSeconds);
  const minScene = Number(options.minScene) || 2.5;
  const maxScene = Number(options.maxScene) || 22;
  const measured = options.durations || {};
  const raw = list.map((scene, index) => {
    const measuredSeconds = Number(measured[scene.index == null ? index + 1 : scene.index]);
    if (Number.isFinite(measuredSeconds) && measuredSeconds > 0.2) return measuredSeconds;
    return estimateSeconds(scene);
  });
  let durations = raw.slice();
  const total = durations.reduce((a, b) => a + b, 0);
  if (Number.isFinite(targetSeconds) && targetSeconds > 0 && total > 0) {
    durations = durations.map(d => clamp((d * targetSeconds) / total, minScene, maxScene));
    const clampedTotal = durations.reduce((a, b) => a + b, 0);
    if (clampedTotal > 0) {
      durations = durations.map(d => clamp((d * targetSeconds) / clampedTotal, minScene, maxScene));
    }
  }
  let cursor = 0;
  return list.map((scene, index) => {
    const duration = durations[index];
    const entry = {
      index: scene.index == null ? index + 1 : scene.index,
      start: Number(cursor.toFixed(3)),
      end: Number((cursor + duration).toFixed(3)),
      duration: Number(duration.toFixed(3)),
    };
    cursor += duration;
    return entry;
  });
}

function estimateSeconds(scene) {
  const narration = String((scene && scene.narration) || "").trim();
  const dialogue = ((scene && scene.dialogue) || []).map(d => d.text).join(" ");
  const words = (narration + " " + dialogue).trim().split(/\s+/).filter(Boolean).length;
  return clamp((words / 130) * 60, 2.5, 22);
}

function totalSeconds(timeline) {
  return (timeline || []).reduce((sum, item) => sum + item.duration, 0);
}

function chunkPlan(sceneCount, perChunk = 10) {
  const total = Math.max(0, Number(sceneCount) || 0);
  const size = Math.max(1, Number(perChunk) || 10);
  const chunks = [];
  for (let start = 0; start < total; start += size) {
    chunks.push({
      index: chunks.length + 1,
      startScene: start + 1,
      endScene: Math.min(total, start + size),
    });
  }
  return chunks;
}

module.exports = {
  ASPECTS,
  normalizeAspect,
  layoutFor,
  planTimeline,
  estimateSeconds,
  totalSeconds,
  chunkPlan,
};
