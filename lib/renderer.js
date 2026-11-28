"use strict";

// Phase 2 renderer. Real FFmpeg only: Ken Burns camera motion per scene, fade
// transitions, concat chunking (bounded memory + resume), music ducking, and
// caption burn-in with a soft-subtitle fallback. Every step writes a file and
// is probed before it is trusted.

const fs = require("fs");
const path = require("path");

const { probe, amixNormalizeSuffix, apadFilter } = require("./ffmpeg");

// Encoding preset is a knob, not a constant: constrained free hosts can drop to
// ultrafast without editing code, and CI can stay fast.
function encodePreset() {
  return process.env.FFMPEG_PRESET || "veryfast";
}
const captions = require("./captions");
const media = require("./media");

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

function zoomExpression(motion) {
  switch (motion) {
    case "kenburns-in":
      return "min(zoom+0.0008,1.15)";
    case "kenburns-out":
      return "if(eq(on,1),1.15,max(zoom-0.0008,1.0))";
    case "pan":
      return "1.12";
    // Parallax keeps a smaller zoom so the shifted copy in front still covers
    // the frame; the depth comes from the two layers moving differently.
    case "parallax":
    case "parallax-reverse":
      return "1.08";
    case "none":
    default:
      return "1.0";
  }
}

// Two-and-a-half-D: the scene image is used twice, the front copy slightly
// larger and drifting at a different speed from the back one. To a viewer that
// reads as depth (the "multi-plane camera" trick used by animation studios),
// and it costs one extra filter pass instead of a 3D engine.
//
// It is deliberately honest: this is a parallax illusion over a still image,
// not a modelled 3D scene, and nothing claims otherwise.
function parallaxFilters({ motion, seconds, width, height, fps }) {
  const frames = Math.max(1, Math.round(seconds * fps));
  const drift = motion === "parallax-reverse" ? "-1" : "1";
  const backZoom = "1.06";
  const backX = "iw/2-(iw/zoom/2)";
  const frontZoom = "1.16";
  // The front layer travels about three times as far as the back one.
  const frontX = "(iw-iw/zoom)*(0.5+" + drift + "*0.5*on/" + frames + ")";
  const pre = "scale=" + (width * 2) + ":" + (height * 2) + ":force_original_aspect_ratio=increase,crop=" + (width * 2) + ":" + (height * 2);
  return [
    "[0:v]" + pre + ",split=2[pl_back][pl_front_src]",
    "[pl_back]zoompan=z='" + backZoom + "':d=1:x='" + backX + "':y='ih/2-(ih/zoom/2)':s=" + width + "x" + height + ":fps=" + fps + "[pl_back_out]",
    "[pl_front_src]zoompan=z='" + frontZoom + "':d=1:x='" + frontX + "':y='ih/2-(ih/zoom/2)':s=" + width + "x" + height + ":fps=" + fps + "[pl_front_out]",
    // The front layer is feathered so its edge is never a visible rectangle.
    "[pl_front_out]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*(1-pow(abs(X/W-0.5)*2,3))'[pl_front_alpha]",
    "[pl_back_out][pl_front_alpha]overlay=0:0:format=auto[pl_merged]",
  ];
}

