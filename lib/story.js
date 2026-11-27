"use strict";

// Story engine: topic -> structured Hindi story with N scenes.
// The model is only asked for JSON; every field is validated and repaired here
// so a malformed response can never reach the renderer.

const { bibleForPrompt, normalizeList } = require("./characters");

// 1 min -> 10 scenes, 2 -> 20, 5 -> 50, then +5 scenes per extra minute
// (10 min -> 75, 20 -> 125, 30 -> 150). Matches the 10/20/50-or-more brief.
function planSceneCount(minutes) {
  const m = Number(minutes);
  const value = Number.isFinite(m) && m > 0 ? m : 1;
  if (value <= 1) return 10;
  if (value <= 2) return 20;
  if (value <= 5) return 50;
  return Math.min(150, 50 + Math.round(value - 5) * 5);
}

// Hindi narration averages roughly 130 words per minute.
function estimateNarrationSeconds(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round((words / 130) * 60));
}

function styleInstruction(style) {
  if (style === "cinematic") {
    return "Cinematic family film look, dramatic natural lighting, shallow depth of field, film grain.";
  }
  if (style === "realistic") {
    return "Photorealistic live-action look, natural light, documentary framing.";
  }
  return "High-quality 3D animated cartoon, Pixar-style rounded shapes, big expressive eyes, " +
    "soft cinematic lighting, vibrant but natural colors, family-friendly, clearly CGI animation " +
    "and not a photograph.";
}

function buildStoryPrompt({ topic, language, style, sceneCount, characters, durationMinutes, researchContext }) {
  const lang = language === "English" ? "English" : "Hindi (Devanagari)";
  const bible = bibleForPrompt(characters);
  const cast = normalizeList(characters).map(c => c.name).filter(Boolean);
  return [
    "You are a senior children's animation writer. Write a complete, original story.",
    "",
    "Topic: " + topic,
    "Output language: " + lang,
    "Visual style: " + styleInstruction(style),
    "Target runtime: " + durationMinutes + " minutes",
    "Required scene count: exactly " + sceneCount,
    cast.length ? "Cast (use only these characters, never invent new named characters): " + cast.join(", ") : "",
    bible,
    researchContext || "",
    "",
    "Rules:",
    "1. Every scene must advance the story; no filler and no repeated narration.",
    "2. Narration is short (max 45 words) and is meant to be spoken aloud.",
    "3. Dialogue lines belong to a character from the cast and are conversational.",
    "4. imagePrompt is an English visual description of ONE moment, with the same character " +
      "identity as the character bible. Never include text, captions, logos or watermarks.",
    "5. Continuity: outfits, colors, age and body proportions never change between scenes.",
    "6. Give the story a real ending.",
    "",
    "Return ONLY valid JSON, no markdown fences, matching exactly this schema:",
    '{"title":"string","scenes":[{"title":"short scene title","narration":"spoken narration",' +
      '"dialogue":[{"character":"name from cast","text":"line"}],' +
      '"imagePrompt":"english image prompt","transition":"fade"}]}',
  ].filter(Boolean).join("\n");
}

function stripFences(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```\s*$/g, "")
    .trim();
}

function extractJson(text) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    /* fall through to brace matching */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error("story JSON not found");
}

function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeDialogue(list, cast) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 6).map(item => {
    const character = cleanText(item && item.character, 60);
    const text = cleanText(item && item.text, 300);
    if (!text) return null;
    const known = cast.some(name => name.toLowerCase() === character.toLowerCase());
    return { character: known ? character : (cast[0] || character), text, known };
  }).filter(Boolean);
}

function normalizeScenes(rawScenes, sceneCount, cast) {
  const list = Array.isArray(rawScenes) ? rawScenes : [];
  const scenes = list.slice(0, sceneCount).map((scene, index) => {
    const narration = cleanText(scene && scene.narration, 600);
    const imagePrompt = cleanText(scene && scene.imagePrompt, 900);
    const title = cleanText(scene && scene.title, 120) || "दृश्य " + (index + 1);
    const dialogue = normalizeDialogue(scene && scene.dialogue, cast);
    return {
      index: index + 1,
      title,
      narration,
      dialogue,
      imagePrompt: imagePrompt || narration,
      transition: cleanText(scene && scene.transition, 20) || "fade",
      estimatedSeconds: estimateNarrationSeconds(narration || dialogue.map(d => d.text).join(" ")),
    };
  }).filter(scene => scene.narration || scene.imagePrompt);
  return scenes;
}

// Repair the parts a model routinely gets wrong (missing index, missing prompt,
// too few scenes) and fail loudly on anything that would break rendering.
function parseStory(text, options = {}) {
  const sceneCount = Number(options.sceneCount) || 10;
  const characters = normalizeList(options.characters);
  const cast = characters.map(c => c.name).filter(Boolean);
  let parsed;
  try {
    parsed = extractJson(text);
  } catch (_) {
    throw Object.assign(new Error("AI से कहानी का JSON सही नहीं मिला। दोबारा प्रयास करें।"), { statusCode: 502 });
  }
  const scenes = normalizeScenes(parsed && parsed.scenes, sceneCount, cast);
  if (scenes.length < 3) {
    throw Object.assign(new Error("AI से बहुत कम दृश्य मिले (कम से कम 3 चाहिए)।"), { statusCode: 502 });
  }
  const title = cleanText(parsed && parsed.title, 140) || "BABA AI कहानी";
  return {
    title,
    language: options.language === "English" ? "English" : "हिंदी",
    style: options.style || "3d-cartoon",
    requestedScenes: sceneCount,
    characters,
    scenes,
  };
}

// Deterministic per-scene image prompt. The character bible is repeated on
// purpose: image models have no memory of the previous request.
function buildImagePrompt(scene, options = {}) {
  const bible = bibleForPrompt(options.characters);
  const style = styleInstruction(options.style);
  const aspect = options.aspect === "9:16" ? "vertical 9:16 portrait composition" :
    options.aspect === "1:1" ? "square 1:1 composition" : "horizontal 16:9 composition";
  const dialogueHint = (scene.dialogue || []).length
    ? "Scene contains a conversation moment." : "";
  return [
    style,
    bible,
    "Scene " + scene.index + ": " + (scene.imagePrompt || scene.narration),
    dialogueHint,
    aspect + ", single continuous shot, consistent character identity, " +
      "no text, no captions, no watermark, no logo.",
  ].filter(Boolean).join(" ");
}

module.exports = {
  planSceneCount,
  estimateNarrationSeconds,
  buildStoryPrompt,
  parseStory,
  buildImagePrompt,
  styleInstruction,
  stripFences,
  extractJson,
};
