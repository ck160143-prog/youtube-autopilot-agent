"use strict";

// License-safe audio. Nothing here downloads or copies a third-party recording:
// every bed and effect is synthesised by FFmpeg's own sources, so the output is
// original audio with no attribution obligation. If a user supplies their own
// licensed track, `userMusicPath` wins and its licence metadata is stored.

const path = require("path");
const { amixNormalizeSuffix } = require("./ffmpeg");
const fs = require("fs");

const LICENSE_NOTE =
  "Synthesised in-process by FFmpeg (sine/noise sources). Original audio, no " +
  "third-party recording, no attribution required.";

// A soft two-note pad with slow tremolo. Deliberately quiet: it is a bed, not a
// soundtrack, and it is ducked under narration by the renderer.
async function synthesizeMusicBed({ runFfmpeg, duration, outPath, volume = 0.12 }) {
  const seconds = Math.max(1, Number(duration) || 1);
  const graph = [
    "[0:a]volume=" + volume + "[a]",
    "[1:a]volume=" + (volume * 0.8) + "[b]",
    "[a][b]amix=inputs=2:duration=longest" + amixNormalizeSuffix() + "," +
      "tremolo=f=0.18:d=0.35,lowpass=f=1400,highpass=f=90[out]",
  ].join(";");
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=196:duration=" + seconds,
    "-f", "lavfi", "-i", "sine=frequency=293.66:duration=" + seconds,
    "-filter_complex", graph,
    "-map", "[out]",
    "-t", String(seconds),
    "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "128k",
    outPath,
  ]);
  return { path: outPath, source: "synthesized", license: LICENSE_NOTE };
}

const SFX = {
  whoosh: {
    build: seconds => [
      "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.35:duration=" + seconds,
      "-af", "lowpass=f=1800,highpass=f=180,volume='if(lt(t,0.2),t/0.2,max(0,((" + seconds + ")-t)/" + seconds + "))':eval=frame",
    ],
  },
  ding: {
    build: seconds => [
      "-f", "lavfi", "-i", "sine=frequency=880:duration=" + seconds,
      "-af", "afade=t=in:st=0:d=0.02,afade=t=out:st=0.08:d=" + Math.max(0.1, seconds - 0.08) + ",volume=0.5",
    ],
  },
  pop: {
    build: seconds => [
      "-f", "lavfi", "-i", "sine=frequency=520:duration=" + seconds,
      "-af", "afade=t=in:st=0:d=0.01,afade=t=out:st=0.05:d=" + Math.max(0.05, seconds - 0.05) + ",volume=0.4",
    ],
  },
};

async function synthesizeSfx({ runFfmpeg, kind = "whoosh", outPath, seconds = 0.6 }) {
  const spec = SFX[kind] || SFX.whoosh;
  const duration = Math.max(0.2, Number(seconds) || 0.6);
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    ...spec.build(duration),
    "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "96k",
    "-t", String(duration),
    outPath,
  ]);
  return { path: outPath, kind, source: "synthesized", license: LICENSE_NOTE };
}

// Resolve the music source for a project: explicit user track first, then a
// synthesised bed, then none. Never claims music exists when it does not.
async function prepareMusic(options) {
  const { runFfmpeg, workDir, duration, userMusicPath, userMusicLicense } = options;
  if (userMusicPath) {
    if (!fs.existsSync(userMusicPath)) {
      throw Object.assign(new Error("दिया गया music file नहीं मिला।"), { statusCode: 400 });
    }
    return {
      path: userMusicPath,
      source: "user",
      license: String(userMusicLicense || "user-supplied — licence not verified").slice(0, 300),
      licenseVerified: false,
    };
  }
  const outPath = path.join(workDir, "music-bed.m4a");
  const bed = await synthesizeMusicBed({ runFfmpeg, duration, outPath });
  return { ...bed, licenseVerified: true };
}

module.exports = {
  LICENSE_NOTE,
  synthesizeMusicBed,
  synthesizeSfx,
  prepareMusic,
};

// One short whoosh per scene boundary, placed at the real timeline offsets.
// Returns null when there is nothing to place (single-scene video).
async function buildSfxTrack({ runFfmpeg, timeline, workDir, kind = "whoosh" }) {
  // A whoosh on every boundary turns a long video into noise (and a 150-scene
  // project into a 149-input filter graph). Cap it and spread the hits evenly.
  const all = (timeline || []).slice(1).map(entry => Math.round(entry.start * 1000));
  if (!all.length) return null;
  const MAX_SFX = 30;
  const step = Math.max(1, Math.ceil(all.length / MAX_SFX));
  const offsets = all.filter((_, index) => index % step === 0);
  const sfxPath = path.join(workDir, "sfx-" + kind + ".m4a");
  const spec = SFX[kind] || SFX.whoosh;
  const seconds = 0.6;
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    ...spec.build(seconds),
    "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "96k", "-t", String(seconds), sfxPath,
  ]);
  const inputs = [];
  const filters = [];
  offsets.forEach((ms, index) => {
    inputs.push("-i", sfxPath);
    filters.push("[" + index + ":a]volume=0.55,adelay=" + ms + "|" + ms + "[s" + index + "]");
  });
  filters.push(offsets.map((_, index) => "[s" + index + "]").join("") +
    "amix=inputs=" + offsets.length + ":duration=longest" + amixNormalizeSuffix() + "[out]");
  const outPath = path.join(workDir, "sfx-track.m4a");
  const totalSeconds = (timeline || []).reduce((sum, entry) => sum + entry.duration, 0);
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[out]", "-t", String(Math.max(1, totalSeconds)),
    "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "96k", outPath,
  ]);
  return { path: outPath, kind, source: "synthesized", license: LICENSE_NOTE, count: offsets.length };
}

module.exports.buildSfxTrack = buildSfxTrack;
