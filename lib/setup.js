"use strict";

// Setup audit: what is configured, what is missing, and the exact steps to fix
// it. Nothing here ever returns a secret value — only presence booleans and
// instructions — so the audit is safe to show in the dashboard and in logs.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Google AI Studio keys look like "AIza" + 35 chars. Anything else is allowed
// (Vertex/other providers) but gets a warning instead of a silent failure later.
const GOOGLE_KEY_RE = /^AIza[0-9A-Za-z\-_]{30,45}$/;

const INSTRUCTIONS = {
  GEMINI_API_KEY: {
    title: "Gemini API key सेट करें",
    steps: [
      "https://aistudio.google.com/app/apikey खोलें और 'Create API key' दबाएँ।",
      "Key को environment variable GEMINI_API_KEY में डालें (.env फ़ाइल में, जो git में नहीं जाती)।",
      "सर्वर रीस्टार्ट करें, फिर dashboard पर 'Verify setup' दबाएँ।",
      "Key कभी भी browser, screenshot या chat में share न करें।",
    ],
    docs: "https://ai.google.dev/gemini-api/docs/api-key",
  },
  YOUTUBE_OAUTH: {
    title: "YouTube OAuth तैयार करें",
    steps: [
      "Google Cloud Console में नया project बनाएँ और 'YouTube Data API v3' enable करें।",
      "OAuth consent screen बनाएँ (External) और अपना Google account को test user जोड़ें।",
      "Credentials → 'Create credentials' → OAuth client ID → Web application।",
      "Authorized redirect URI में https://<आपका-domain>/api/youtube/callback जोड़ें।",
      "YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI और APP_SESSION_SECRET (32+ अक्षर) सेट करें।",
      "Upload हमेशा आपकी explicit permission के बिना नहीं होगा — पहले preflight चलता है।",
    ],
    docs: "https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps",
  },
  FFMPEG: {
    title: "FFmpeg install करें",
    steps: [
      "Ubuntu/Debian: sudo apt-get install -y ffmpeg",
      "या किसी भी binary का path FFMPEG_PATH में दें, जैसे FFMPEG_PATH=/usr/bin/ffmpeg।",
      "macOS: brew install ffmpeg",
    ],
    docs: "https://ffmpeg.org/download.html",
  },
  LIPSYNC_ENGINE: {
    title: "Lip-sync engine (Rhubarb) जोड़ें — optional",
    steps: [
      "npm install rhubarb-lip-sync-wasm  (MIT license, CPU-only, ~41 MB)",
      "या native binary लें और RHUBARB_PATH=/path/to/rhubarb सेट करें (ज़्यादा तेज़)।",
      "Character के mouth sprites अपलोड करें, तभी lip-sync overlay चलेगा।",
      "Engine के बिना lip-sync BLOCKED रहता है — कोई नकली animation नहीं दिखती।",
    ],
    docs: "https://github.com/DanielSWolf/rhubarb-lip-sync",
  },
  REGISTRATION_KEY: {
    title: "नए accounts के लिए registration key",
    steps: [
      "APP_REGISTRATION_KEY को एक लंबे random string पर सेट करें।",
      "इसके बिना पहले account (मालिक) के बाद कोई नया account नहीं खुलेगा।",
      "इसे उन्हीं लोगों को दें जिन्हें access चाहिए।",
    ],
    docs: null,
  },
};

function keyLooksValid(key) {
  return GOOGLE_KEY_RE.test(String(key || "").trim());
}

// Defence in depth: if a provider error ever echoes a credential, strip it
// before the message reaches a client or a log line.
function redactSecrets(text, env = process.env) {
  let out = String(text == null ? "" : text);
  for (const name of ["GEMINI_API_KEY", "YOUTUBE_CLIENT_SECRET", "APP_SESSION_SECRET", "APP_ACCESS_KEY", "APP_REGISTRATION_KEY"]) {
    const value = env[name];
    if (value && value.length > 3) out = out.split(value).join("***");
  }
  return out
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "***")
    .replace(/(key|secret|token|password)\s*[=:]\s*[^\s,;]+/gi, "$1=***");
}

function checkFileExists(file) {
  try { return Boolean(file && fs.existsSync(file) && fs.statSync(file).isFile()); }
  catch (_) { return false; }
}

function commandExists(command) {
  if (!command) return false;
  try {
    execFileSync("which", [command], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch (_) { return false; }
}

// `runtime` is injected so tests never depend on the host's real environment.
function auditSetup(runtime = {}) {
  const env = runtime.env || process.env;
  const checks = [];

  const geminiKey = String(env.GEMINI_API_KEY || "").trim();
  checks.push({
    id: "GEMINI_API_KEY",
    label: "Gemini API key",
    status: geminiKey ? (keyLooksValid(geminiKey) ? "ok" : "warn") : "blocked",
    detail: geminiKey
      ? (keyLooksValid(geminiKey) ? "configured (value hidden)" : "configured, format unusual — verify it once")
      : "not set",
    required: true,
  });

  const ffmpeg = runtime.ffmpeg || { available: false, version: null };
  checks.push({
    id: "FFMPEG",
    label: "FFmpeg binary",
    status: ffmpeg.available ? "ok" : "blocked",
    detail: ffmpeg.available ? "available " + (ffmpeg.version || "") : "not found",
    required: true,
  });

  const fontFile = runtime.fontFile || null;
  checks.push({
    id: "DEVANAGARI_FONT",
    label: "Devanagari font",
    status: checkFileExists(fontFile) ? "ok" : "warn",
    detail: checkFileExists(fontFile) ? "bundled font present" : "bundled font missing (captions may render as boxes)",
    required: false,
  });

  const youtubeReady = Boolean(runtime.youtubeReady);
  checks.push({
    id: "YOUTUBE_OAUTH",
    label: "YouTube OAuth",
    status: youtubeReady ? "ok" : "blocked",
    detail: youtubeReady ? "configured (secrets hidden)" : "not configured — upload disabled",
    required: false,
  });

  const engine = runtime.lipSync || { available: false, source: "none" };
  checks.push({
    id: "LIPSYNC_ENGINE",
    label: "Lip-sync engine (Rhubarb)",
    status: engine.available ? "ok" : "blocked",
    detail: engine.available ? "available via " + engine.source : "not installed (optional)",
    required: false,
  });

  const registration = String(env.APP_REGISTRATION_KEY || "").trim();
  checks.push({
    id: "REGISTRATION_KEY",
    label: "Registration key",
    status: registration ? "ok" : "warn",
    detail: registration ? "configured" : "not set — only the first account can be created",
    required: false,
  });

  const dataDir = runtime.dataDir || null;
  let writable = false;
  if (dataDir) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const probe = path.join(dataDir, ".write-probe-" + process.pid);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      writable = true;
    } catch (_) { writable = false; }
  }
  checks.push({
    id: "DATA_DIR",
    label: "Data directory",
    status: writable ? "ok" : "blocked",
    detail: writable ? "writable" : "not writable",
    required: true,
  });

  const missing = checks.filter(item => item.required && item.status !== "ok").map(item => item.id);
  return {
    ok: missing.length === 0,
    checks,
    missing,
    setupGuide: missing.length
      ? missing.map(id => Object.assign({ id }, INSTRUCTIONS[id] || { title: id, steps: [] }))
      : [],
    note: "कोई secret value कभी भी dashboard या API response में नहीं दिखती।",
  };
}

function setupGuideFor(id) {
  return INSTRUCTIONS[id] || null;
}

module.exports = { auditSetup, redactSecrets, keyLooksValid, setupGuideFor, INSTRUCTIONS, commandExists };