async function renderSceneClip(options) {
  const {
    runFfmpeg, imagePath, audioPath, duration, layout,
    motion = "kenburns-in", transition = "fade", outPath,
  } = options;
  const seconds = Math.max(0.4, Number(duration) || 2);
  const { width, height, fps } = layout;
  const zoom = zoomExpression(motion);
  const x = motion === "pan" ? "(iw-iw/zoom)*(on/" + Math.max(1, Math.round(seconds * fps)) + ")" : "iw/2-(iw/zoom/2)";
  const useParallax = motion === "parallax" || motion === "parallax-reverse";
  // Tail applied to whatever the camera stage produced: scene fades + the
  // pixel format the encoder needs.
  const tail = [];
  if (transition === "fade" && seconds > 0.8) {
    const fade = 0.3;
    tail.push("fade=t=in:st=0:d=" + fade);
    tail.push("fade=t=out:st=" + Math.max(0, seconds - fade).toFixed(3) + ":d=" + fade);
  }
  tail.push("format=yuv420p");
  const tailText = tail.join(",");

  let filterArgs;
  if (useParallax) {
    // split/overlay needs a complex graph; a simple -vf cannot have two outputs.
    const graph = parallaxFilters({ motion, seconds, width, height, fps })
      .concat("[pl_merged]" + tailText + "[vout]")
      .join(";");
    filterArgs = ["-filter_complex", graph, "-map", "[vout]"];
  } else {
    const filters = [
      "scale=" + width * 2 + ":" + height * 2 + ":force_original_aspect_ratio=increase",
      "crop=" + width * 2 + ":" + height * 2,
      "zoompan=z='" + zoom + "':d=1:x='" + x + "':y='ih/2-(ih/zoom/2)':s=" + width + "x" + height + ":fps=" + fps,
      tailText,
    ];
    filterArgs = ["-vf", filters.join(","), "-map", "0:v"];
  }

  const args = [
    "-hide_banner", "-loglevel", "error",
    "-loop", "1", "-framerate", String(fps), "-t", String(seconds), "-i", imagePath,
  ];
  if (audioPath) args.push("-i", audioPath);
  else args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");

  args.push(
    ...filterArgs,
    "-map", "1:a",
    "-c:v", "libx264", "-preset", encodePreset(), "-crf", "23", "-pix_fmt", "yuv420p",
    // Narration is usually shorter than the stretched scene: pad it with
    // silence instead of letting -shortest truncate the video.
    "-af", apadFilter(seconds),
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
    "-t", String(seconds),
    "-movflags", "+faststart",
    outPath
  );
  await runFfmpeg(args, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  const info = await probe(outPath);
  if (!info.hasVideo || !info.size) {
    throw Object.assign(new Error("FFmpeg ने scene clip नहीं बनाई।"), { statusCode: 500 });
  }
  return { path: outPath, ...info };
}

async function concatClips({ runFfmpeg, paths, outPath, cwd }) {
  if (!paths.length) throw Object.assign(new Error("जोड़ने के लिए कोई clip नहीं।"), { statusCode: 400 });
  const listPath = path.join(cwd, "concat-" + Date.now() + ".txt");
  const body = paths.map(p => "file '" + path.basename(p).replace(/'/g, "'\\''") + "'").join("\n") + "\n";
  await fs.promises.writeFile(listPath, body, "utf8");
  try {
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-y", "-f", "concat", "-safe", "0", "-i", path.basename(listPath),
      "-c", "copy", "-movflags", "+faststart", outPath,
    ], { cwd, timeout: 600000 });
  } finally {
    await fs.promises.rm(listPath, { force: true }).catch(() => {});
  }
  const info = await probe(outPath);
  if (!info.hasVideo || !info.size) {
    throw Object.assign(new Error("FFmpeg concat विफल रहा।"), { statusCode: 500 });
  }
  return { path: outPath, ...info };
}

// Duck the music bed under narration using the voice as the sidechain, then
// lay the transition sound effects on top.
async function mixAudio({ runFfmpeg, videoPath, musicPath, sfxPath, outPath, musicVolume = 0.16, sfxVolume = 0.5 }) {
  const inputs = ["-i", videoPath];
  // FFmpeg before 5 refuses to use one input stream twice inside a filtergraph
  // ("Invalid stream specifier"), so the voice is split — but only when both the
  // sidechain and the mix consume it, because an unused asplit output is itself
  // an error ("unconnected output").
  const splitVoice = Boolean(musicPath);
  const graph = [splitVoice
    ? "[0:a]aresample=44100,aformat=channel_layouts=stereo,asplit=2[voice][voice2]"
    : "[0:a]aresample=44100,aformat=channel_layouts=stereo[voice]"];
  let audioMap = "[voice]";
  if (musicPath) {
    inputs.push("-i", musicPath);
    const musicIndex = inputs.length / 2 - 1;
    graph.push("[" + musicIndex + ":a]volume=" + musicVolume +
      ",aresample=44100,aformat=channel_layouts=stereo[music]");
    graph.push("[music][voice]sidechaincompress=threshold=0.03:ratio=12:attack=15:release=350[ducked]");
    graph.push("[voice2][ducked]amix=inputs=2:duration=first:dropout_transition=0" + amixNormalizeSuffix() + "[bed]");
    audioMap = "[bed]";
  }
  if (sfxPath) {
    inputs.push("-i", sfxPath);
    const sfxIndex = inputs.length / 2 - 1;
    graph.push("[" + sfxIndex + ":a]volume=" + sfxVolume +
      ",aresample=44100,aformat=channel_layouts=stereo[sfx]");
    graph.push("[" + audioMap.slice(1, -1) + "][sfx]amix=inputs=2:duration=first:dropout_transition=0" + amixNormalizeSuffix() + "[mixed]");
    audioMap = "[mixed]";
  }
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "0:v", "-map", audioMap,
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    outPath,
  ], { timeout: 600000 });
  return { path: outPath, ...(await probe(outPath)) };
}

