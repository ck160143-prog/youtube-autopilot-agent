"use strict";

// Lip-sync analysis. Rhubarb Lip Sync (MIT) turns narration into a timeline of
// mouth shapes (A-H = vowels/consonants, X = closed). Two engines are supported:
//   1. the native binary (RHUBARB_PATH or `rhubarb` on PATH) — fast, preferred
//   2. the WASM build (`rhubarb-lip-sync-wasm`, MIT) — no native binary needed
// With neither installed this module refuses to guess: no engine, no cues.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const MOUTH_SHAPES = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];
const MAX_CUES = 400;
const MAX_AUDIO_SECONDS = 120;

let wasmModulePromise = null;

function resolveEngine(runtime = {}) {
  const explicit = runtime.rhubarbPath !== undefined ? runtime.rhubarbPath : process.env.RHUBARB_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return { source: "native", binary: explicit, label: "Rhubarb (native binary)" };
  }
  const onPath = runtime.whichRhubarb ? runtime.whichRhubarb() : which("rhubarb");
  if (onPath) {
    return { source: "native", binary: onPath, label: "Rhubarb (native binary)" };
  }
  try {
    const resolved = require.resolve("rhubarb-lip-sync-wasm");
    return { source: "wasm", packagePath: resolved, label: "Rhubarb (WASM)" };
  } catch (_) {
    return null;
  }
}

function which(command) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function engineLabel() {
  const engine = resolveEngine();
  return engine ? engine.label : null;
}

async function loadWasm() {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const mod = require("rhubarb-lip-sync-wasm");
      const Rhubarb = mod.Rhubarb || (mod.default && mod.default.Rhubarb);
      if (!Rhubarb) throw new Error("rhubarb-lip-sync-wasm में Rhubarb class नहीं मिली।");
      return Rhubarb;
    })();
  }
  return wasmModulePromise;
}

function normaliseCues(raw, durationSeconds) {
  const cues = (Array.isArray(raw) ? raw : [])
    .map(item => ({
      start: Math.max(0, Number(item.start) || 0),
      end: Math.max(0, Number(item.end) || 0),
      value: String(item.value || "X").toUpperCase().slice(0, 2),
    }))
    .filter(item => MOUTH_SHAPES.includes(item.value) && item.end > item.start)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_CUES);

  // Merge consecutive identical shapes so a scene needs fewer overlay inputs.
  const merged = [];
  for (const cue of cues) {
    const previous = merged[merged.length - 1];
    if (previous && previous.value === cue.value && cue.start - previous.end < 0.06) {
      previous.end = cue.end;
    } else {
      merged.push({ start: cue.start, end: cue.end, value: cue.value });
    }
  }
  return merged;
}

async function analyseWithNative(engine, wavPath, options) {
  const args = ["--outputFormat", "json", "--extendedShapes", "Georgia"];
  if (options.dialogText) {
    args.push("--dialogFile", options.dialogFile);
  }
  args.push(wavPath);
  const { stdout } = await execFileAsync(engine.binary, args, {
    timeout: options.timeoutMs || 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  const duration = parsed && parsed.timeLength ? Number(parsed.timeLength) : 0;
  return { raw: (parsed && parsed.mouthCues) || [], duration };
}

// The WASM build wants raw 16 kHz mono PCM, so any narration format is
// converted first — never assumed.
async function analyseWithWasm(wavPath, options) {
  const runFfmpeg = options.runFfmpeg;
  if (!runFfmpeg) {
    throw Object.assign(new Error("WASM lip-sync के लिए FFmpeg चाहिए।"), { statusCode: 503 });
  }
  const pcmPath = wavPath + ".lip-sync.pcm";
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y", "-i", wavPath,
    "-ac", "1", "-ar", "16000", "-f", "s16le", pcmPath,
  ], { timeout: 120000 });
  let pcm;
  try {
    pcm = fs.readFileSync(pcmPath);
  } finally {
    fs.rmSync(pcmPath, { force: true });
  }
  const Rhubarb = await loadWasm();
  const result = await Rhubarb.getLipSync(pcm, { dialogText: options.dialogText || "" });
  const duration = pcm.length / (16000 * 2);
  return { raw: (result && result.mouthCues) || [], duration };
}

/**
 * Analyse one narration file and return a mouth-cue timeline.
 * Throws NO_LIPSYNC_ENGINE (statusCode 503) when nothing can do the analysis.
 */
async function analyseAudio(options) {
  const wavPath = options.audioPath;
  const runFfmpeg = options.runFfmpeg;
  if (!wavPath || !fs.existsSync(wavPath)) {
    throw Object.assign(new Error("Lip-sync के लिए audio फ़ाइल नहीं मिली।"), { statusCode: 409 });
  }
  // `engine: false` forces the no-engine path (used by tests and by callers
  // that want to prove the blocked state).
  const engine = options.engine === false ? null : (options.engine || resolveEngine(options));
  if (!engine) {
    const error = new Error(
      "Lip-sync engine installed नहीं है। npm install rhubarb-lip-sync-wasm " +
      "या RHUBARB_PATH सेट करें। इसके बिना lip-sync BLOCKED रहता है।"
    );
    error.code = "NO_LIPSYNC_ENGINE";
    error.statusCode = 503;
    throw error;
  }

  let dialogFile = null;
  if (options.dialogText) {
    dialogFile = path.join(path.dirname(wavPath), "dialog-" + Date.now() + ".txt");
    fs.writeFileSync(dialogFile, String(options.dialogText).slice(0, 4000), "utf8");
  }
  let outcome;
  try {
    outcome = engine.source === "native"
      ? await analyseWithNative(engine, wavPath, { dialogFile, timeoutMs: options.timeoutMs })
      : await analyseWithWasm(wavPath, { dialogText: options.dialogText, runFfmpeg });
  } catch (error) {
    if (error.code === "NO_LIPSYNC_ENGINE") throw error;
    throw Object.assign(
      new Error("Lip-sync analysis विफल: " + String(error.message || error).slice(0, 200)),
      { statusCode: 502 }
    );
  } finally {
    if (dialogFile) fs.rmSync(dialogFile, { force: true });
  }

  const cues = normaliseCues(outcome.raw, outcome.duration);
  return {
    cues,
    engine: engine.source,
    durationSeconds: Math.round((outcome.duration || (cues.length ? cues[cues.length - 1].end : 0)) * 1000) / 1000,
    shapes: Array.from(new Set(cues.map(cue => cue.value))),
    source: "Rhubarb Lip Sync (MIT)",
  };
}

// Cues are cached beside the narration so a re-render never re-analyses.
function cachedCuePath(audioPath) {
  return String(audioPath) + ".lipsync.json";
}

async function analyseAudioCached(options) {
  const cache = cachedCuePath(options.audioPath);
  if (options.useCache !== false && fs.existsSync(cache)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cache, "utf8"));
      if (parsed && Array.isArray(parsed.cues)) {
        return Object.assign({}, parsed, { cached: true });
      }
    } catch (_) { /* corrupt cache: recompute */ }
  }
  const result = await analyseAudio(options);
  try {
    fs.writeFileSync(cache, JSON.stringify(result));
  } catch (_) { /* cache is best effort */ }
  return result;
}

module.exports = {
  MOUTH_SHAPES,
  resolveEngine,
  engineLabel,
  analyseAudio,
  analyseAudioCached,
  cachedCuePath,
  normaliseCues,
  MAX_AUDIO_SECONDS,
};
