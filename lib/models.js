"use strict";

// Every model this deployment asks for, plus a safe way to see which of them a
// key can actually use. Shared by the setup audit, /api/capabilities and the CLI
// checker (scripts/verify-models.js) so none of them can disagree with the code.

const MODEL_CHECKS = [
  { checkId: "GEMINI_SCRIPT_MODEL", role: "script", env: "GEMINI_SCRIPT_MODEL", fallback: "gemini-3.8-flash", required: true },
  { checkId: "GEMINI_IMAGE_MODEL", role: "image", env: "GEMINI_IMAGE_MODEL", fallback: "gemini-3.1-flash-image", required: true },
  { checkId: "GEMINI_TTS_MODEL", role: "tts", env: "GEMINI_TTS_MODEL", fallback: "gemini-2.5-flash-preview-tts", required: true },
  // Used only when the primary script model answers 404/429. Its availability is
  // never assumed, so a missing ID is a warning, never a hard failure.
  { checkId: "GEMINI_SCRIPT_FALLBACK_MODEL", role: "scriptFallback", env: "GEMINI_SCRIPT_FALLBACK_MODEL", fallback: "gemini-3.5-flash-lite", required: false },
];

function configuredModels(env = process.env) {
  return MODEL_CHECKS.map(check => ({
    checkId: check.checkId,
    role: check.role,
    id: String(env[check.env] || "").trim() || check.fallback,
    required: check.required,
  }));
}

// Collect every model ID this key can see. The real SDK returns a Pager (an async
// iterable); tests may hand back {page()} or a plain array. Bounded, so a broken
// pager can never hang the caller.
async function listModelIds(listed) {
  const ids = new Set();
  const add = model => {
    const raw = String((model && (model.name || model.id)) || "").trim();
    if (raw) ids.add(raw.replace(/^models\//, ""));
  };
  if (listed && typeof listed[Symbol.asyncIterator] === "function") {
    let seen = 0;
    for await (const model of listed) {
      add(model);
      if (++seen > 2000) break;
    }
    return ids;
  }
  if (listed && typeof listed.page === "function") {
    let page = await listed.page();
    (page || []).forEach(add);
    let guard = 0;
    while (listed.nextPageToken && guard < 20) {
      page = await listed.page({ pageToken: listed.nextPageToken });
      (page || []).forEach(add);
      guard += 1;
    }
    return ids;
  }
  if (Array.isArray(listed)) listed.forEach(add);
  return ids;
}

module.exports = { MODEL_CHECKS, configuredModels, listModelIds };
