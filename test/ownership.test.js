"use strict";

// Multi-user isolation: each account only sees and touches its own projects
// and characters. Legacy ownerless records stay visible until the first owner
// registers, then become that owner's.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "baba-own-"));
process.env.APP_REGISTRATION_KEY = "team-key";
// Isolation between two accounts is what this file proves, so it needs the
// operator-opened signup door. Owner-only access keeps it closed by default.
process.env.ALLOW_PUBLIC_SIGNUP = "1";

const { app } = require("../server");
const { registerAndLogin, authHeaders, registerOwner } = require("./helpers");

let server;
let base;
let owner;
let member;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  owner = await registerOwner(base, "alpha_user");
  member = await registerAndLogin(base, "beta_user", { registrationKey: "team-key" });
});

test.after(() => server.close());

async function call(session, url, options) {
  return fetch(base + url, { ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}) });
}

test("two accounts are distinct and the first is the owner", () => {
  assert.equal(owner.user.role, "owner");
  assert.equal(member.user.role, "member");
  assert.notEqual(owner.user.id, member.user.id);
});

test("a project belongs to the account that created it", async () => {
  const created = await call(owner, "/api/projects", {
    method: "POST", body: JSON.stringify({ topic: "Alpha का प्राइवेट प्रोजेक्ट" }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json()).project;
  assert.equal(project.ownerId, owner.user.id);

  // Owner-only access is stricter than "your list is empty": a non-owner is
  // refused before the list is built, so nothing can leak through a page size,
  // an offset or a future query parameter.
  const list = await call(member, "/api/projects");
  assert.equal(list.status, 403, "a non-owner must not reach the project list at all");
  assert.equal((await list.json()).code, "OWNER_ONLY");

  const direct = await call(member, "/api/projects/" + project.id);
  assert.equal(direct.status, 403);
});

test("project routes refuse another user's project", async () => {
  const created = await call(owner, "/api/projects", {
    method: "POST", body: JSON.stringify({ topic: "दूसरा प्रोजेक्ट" }),
  });
  const project = (await created.json()).project;
  const routes = [
    ["POST", "/api/projects/" + project.id + "/story"],
    ["POST", "/api/projects/" + project.id + "/assets"],
    ["POST", "/api/projects/" + project.id + "/render"],
    ["POST", "/api/projects/" + project.id + "/automate"],
    ["POST", "/api/projects/" + project.id + "/cancel"],
    ["POST", "/api/projects/" + project.id + "/thumbnail"],
    ["GET", "/api/projects/" + project.id + "/video"],
    ["GET", "/api/projects/" + project.id + "/captions"],
    ["GET", "/api/projects/" + project.id + "/download"],
    ["GET", "/api/projects/" + project.id + "/seo"],
  ];
  for (const [method, url] of routes) {
    const response = await call(member, url, { method });
    assert.equal(response.status, 403, method + " " + url + " must be refused for another user");
  }
  const removed = await call(member, "/api/projects/" + project.id, { method: "DELETE" });
  assert.equal(removed.status, 403);

  // The owner can still delete it.
  const own = await call(owner, "/api/projects/" + project.id, { method: "DELETE" });
  assert.equal(own.status, 200);
});

test("characters are isolated per account", async () => {
  const created = await call(owner, "/api/characters", {
    method: "POST",
    body: JSON.stringify({ name: "चाचा चौधरी", description: "एक जिज्ञासु चाचा", personality: "मज़ाकिया" }),
  });
  assert.equal(created.status, 200);
  const character = (await created.json()).character;
  assert.equal(character.ownerId, owner.user.id);

  // The whole library is owner-only now, so a non-owner is refused outright
  // rather than receiving an empty list.
  const memberList = await call(member, "/api/characters");
  assert.equal(memberList.status, 403);
  assert.equal((await memberList.json()).code, "OWNER_ONLY");

  const denied = await call(member, "/api/characters/" + character.id, { method: "DELETE" });
  assert.equal(denied.status, 403);

  const ownerList = await call(owner, "/api/characters");
  assert.equal((await ownerList.json()).characters.some(item => item.id === character.id), true);
});

test("legacy ownerless records are adopted by the first owner", async () => {
  const { ProjectStore } = require("../lib/projects");
  const store = new ProjectStore({ root: path.join(process.env.DATA_DIR, "projects") });
  // A project written before authentication existed has no ownerId.
  const legacyFile = path.join(process.env.DATA_DIR, "projects", "legacy1.json");
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({
    id: "legacy1", ownerId: null, topic: "पुराना प्रोजेक्ट", status: "draft",
    progress: { percent: 0, stage: "draft", message: "" }, assets: { scenes: {} },
  }));
  const adopted = store.adoptOwner("legacy-owner-id");
  assert.equal(adopted, 1);
  assert.equal(store.get("legacy1").ownerId, "legacy-owner-id");
  const secondPass = store.adoptOwner("someone-else");
  assert.equal(secondPass, 0, "adoption must not steal an already owned project");
});