async function burnCaptions({ runFfmpeg, videoPath, assPath, outPath, cwd, fontsDir }) {
  // fontsdir is what makes Devanagari render as glyphs instead of boxes on a
  // host with no system fonts.
  const assFilter = fontsDir
    ? "ass=filename='" + path.resolve(cwd, assPath) + "':fontsdir='" + fontsDir + "'"
    : "ass=" + assPath;
  const attempts = [
    { mode: "burned", filter: assFilter },
    { mode: "burned", filter: "subtitles=" + assPath },
  ];
  for (const attempt of attempts) {
    try {
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error",
        "-i", path.resolve(cwd, videoPath),
        "-vf", attempt.filter,
        "-c:v", "libx264", "-preset", encodePreset(), "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        outPath,
      ], { cwd, timeout: 180000 });
      // ffmpeg ran with cwd = workDir, so the file must be probed absolutely.
      const info = await probe(path.resolve(cwd, outPath));
      if (info.hasVideo && info.size) {
        return { mode: attempt.mode, path: path.resolve(cwd, outPath), ...info };
      }
    } catch (_) {
      /* try the next caption strategy */
    }
  }
  // Last resort: keep captions as a selectable track instead of burning them.
  try {
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-i", path.resolve(cwd, videoPath), "-i", path.resolve(cwd, assPath),
      "-map", "0", "-map", "1",
      "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
      "-metadata:s:s:0", "language=hin",
      outPath,
    ], { cwd, timeout: 120000 });
    const info = await probe(path.resolve(cwd, outPath));
    if (info.size) return { mode: "soft", path: path.resolve(cwd, outPath), ...info };
  } catch (_) {
    /* captions unavailable on this host */
  }
  return { mode: "none", path: path.resolve(cwd, videoPath), ...(await probe(path.resolve(cwd, videoPath))) };
}

function isUsableClip(file, minDuration) {
  try {
    if (!fs.existsSync(file)) return false;
    const size = fs.statSync(file).size;
    return size > 1024;
  } catch (_) {
    return false;
  }
}

