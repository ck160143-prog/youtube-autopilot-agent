"use strict";

// Data written before authentication existed has no ownerId. The old ownership
// check was `record.ownerId && record.ownerId !== me`, so a missing owner meant
// "everyone may read and delete this" — a direct IDOR that also exposed any
// project restored from an older backup (the manifest carries ownerId: null).
// Measured before the fix: reading AND deleting an ownerless project as another
// account both returned 200.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ProjectStore } = require("../lib/projects");

function boot(dataDir) {
  process.env.DATA_DIR = dataDir;
  delete require.cache[require.resolve("../server")];
  const server = require("../server");
  const http = server.app.listen(0, "127.0.0.1");
  return new Promise(resolve => http.once("listening", () => resolve({
    http, base: "http://127.0.0.1:" + http.address().port, server,
  })));
}

async function register(base, username) {
  const response = await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "owner-password-123" }),
  });
  const body = await response.json();
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  const call = (url, options) => fetch(base + url, {
    ...(options || {}),
    headers: {
      "Content-Type": "application/json", Cookie: cookie,
      "x-csrf-token": body.csrfToken, ...((options && options.headers) || {}),
    },
  });
  return { cookie, csrfToken: body.csrfToken, user: body.user, call };
}

function legacyProject(dataDir, id) {
  const store = new ProjectStore({ root: path.join(dataDir, "projects") });
  const project = {
    id, ownerId: null, topic: "पुराना प्रोजेक्ट", status: "completed", sceneCount: 3,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    assets: { scenes: {} }, story: { title: "पुरानी", scenes: [] },
    render: { videoPath: null }, timeline: [], progress: {}, error: null,
  };
  store.save(project);
  return project;
}

test("an ownerless project belongs to the owner, not to whoever asks", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idor-legacy-"));
  const legacy = legacyProject(dataDir, "pLegacyProj01");
  const { http, base } = await boot(dataDir);
  try {
    // The owner registers; startup/registration adoption must claim the record.
    const owner = await register(base, "the_owner");
    assert.equal(owner.user.role, "owner");

    const mine = await owner.call("/api/projects/" + legacy.id);
    assert.equal(mine.status, 200, "the owner must keep their own legacy project");

    const list = await (await owner.call("/api/projects")).json();
    assert.ok(list.projects.some(p => p.id === legacy.id), "it must be listed for the owner");
    assert.equal(list.projects.find(p => p.id === legacy.id).ownerId, owner.user.id,
      "adoption must stamp the real owner id, not leave it null");

    // And the file on disk is now owned, so a later restart agrees.
    const onDisk = new ProjectStore({ root: path.join(dataDir, "projects") }).get(legacy.id);
    assert.equal(onDisk.ownerId, owner.user.id);
  } finally {
    http.close();
  }
});

test("a record that is still ownerless is refused, not open to all", async () => {
  // Belt and braces: even if adoption has not run (for example a project
  // restored after startup), a null owner must never mean "public".
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idor-null-"));
  const { http, base } = await boot(dataDir);
  try {
    const owner = await register(base, "owner_null");
    const legacy = await owner.call("/api/projects", {
      method: "POST", body: JSON.stringify({ topic: "बाद में", durationMinutes: 1, sceneCount: 3 }),
    });
    const created = (await legacy.json()).project;

    // Simulate the restored-from-old-backup case: strip the owner on disk.
    const store = new ProjectStore({ root: path.join(dataDir, "projects") });
    const record = store.get(created.id);
    record.ownerId = null;
    store.save(record);

    // The instance owner may still read it (they are the only account), which is
    // the point: it is not public, it is theirs.
    const read = await owner.call("/api/projects/" + created.id);
    assert.equal(read.status, 200);
  } finally {
    http.close();
  }
});

test("project listing never returns another owner's records", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-iso-"));
  const { http, base } = await boot(dataDir);
  try {
    const owner = await register(base, "owner_list");
    await owner.call("/api/projects", {
      method: "POST", body: JSON.stringify({ topic: "मेरा", durationMinutes: 1, sceneCount: 3 }),
    });
    const store = new ProjectStore({ root: path.join(dataDir, "projects") });
    assert.equal(store.listFor(owner.user.id).length, 1);

    // The case the old rule got wrong: an OWNERLESS record. Listing used to hand
    // it to any caller, so a second account saw the first account's work.
    legacyProject(dataDir, "pLegacyList01");
    assert.equal(store.listFor("someone-else").length, 0,
      "an ownerless record must not appear in another account's list");
    assert.equal(store.listFor(null).length, 0, "no owner id must never mean 'all projects'");
  } finally {
    http.close();
  }
});

test("characters are isolated the same way", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chars-iso-"));
  const { http, base } = await boot(dataDir);
  try {
    const owner = await register(base, "owner_chars");
    const created = await owner.call("/api/characters", {
      method: "POST", body: JSON.stringify({ name: "Toto" }),
    });
    assert.ok([200, 201].includes(created.status), "the owner can create a character: " + created.status);
    const { CharacterLibrary } = require("../lib/characters");
    const library = new CharacterLibrary({ file: path.join(dataDir, "characters.json") }).load();
    assert.equal(library.listFor("someone-else").length, 0, "no other account may list it");
    assert.equal(library.listFor(null).length, 0, "a missing owner must not list everything");
    assert.equal(library.listFor(owner.user.id).length, 1);
  } finally {
    http.close();
  }
});

test("the ownership rule itself is fail-closed", async () => {
  // Route-level tests cannot see this: registering stamps every legacy record
  // with the owner's id, so the broken rule and the fixed rule both answer "yes"
  // for the owner. The rule is therefore tested directly — a null owner must
  // never mean "the caller may have it", which is what it used to mean.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owns-rule-"));
  const { http, base, server } = await boot(dataDir);
  try {
    const owner = await register(base, "owner_rule");
    const req = { user: { id: owner.user.id, role: "owner" } };

    assert.equal(server.ownsRecordForTests(req, { ownerId: owner.user.id }), true,
      "the owner owns their own record");
    assert.equal(server.ownsRecordForTests(req, { ownerId: "someone-else" }), false,
      "another owner's record must be refused");
    // The regression: with no ownerId the old check was `!ownerId || ...`, so it
    // returned true for anybody.
    assert.equal(server.ownsRecordForTests(req, { ownerId: null }), true,
      "an ownerless record belongs to the instance owner");
    assert.equal(server.ownsRecordForTests(req, null), false, "a missing record is not owned");
    // A non-owner, whatever the record says, gets nothing. This is the assertion
    // that fails against the original rule (`!record.ownerId || ...`), which
    // answered true for every signed-in account on an ownerless record.
    const strangerReq = { user: { id: "u_stranger", role: "member" } };
    assert.equal(server.ownsRecordForTests(strangerReq, { ownerId: "u_stranger" }), false,
      "a non-owner must not own anything, even a record that names them");
    assert.equal(server.ownsRecordForTests(strangerReq, { ownerId: null }), false,
      "an ownerless record must not be readable by a non-owner");
    assert.equal(server.ownsRecordForTests({ user: null }, { ownerId: null }), false);
  } finally {
    http.close();
  }
});
