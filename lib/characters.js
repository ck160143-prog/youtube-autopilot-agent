"use strict";

// Character library. A character is the single source of truth for identity:
// face, outfit, palette and voice. Every scene prompt and every voice request
// is generated from this record so the same character stays recognisable across
// a whole video and can be reused in the next project.

const fs = require("fs");
const path = require("path");

const VOICE_PRESETS = {
  male: ["Puck", "Charon", "Fenrir", "Orus", "Algie", "Iapetus"],
  female: ["Kore", "Aoede", "Leda", "Zephyr", "Despina", "Vindemiatrix"],
};

const MAX = { name: 60, look: 600, outfit: 300, colors: 200, voiceSample: 300 };

// Animation-ready characters: a rig is a set of mouth sprites (one per Rhubarb
// mouth shape) plus an anchor that says where the mouth sits in the frame.
// Sprites are real image files on disk — nothing is simulated.
const MOUTH_SHAPES = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];
const EXPRESSIONS = ["neutral", "happy", "sad", "angry", "surprised"];
// Sprites are small mouth/expression crops; the cap keeps a whole rig inside
// the 35 MB JSON body limit even with all 9 mouth shapes at once.
const SPRITE_MAX_BYTES = 2 * 1024 * 1024;

function clip(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

// Latin names become readable slugs ("Ramu Ji" -> "ramu-ji"). Hindi/Devanagari
// names carry no a-z characters, so they fall back to a random id instead of all
// collapsing onto the same literal "character" (which silently overwrote every
// character after the first). Suffixes are added by callers to keep ids unique.
function makeId(seed) {
  const base = String(seed || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base || "char-" + Math.random().toString(36).slice(2, 8);
}

// Default voice assignment. Voice names are provider prebuilt voices; whether a
// specific name is available depends on the configured TTS model, so the
// pipeline reports the provider error instead of pretending success.
function defaultVoiceFor(gender, index = 0) {
  const list = VOICE_PRESETS[gender === "male" ? "male" : "female"];
  return list[index % list.length];
}

function validateCharacter(input, index = 0, takenIds = null) {
  if (!input || typeof input !== "object") {
    throw Object.assign(new Error("किरदार की जानकारी भेजें।"), { statusCode: 400 });
  }
  const name = clip(input.name, MAX.name);
  if (!name) {
    throw Object.assign(new Error("किरदार का नाम जरूरी है।"), { statusCode: 400 });
  }
  const gender = input.voiceGender === "male" ? "male" : "female";
  let id = clip(input.id, 40) || makeId(name);
  // Never reuse an existing character's id: upsert would overwrite that
  // character and the user would silently lose the older one.
  if (takenIds && takenIds.has(id) && !clip(input.id, 40)) {
    let n = 2;
    while (takenIds.has(id + "-" + n)) n += 1;
    id = id + "-" + n;
  }
  const character = {
    id,
    name,
    role: clip(input.role, 120),
    look: clip(input.look, MAX.look),
    outfit: clip(input.outfit, MAX.outfit),
    colors: clip(input.colors, MAX.colors),
    voiceGender: gender,
    voiceName: clip(input.voiceName, 60) || defaultVoiceFor(gender, index),
    voiceSample: clip(input.voiceSample, MAX.voiceSample),
  };
  if (input.rig && typeof input.rig === "object") character.rig = validateRig(input.rig);
  return character;
}

// Normalise (not create) a rig. Sprite paths are only trusted when the file
// really exists and is a PNG/JPEG, so a stale path can never reach FFmpeg.
function validateRig(input) {
  const rig = input && typeof input === "object" ? input : {};
  const mouth = {};
  for (const shape of MOUTH_SHAPES) {
    const file = rig.mouth && rig.mouth[shape];
    mouth[shape] = validSprite(file) ? file : null;
  }
  const expressions = {};
  for (const name of EXPRESSIONS) {
    const file = rig.expressions && rig.expressions[name];
    expressions[name] = validSprite(file) ? file : null;
  }
  const anchor = {
    x: clamp01(rig.anchor && rig.anchor.x, 0.39),
    y: clamp01(rig.anchor && rig.anchor.y, 0.55),
    width: clamp01(rig.anchor && rig.anchor.width, 0.22),
  };
  const shapes = MOUTH_SHAPES.filter(shape => mouth[shape]);
  return {
    mouth,
    expressions,
    anchor,
    shapes,
    animationReady: shapes.length > 0,
    source: ["manual", "generated"].includes(rig.source) ? rig.source : "manual",
    updatedAt: rig.updatedAt || new Date().toISOString(),
  };
}

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function validSprite(file) {
  if (!file || typeof file !== "string") return false;
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    if (fs.statSync(file).size > SPRITE_MAX_BYTES) return false;
    const bytes = fs.readFileSync(file);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return Boolean(png || jpeg);
  } catch (_) {
    return false;
  }
}

function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((item, index) => {
    // Accept a bare name ("Toto") as well as a full record so callers that
    // only have names still get a usable character.
    const source = typeof item === "string" ? { name: item } : item;
    const character = validateCharacter(source, index);
    let id = character.id;
    let suffix = 2;
    while (seen.has(id)) id = character.id + "-" + suffix++;
    seen.add(id);
    return { ...character, id };
  });
}