// Full project render. Idempotent: clips and chunks that already exist and are
// usable are reused, so a failed or cancelled render resumes instead of
// restarting from scene 1.
async function renderProject(options) {
  const {
    project, workDir, runFfmpeg, layout, timeline, scenes,
    motion = "kenburns-in", transition = "fade", perChunk = 10,
    music = true, burnSubtitles = true, resume = true, keepIntermediates = false,
    onProgress = () => {},
  } = options;

  const clipsDir = await ensureDir(path.join(workDir, "clips"));
  const chunksDir = await ensureDir(path.join(workDir, "chunks"));
  const total = (timeline || []).length;
  let completed = 0;

  const clipPaths = [];
  for (let i = 0; i < total; i++) {
    const entry = timeline[i];
    const scene = scenes.find(item => Number(item.index) === Number(entry.index)) || {};
    const clipPath = path.join(clipsDir, "scene-" + String(entry.index).padStart(4, "0") + ".mp4");
    if (resume && isUsableClip(clipPath)) {
      let finalClip = clipPath;
      if (typeof options.afterSceneClip === "function") {
        const replaced = await options.afterSceneClip({ clipPath, entry, scene, layout, workDir, resumed: true });
        if (replaced && replaced.path) finalClip = replaced.path;
      }
      clipPaths.push(finalClip);
      completed++;
      onProgress({ stage: "rendering", percent: Math.round((completed / total) * 80), message: "scene " + entry.index + " resume से skip" });
      continue;
    }
    const image = project.assets && project.assets.scenes && project.assets.scenes[entry.index] &&
      project.assets.scenes[entry.index].image;
    const audio = project.assets && project.assets.scenes && project.assets.scenes[entry.index] &&
      project.assets.scenes[entry.index].audio;
    if (!image || !fs.existsSync(image.path)) {
      throw Object.assign(new Error("दृश्य " + entry.index + " की image उपलब्ध नहीं है।"), { statusCode: 409 });
    }
    onProgress({
      stage: "rendering",
      percent: Math.round((completed / total) * 80),
      message: "scene " + entry.index + "/" + total + " render हो रहा है",
      scene: entry.index,
      total,
    });
    await renderSceneClip({
      runFfmpeg,
      imagePath: image.path,
      audioPath: audio && fs.existsSync(audio.path) ? audio.path : null,
      duration: entry.duration,
      layout,
      motion: (scene.motion || motion),
      transition: (scene.transition || transition),
      outPath: clipPath,
    });
    // Optional per-scene post-process (2D mouth overlay). The hook may return a
    // different clip path; the original stays on disk so a retry can reuse it.
    let finalClip = clipPath;
    if (typeof options.afterSceneClip === "function") {
      const replaced = await options.afterSceneClip({ clipPath, entry, scene, layout, workDir });
      if (replaced && replaced.path) finalClip = replaced.path;
    }
    clipPaths.push(finalClip);
    completed++;
  }

  // Chunked concat: each chunk is encoded independently, then the chunks are
  // stream-copied together. Keeps peak memory bounded for 150-scene projects.
  const chunks = [];
  for (let start = 0; start < clipPaths.length; start += perChunk) {
    const slice = clipPaths.slice(start, start + perChunk);
    const chunkPath = path.join(chunksDir, "chunk-" + String(Math.floor(start / perChunk) + 1).padStart(3, "0") + ".mp4");
    if (!(resume && isUsableClip(chunkPath))) {
      await concatClips({ runFfmpeg, paths: slice, outPath: chunkPath, cwd: clipsDir });
    }
    chunks.push(chunkPath);
    onProgress({
      stage: "rendering",
      percent: 80 + Math.round((chunks.length / Math.ceil(clipPaths.length / perChunk)) * 8),
      message: "chunk " + chunks.length + " जुड़ रहा है",
    });
  }

  const timelinePath = path.join(workDir, "timeline.mp4");
  await concatClips({ runFfmpeg, paths: chunks, outPath: timelinePath, cwd: chunksDir });
  onProgress({ stage: "rendering", percent: 88, message: "timeline तैयार, audio mix चल रहा है" });

  let current = timelinePath;
  let musicInfo = null;
  let sfxInfo = null;
  if (music) {
    const totalSeconds = (timeline || []).reduce((sum, item) => sum + item.duration, 0);
    musicInfo = await media.prepareMusic({
      runFfmpeg,
      workDir,
      duration: totalSeconds,
      userMusicPath: options.userMusicPath,
      userMusicLicense: options.userMusicLicense,
    });
  }
  if (options.soundEffects !== false) {
    sfxInfo = await media.buildSfxTrack({ runFfmpeg, timeline, workDir });
  }
  if (musicInfo || sfxInfo) {
    const mixedPath = path.join(workDir, "mixed.mp4");
    const mixed = await mixAudio({
      runFfmpeg, videoPath: current,
      musicPath: musicInfo ? musicInfo.path : null,
      sfxPath: sfxInfo ? sfxInfo.path : null,
      outPath: mixedPath,
      musicVolume: options.musicVolume, sfxVolume: options.sfxVolume,
    });
    current = mixed.path;
    onProgress({ stage: "rendering", percent: 94, message: "background music और sound effects mix हो गए" });
  }

  let captionResult = { mode: "none", path: current };
  if (burnSubtitles) {
    const cues = captions.buildSegments(captions.segmentsFromTimeline(timeline, scenes));
    if (cues.length) {
      const assPath = path.join(workDir, "captions.ass");
      await fs.promises.writeFile(assPath, captions.buildAss(cues, {
        width: layout.width, height: layout.height, font: options.captionFont,
      }), "utf8");
      const captionedPath = path.join(workDir, "final.mp4");
      captionResult = await burnCaptions({
        runFfmpeg, videoPath: path.basename(current), assPath: "captions.ass",
        outPath: path.basename(captionedPath), cwd: workDir,
        fontsDir: options.fontsDir,
      });
      if (captionResult.mode !== "none") current = captionResult.path;
    }
  }

  const final = await probe(current);
  // Reclaim disk only after the file is verified: a failed probe must leave
  // every intermediate in place so the render can be resumed.
  const cleaned = keepIntermediates ? [] : await cleanupIntermediates(workDir, current);
  onProgress({ stage: "completed", percent: 100, message: "MP4 तैयार" });
  return {
    videoPath: current,
    cleanedFiles: cleaned.map(item => item.path),
    cleanedBytes: cleaned.reduce((sum, item) => sum + item.bytes, 0),
    size: final.size,
    duration: final.duration,
    hasVideo: final.hasVideo,
    hasAudio: final.hasAudio,
    captions: captionResult.mode,
    music: musicInfo ? { source: musicInfo.source, license: musicInfo.license, licenseVerified: musicInfo.licenseVerified } : null,
    soundEffects: sfxInfo ? { source: sfxInfo.source, kind: sfxInfo.kind, count: sfxInfo.count, license: sfxInfo.license } : null,
    chunks: chunks.length,
    scenes: total,
  };
}

