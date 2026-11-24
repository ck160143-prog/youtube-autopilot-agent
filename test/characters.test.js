"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CharacterLibrary, validateCharacter, defaultVoiceFor, bibleForPrompt, normalizeList,
} = require("../lib/characters");

function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-char-"));
  return new CharacterLibrary({ file: path.join(dir, "characters.json") });
}

test("a character needs a name and gets a voice matching its gender", () => {
  const character = validateCharacter({ name: "Toto", voiceGender: "male", outfit: "Blue T-shirt" });
  assert.equal(character.name, "Toto");
  assert.equal(character.voiceGender, "male");
  assert.ok(character.voiceName, "a default voice name is assigned");
  assert.equal(defaultVoiceFor("female"), "Kore");
  assert.throws(() => validateCharacter({ name: "   " }), /नाम/);
});

test("character library persists to disk and survives a reload", () => {
  const library = tempLibrary();
  const saved = library.upsert({ name: "Toto", voiceGender: "male", look: "orange tiger", outfit: "Blue T-shirt" });
  const reloaded = new CharacterLibrary({ file: library.file }).load();
  const found = reloaded.get(saved.id);
  assert.ok(found, "saved character is found after reload");
  assert.equal(found.outfit, "Blue T-shirt");
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.remove(saved.id), true);
  assert.equal(reloaded.get(saved.id), null);
});

test("duplicate ids are made unique instead of overwriting a character", () => {
  const list = normalizeList([
    { name: "Toto", voiceGender: "male" },
    { name: "Toto", voiceGender: "female" },
  ]);
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(list[0].voiceGender, "male");
  assert.equal(list[1].voiceGender, "female");
});

test("character bible repeats identity for image prompts", () => {
  const bible = bibleForPrompt([
    { name: "Toto", look: "orange baby tiger", outfit: "Blue T-shirt", colors: "orange, blue" },
    { name: "Mili", look: "brown puppy", outfit: "red frock", colors: "brown, red" },
  ]);
  assert.match(bible, /Toto/);
  assert.match(bible, /Blue T-shirt/);
  assert.match(bible, /Mili/);
  assert.match(bible, /red frock/);
  assert.ok(bible.length < 900, "bible stays prompt-sized");
  assert.equal(bibleForPrompt([]), "");
});