// Compact, English, image-model-friendly identity block. Kept under ~120 words
// so it can be repeated in every scene prompt without dominating it.
function describeForPrompt(character) {
  const parts = [character.name];
  if (character.look) parts.push(character.look);
  if (character.outfit) parts.push("wearing " + character.outfit);
  if (character.colors) parts.push("color palette: " + character.colors);
  return parts.join(", ");
}

function bibleForPrompt(characters) {
  const list = normalizeList(characters);
  if (!list.length) return "";
  return "CHARACTER BIBLE (keep these exact identities in every scene): " +
    list.map(c => c.name + " = " + describeForPrompt(c)).join(". ") + ".";
}

class CharacterLibrary {
  constructor(options = {}) {
    this.file = options.file || path.join(process.cwd(), "data", "characters.json");
    this.characters = [];
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.characters = normalizeList(parsed && parsed.characters);
    } catch (_) {
      this.characters = [];
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, characters: this.characters }, null, 2));
    fs.renameSync(tmp, this.file);
    return this;
  }

  list() {
    return this.characters.map(c => ({ ...c }));
  }

  // Characters without an ownerId are legacy records: visible to any signed-in
  // user until the first account adopts them.
  listFor(ownerId) {
    return this.characters
      .filter(c => !c.ownerId || !ownerId || c.ownerId === ownerId)
      .map(c => ({ ...c }));
  }

  get(id) {
    const found = this.characters.find(c => c.id === id);
    return found ? { ...found } : null;
  }

  // Sprites live next to characters.json: data/characters/<id>/mouth-A.png
  dirFor(id) {
    const safe = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
    if (!safe) throw Object.assign(new Error("अमान्य character id।"), { statusCode: 400 });
    return path.join(path.dirname(this.file), safe);
  }

  spritePath(id, kind, shape) {
    const folder = kind === "expression" ? "expr" : "mouth";
    const safeShape = String(shape || "").replace(/[^A-Za-z]/g, "").slice(0, 8);
    return path.join(this.dirFor(id), folder + "-" + safeShape + ".png");
  }

  setRig(id, rigInput, ownerId) {
    const character = this.characters.find(c => c.id === id);
    if (!character) throw Object.assign(new Error("किरदार नहीं मिला।"), { statusCode: 404 });
    if (ownerId && character.ownerId && character.ownerId !== ownerId) {
      throw Object.assign(new Error("यह किरदार आपका नहीं है।"), { statusCode: 403 });
    }
    const rig = validateRig(rigInput);
    character.rig = rig;
    this.save();
    return { ...character, rig };
  }

  removeRig(id, ownerId) {
    const character = this.characters.find(c => c.id === id);
    if (!character) throw Object.assign(new Error("किरदार नहीं मिला।"), { statusCode: 404 });
    if (ownerId && character.ownerId && character.ownerId !== ownerId) {
      throw Object.assign(new Error("यह किरदार आपका नहीं है।"), { statusCode: 403 });
    }
    const dir = this.dirFor(id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* nothing to remove */ }
    delete character.rig;
    this.save();
    return { ...character };
  }

  upsert(input, index) {
    const ownerId = input && input.ownerId ? String(input.ownerId).slice(0, 40) : null;
    // Scope the id-collision check to the same owner so two users may both have
    // a character called "रामू".
    const taken = new Set(this.characters.filter(c => (c.ownerId || null) === ownerId).map(c => c.id));
    const character = validateCharacter(input, index == null ? this.characters.length : index, taken);
    character.ownerId = ownerId || character.ownerId || null;
    const at = this.characters.findIndex(c => c.id === character.id);
    // Editing a character must not throw away its uploaded animation rig.
    if (at >= 0 && !character.rig && this.characters[at].rig) character.rig = this.characters[at].rig;
    if (at >= 0) this.characters[at] = character;
    else this.characters.push(character);
    this.save();
    return { ...character };
  }

  adoptOwner(ownerId) {
    let count = 0;
    for (const character of this.characters) {
      if (character.ownerId) continue;
      character.ownerId = ownerId;
      count += 1;
    }
    if (count) this.save();
    return count;
  }

  remove(id) {
    const before = this.characters.length;
    this.characters = this.characters.filter(c => c.id !== id);
    if (this.characters.length !== before) this.save();
    return this.characters.length !== before;
  }
}

module.exports = {
  CharacterLibrary,
  VOICE_PRESETS,
  MOUTH_SHAPES,
  EXPRESSIONS,
  defaultVoiceFor,
  validateCharacter,
  validateRig,
  validSprite,
  normalizeList,
  describeForPrompt,
  bibleForPrompt,
  makeId,
};