// Intermediates are pure waste once the final MP4 exists. Measured on a real
// 1-minute project: 8.32 MB left behind for a 2.03 MB video (4.1x), of which
// clips/chunks/timeline/mixed/music accounted for 5.7 MB. Keeping them costs
// disk on every project forever and, on an ephemeral 512 MB host, is the
// difference between working for a week and working for a day.
//
// Only paths this function itself created are removed, and a failure to delete
// never fails the render: the video is already correct at this point.
const INTERMEDIATE_FILES = ["timeline.mp4", "mixed.mp4", "music-bed.m4a", "sfx-track.m4a", "sfx-whoosh.m4a", "captions.ass"];
const INTERMEDIATE_DIRS = ["clips", "chunks"];

async function cleanupIntermediates(workDir, keepPath) {
  const removed = [];
  const kept = keepPath ? path.resolve(keepPath) : null;
  const drop = async target => {
    try {
      if (!fs.existsSync(target)) return;
      if (kept && path.resolve(target) === kept) return;
      const stat = fs.statSync(target);
      await fs.promises.rm(target, { recursive: stat.isDirectory(), force: true });
      removed.push({ path: path.basename(target), bytes: stat.isDirectory() ? 0 : stat.size });
    } catch (_) {
      /* a leftover file must never fail a finished render */
    }
  };
  for (const name of INTERMEDIATE_FILES) await drop(path.join(workDir, name));
  for (const name of INTERMEDIATE_DIRS) await drop(path.join(workDir, name));
  return removed;
}

module.exports = {
  encodePreset,
  renderSceneClip,
  concatClips,
  mixAudio,
  burnCaptions,
  renderProject,
  cleanupIntermediates,
  INTERMEDIATE_FILES,
  INTERMEDIATE_DIRS,
};
