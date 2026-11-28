"use strict";

// Character ids must stay unique per owner. Devanagari names have no a-z
// characters, so every such name used to slug to the same literal "character"
// and each new character overwrote the previous one — silent data loss in a
// Hindi-first app.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-charid-"));
process.env.APP_REGISTRATION_KEY = "team-key";

const { app } = require("../server");
const { registerAndLogin, authHeaders, registerOwner } = require("./helpers");
const { makeId } = require("../lib/characters");

let server;
let base;
let owner;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  // One owner account, shared by the tests: ids are scoped per owner, so a
  // second account proves nothing here and is closed by owner-only access.
  owner = await registerOwner(base, "char_owner");
});

test.after(() => server && server.close());

test("makeId never returns one shared fallback for Hindi names", () => {
  const ids = new Set([makeId("रामू"), makeId("सीता"), makeId("मोहन"), makeId(""), makeId("😀")]);
  assert.equal(ids.size, 5, "every nameless seed must get its own id, got: " + [...ids].join(", "));
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/, "id must be filesystem-safe: " + id);
});

test("makeId still makes readable slugs for Latin names", () => {
  assert.equal(makeId("Ramu Ji"), "ramu-ji");
  assert.equal(makeId("Guru #1"), "guru-1");
});

test("three Hindi-named characters stay three separate characters", async () => {
  const session = owner;
  const created = [];
  for (const name of ["रामू", "सीता", "मोहन"]) {
    const response = await fetch(base + "/api/characters", {
      method: "POST", headers: authHeaders(session),
      body: JSON.stringify({ name, role: "hero" }),
    });
    assert.equal(response.status, 200, "create " + name);
    created.push((await response.json()).character);
  }
  const ids = created.map(c => c.id);
  assert.equal(new Set(ids).size, 3, "ids collided: " + ids.join(", "));

  const list = await (await fetch(base + "/api/characters", { headers: authHeaders(session) })).json();
  const names = (list.characters || list).map(c => c.name).sort();
  assert.deepEqual(names, ["मोहन", "रामू", "सीता"], "no character may be lost");
});

test("editing an existing character keeps its id instead of creating a duplicate", async () => {
  const session = owner;
  const first = await (await fetch(base + "/api/characters", {
    method: "POST", headers: authHeaders(session), body: JSON.stringify({ name: "गीता" }),
  })).json();
  const id = first.character.id;

  const edited = await (await fetch(base + "/api/characters", {
    method: "POST", headers: authHeaders(session),
    body: JSON.stringify({ id, name: "गीता", role: "teacher" }),
  })).json();
  assert.equal(edited.character.id, id, "explicit id must be honoured");
  assert.equal(edited.character.role, "teacher");

  const list = await (await fetch(base + "/api/characters", { headers: authHeaders(session) })).json();
  const characters = list.characters || list;
  // The claim is about the edit, not about the total: the previous test already
  // created characters for this same owner, so counting the whole library would
  // assert the wrong thing (and would break as soon as another test adds one).
  assert.equal(characters.filter(c => c.id === id).length, 1, "the edit must not duplicate the id");
  assert.equal(characters.filter(c => c.name === "गीता").length, 1, "and must not add a second गीता");
  assert.equal(characters.find(c => c.id === id).role, "teacher");
});
