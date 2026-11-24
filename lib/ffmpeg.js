"use strict";

// FFmpeg resolution + process helpers shared by the Phase 1 slideshow and the
// Phase 2 project renderer. Resolution order:
//   1. FFMPEG_PATH (explicit override, used by tests and constrained hosts)
//   2. ffmpeg-static (bundled dependency, downloaded at install time)
//   3. "ffmpeg" on PATH
// Nothing here reports success unless the binary actually ran.

const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

let cachedPath = null;

function resolveFfmpegPath() {
  if (cachedPath) return cachedPath;
  if (process.env.FFMPEG_PATH) {
    cachedPath = process.env.FFMPEG_PATH;
    return cachedPath;
  }
  try {
    const bundled = require("ffmpeg-static");
    // ffmpeg-static returns a path even when its install script could not
    // download the binary, so existence is verified before trusting it.
    if (bundled && require("fs").existsSync(bundled)) {
      cachedPath = bundled;
      return cachedPath;
    }
  } catch (_) {
    /* ffmpeg-static may be missing entirely */
  }
  cachedPath = "ffmpeg";
  return cachedPath;
}

// Synchronous probe: lets a test file declare an honest skip at module load,
// before any hook runs. A path that merely resolves (the "ffmpeg" fallback) is
// not evidence that a binary exists.
function ffmpegAvailableSync() {
  const bin = resolveFfmpegPath();
  if (bin === "ffmpeg") {
    try {
      execFileSync("which", ["ffmpeg"], { stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch (_) {
      return false;
    }
  }
  return require("fs").existsSync(bin);
}

let cachedVersion = null;

// Synchronous version probe, cached: filter graphs must be built before any
// ffmpeg process starts, and some options only exist on newer builds.
function ffmpegVersionSync() {
  if (cachedVersion !== null) return cachedVersion;
  const bin = resolveFfmpegPath();
  try {
    const stdout = execFileSync(bin, ["-version"], {
      encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"],
    });
    const match = String(stdout || "").match(/ffmpeg version ([^\s]+)/i);
    cachedVersion = match ? match[1].replace(/^n(?=\d)/, "") : "";
  } catch (_) {
    cachedVersion = "";
  }
  return cachedVersion;
}

// `normalize` exists on amix only from FFmpeg 5. Older builds reject the whole
// filter graph, which would fail the render instead of degrading the mix.
function amixNormalizeSuffix() {
  const major = Number((String(ffmpegVersionSync()).match(/^(\d+)/) || [])[1]);
  return Number.isFinite(major) && major >= 5 ? ":normalize=0" : "";
}

// `apad=whole_dur=` exists only from FFmpeg 4.3. On older builds the audio is
// padded with the plain filter and the existing `-t` on the same command caps
// the stream, which is exactly the same result.
function apadFilter(seconds) {
  const match = String(ffmpegVersionSync()).match(/^(\d+)\.(\d+)/);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  const modern = major > 4 || (major === 4 && minor >= 3);
  return modern ? "apad=whole_dur=" + seconds : "apad";
}

async function runFfmpeg(args, options = {}) {
  const bin = resolveFfmpegPath();
  // -nostdin keeps FFmpeg from waiting on a terminal when a filter or a
  // missing font makes it interactive; without it a bad filter graph can hang
  // a render worker forever.
  let safeArgs = args[0] === "-nostdin" ? args : ["-nostdin", ...args];
  // Outputs go into our own render/temp directories, and a retry must never
  // abort just because a previous attempt left a file behind.
  if (!safeArgs.includes("-y") && !safeArgs.includes("-n")) safeArgs = ["-y", ...safeArgs];
  return execFileAsync(bin, safeArgs, {
    cwd: options.cwd || process.cwd(),
    timeout: options.timeout || 300000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    windowsHide: true,
  });
}

async function ffmpegAvailable() {
  try {
    const { stdout } = await runFfmpeg(["-version"], { timeout: 15000 });
    return /ffmpeg version/i.test(String(stdout || ""));
  } catch (_) {
    return false;
  }
}

async function ffmpegVersion() {
  try {
    const { stdout } = await runFfmpeg(["-version"], { timeout: 15000 });
    const match = String(stdout || "").match(/ffmpeg version ([^\s]+)/i);
    // Some builds print "n9.0.2-..." (git describe prefix) — trim the "n".
    return match ? match[1].replace(/^n(?=\d)/, "") : "unknown";
  } catch (_) {
    return null;
  }
}

function parseDurationSeconds(text) {
  const match = String(text || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// ffmpeg writes stream info to stderr; that is the only probe we need and it
// avoids a hard dependency on a separate ffprobe binary.
async function probe(file) {
  const bin = resolveFfmpegPath();
  let stderr = "";
  try {
    await execFileAsync(bin, ["-hide_banner", "-i", file], { timeout: 30000 });
  } catch (error) {
    stderr = String((error && error.stderr) || "");
  }
  const duration = parseDurationSeconds(stderr);
  return {
    duration,
    hasVideo: /Stream #\d+:\d+.*Video:/i.test(stderr),
    hasAudio: /Stream #\d+:\d+.*Audio:/i.test(stderr),
    size: require("fs").statSync(file).size,
  };
}

module.exports = {
  resolveFfmpegPath,
  ffmpegAvailableSync,
  ffmpegVersionSync,
  amixNormalizeSuffix,
  apadFilter,
  runFfmpeg,
  ffmpegAvailable,
  ffmpegVersion,
  parseDurationSeconds,
  probe,
};
