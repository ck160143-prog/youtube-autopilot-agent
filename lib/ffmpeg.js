"use strict";

// FFmpeg resolution + process helpers shared by the Phase 1 slideshow and the
// Phase 2 project renderer. Resolution order:
//   1. FFMPEG_PATH (explicit override, used by tests and constrained hosts)
//   2. ffmpeg-static (bundled dependency, downloaded at install time)
//   3. "ffmpeg" on PATH
// Nothing here reports success unless the binary actually ran.

const { execFile } = require("child_process");
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

async function runFfmpeg(args, options = {}) {
  const bin = resolveFfmpegPath();
  // -nostdin keeps FFmpeg from waiting on a terminal when a filter or a
  // missing font makes it interactive; without it a bad filter graph can hang
  // a render worker forever.
  const safeArgs = args[0] === "-nostdin" ? args : ["-nostdin", ...args];
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
  runFfmpeg,
  ffmpegAvailable,
  ffmpegVersion,
  parseDurationSeconds,
  probe,
};
