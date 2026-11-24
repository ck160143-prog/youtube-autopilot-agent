#!/usr/bin/env node
"use strict";

// Safe availability check for the configured Gemini models.
//
//   GEMINI_API_KEY=... node scripts/verify-models.js
//
// Makes exactly ONE `models.list` request (metadata only — no generation, no
// quota). The key itself is never printed: not its value, not its length.
// Exit codes: 0 = every required model visible, 1 = something missing/failed,
// 2 = no key configured.

require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");
const { configuredModels, listModelIds } = require("../lib/models");
const { redactSecrets } = require("../lib/setup");

function pad(value, width) {
  const text = String(value);
  return text + " ".repeat(Math.max(0, width - text.length));
}

async function main() {
  const key = String(process.env.GEMINI_API_KEY || "").trim();
  if (!key) {
    console.error("GEMINI_API_KEY सेट नहीं है — कोई जाँच नहीं हुई, कोई API call नहीं हुआ।");
    return 2;
  }

  const ai = new GoogleGenAI({ apiKey: key });
  let ids;
  try {
    const listed = await Promise.race([
      ai.models.list(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20000)),
    ]);
    ids = await listModelIds(listed);
  } catch (error) {
    console.error("models.list विफल: " + redactSecrets(error.message || "अज्ञात त्रुटि"));
    return 1;
  }

  console.log("models.list से " + ids.size + " model IDs दिखे (metadata only — कोई generation नहीं)\n");
  let requiredMissing = 0;
  for (const model of configuredModels()) {
    const seen = ids.has(model.id);
    const mark = seen ? "✅" : (model.required ? "❌" : "⚠️ ");
    const status = seen
      ? "इस key के लिए उपलब्ध"
      : (model.required ? "नहीं मिला — बदलना ज़रूरी" : "नहीं मिला (optional fallback)");
    console.log("  " + mark + " " + pad(model.role, 15) + pad(model.id, 34) + status);
    if (!seen && model.required) requiredMissing += 1;
  }

  console.log("");
  if (requiredMissing) {
    console.log(requiredMissing + " ज़रूरी model ID उपलब्ध नहीं है — Render Environment में उन्हें बदलें।");
    return 1;
  }
  console.log("सभी ज़रूरी model IDs इस key के लिए उपलब्ध हैं।");
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error("जाँच विफल: " + redactSecrets(error.message || String(error)));
  process.exitCode = 1;
});
