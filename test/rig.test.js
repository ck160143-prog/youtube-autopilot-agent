"use strict";

// Animation-ready characters: mouth sprites are validated by magic bytes,
// stored as real files, and reported honestly in the character API.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-rig-"));

const { app } = require("../server");
const { registerAndLogin, authHeaders } = require("./helpers");
const { CharacterLibrary, validateRig } = require("../lib/characters");
const ffmpegTools = require("../lib/ffmpeg");
const { MOUTH_SHAPES } = require("../lib/characters");

let server;
let base;
let session;
let characterId;
let spriteBase64;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  session = await registerAndLogin(base, "rig_user");

  const created = await fetch(base + "/api/characters", {
    method: "POST", headers: authHeaders(session),
    body: JSON.stringify({ name: "टोटो", look: "नन्हा बाघ", outfit: "नीली टी-शर्ट" }),
  });
  assert.equal(created.status, 200);
  characterId = (await created.json()).character.id;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-sprite-"));
  const file = path.join(dir, "mouth.png");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
    "-vf", "drawbox=x=16:y=24:w=32:h=16:color=white:t=fill",
    "-frames:v", "1", "-y", file,
  ]);
  spriteBase64 = fs.readFileSync(file).toString("base64");
});

test.after(() => server.close());

async function call(url, options) {
  return fetch(base + url, { ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}) });
}

test("a character starts without an animation rig", async () => {
  const response = await call("/api/characters/" + encodeURIComponent(characterId));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.animation.ready, false);
  assert.match(body.animation.message, /sprites/);
});

test("uploading real mouth sprites makes the character animation-ready", async () => {
  const mouth = {};
  for (const shape of ["A", "B", "X"]) mouth[shape] = spriteBase64;
  const response = await call("/api/characters/" + encodeURIComponent(characterId) + "/rig", {
    method: "POST",
    body: JSON.stringify({ mouth, anchor: { x: 0.4, y: 0.6, width: 0.25 } }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.written, 3);
  assert.equal(body.animationReady, true);
  assert.deepEqual(body.shapes.sort(), ["A", "B", "X"]);

  for (const shape of ["A", "B", "X"]) {
    const file = body.character.rig.mouth[shape];
    assert.ok(fs.existsSync(file), "sprite must be a real file on disk: " + shape);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true,
      "stored sprite must keep the PNG signature");
  }
  assert.equal(body.character.rig.animationReady, true);
});

test("the character API now reports the rig honestly", async () => {
  const response = await call("/api/characters/" + encodeURIComponent(characterId));
  const body = await response.json();
  assert.equal(body.animation.ready, true);
  assert.deepEqual(body.animation.shapes.sort(), ["A", "B", "X"]);
  assert.equal(typeof body.animation.lipSyncEngine, "string");
});

test("invalid sprites are rejected and never written", async () => {
  const response = await call("/api/characters/" + encodeURIComponent(characterId) + "/rig", {
    method: "POST",
    body: JSON.stringify({ mouth: { C: "not-a-real-image" } }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(body.invalid, ["C"]);
});

test("another user cannot upload or delete the rig", async () => {
  process.env.APP_REGISTRATION_KEY = "team-key";
  const other = await registerAndLogin(base, "rig_other", { registrationKey: "team-key" });
  const upload = await fetch(base + "/api/characters/" + encodeURIComponent(characterId) + "/rig", {
    method: "POST", headers: authHeaders(other),
    body: JSON.stringify({ mouth: { A: spriteBase64 } }),
  });
  assert.equal(upload.status, 404);
  const remove = await fetch(base + "/api/characters/" + encodeURIComponent(characterId) + "/rig", {
    method: "DELETE", headers: authHeaders(other),
  });
  assert.equal(remove.status, 404);
});

test("validateRig ignores paths that do not exist on disk", () => {
  const rig = validateRig({
    mouth: { A: "/nope/missing.png", B: spriteBase64 },
    anchor: { x: 5, y: -1, width: 0.5 },
  });
  assert.equal(rig.mouth.A, null);
  assert.equal(rig.mouth.B, null, "base64 text is not a file path");
  assert.equal(rig.animationReady, false);
  assert.equal(rig.anchor.x, 1, "anchor values are clamped to 0..1");
  assert.equal(rig.anchor.y, 0);
});

test("deleting the rig removes the sprites", async () => {
  const before = await call("/api/characters/" + encodeURIComponent(characterId));
  const rig = (await before.json()).character.rig;
  const files = Object.values(rig.mouth).filter(Boolean);
  const response = await call("/api/characters/" + encodeURIComponent(characterId) + "/rig", { method: "DELETE" });
  assert.equal(response.status, 200);
  for (const file of files) assert.equal(fs.existsSync(file), false, "sprite file must be removed");
  const after = await call("/api/characters/" + encodeURIComponent(characterId));
  assert.equal((await after.json()).animation.ready, false);
});

test("editing a character keeps its rig", async () => {
  const mouth = {};
  for (const shape of ["A", "X"]) mouth[shape] = spriteBase64;
  await call("/api/characters/" + encodeURIComponent(characterId) + "/rig", {
    method: "POST", body: JSON.stringify({ mouth }),
  });
  const edited = await call("/api/characters", {
    method: "POST",
    body: JSON.stringify({ id: characterId, name: "टोटो", look: "बड़ा बाघ" }),
  });
  assert.equal(edited.status, 200);
  const saved = (await edited.json()).character;
  assert.equal(saved.rig.animationReady, true, "rig must survive a character edit");
});

test("the lipsync endpoint analyses real audio and returns cues", { timeout: 180000 }, async () => {
  const lipsync = require("../lib/lipsync");
  if (!lipsync.resolveEngine()) return test.skip("lip-sync engine not installed (optional)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-rigaudio-"));
  const wav = path.join(dir, "narration.wav");
  await ffmpegTools.runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=200:duration=2",
    "-af", "volume=0.6,tremolo=f=4:d=0.9", "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav,
  ]);
  const response = await call("/api/characters/" + encodeURIComponent(characterId) + "/lipsync", {
    method: "POST",
    body: JSON.stringify({ audioBase64: fs.readFileSync(wav).toString("base64"), dialogText: "नमस्ते दुनिया" }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.cues.length > 0);
  assert.equal(body.engine, lipsync.resolveEngine().source);
  assert.match(body.source, /Rhubarb/);
});

test("the lipsync endpoint rejects a request without audio", async () => {
  const response = await call("/api/characters/" + encodeURIComponent(characterId) + "/lipsync", {
    method: "POST", body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
});

test("MOUTH_SHAPES covers the Rhubarb alphabet", () => {
  assert.deepEqual(MOUTH_SHAPES, ["A", "B", "C", "D", "E", "F", "G", "H", "X"]);
});

test("CharacterLibrary rejects a rig for an unknown character", () => {
  const library = new CharacterLibrary({ file: path.join(process.env.DATA_DIR, "rig-lib.json") }).load();
  assert.throws(() => library.setRig("ghost", { mouth: {} }), /नहीं मिला/);
});
