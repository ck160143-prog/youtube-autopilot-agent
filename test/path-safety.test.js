"use strict";

// Path safety: a project id comes from the URL, so it must never be usable as a
// filesystem path. fileFor already rejected traversal; dirFor did not.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ProjectStore, createProject } = require("../lib/projects");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "baba-paths-"));
const store = new ProjectStore({ root });

test("dirFor refuses path traversal in a project id", () => {
  for (const bad of ["../escape", "..", "a/b", "a\\b", ".hidden", "", "x".repeat(81)]) {
    assert.throws(() => store.dirFor(bad), /अमान्य project id/, "dirFor accepted " + JSON.stringify(bad));
  }
});

test("fileFor refuses path traversal in a project id", () => {
  for (const bad of ["../escape", "..", "a/b", ""]) {
    assert.throws(() => store.fileFor(bad), /अमान्य project id/, "fileFor accepted " + JSON.stringify(bad));
  }
});

test("a valid id stays inside the store root", () => {
  const created = createProject({ topic: "परीक्षण", ownerId: "u1" });
  const dir = store.dirFor(created.id);
  assert.equal(path.dirname(dir), root, "asset dir must sit directly under the store root");
  assert.equal(path.basename(dir), created.id);
  assert.match(created.id, /^[A-Za-z0-9_-]{1,80}$/);
});
