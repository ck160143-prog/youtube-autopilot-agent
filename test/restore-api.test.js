"use strict";

// The restore route, end to end over HTTP: a finished project is backed up by
// the pipeline, the project is then deleted from the disk as a redeploy would,
// and the API brings the MP4 back intact.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { registerAndLogin, authHeaders } = require("./helpers");

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");

test("a deleted project comes back through POST /restore", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-api-"));
  const backupDir = path.join(dataDir, "backup");
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_LOCAL_DIR = backupDir;
  process.env.APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || "restore-test-secret";
  // The ownership test below needs a second account, which owner-only access
  // closes by default; opening it is exactly what an operator would do.
  process.env.APP_REGISTRATION_KEY = "restore-team-key";
  process.env.ALLOW_PUBLIC_SIGNUP = "1";
  delete require.cache[require.resolve("../server")];
  const { app } = require("../server");

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const session = await registerAndLogin(base, "restore_user", { registrationKey: process.env.APP_REGISTRATION_KEY });
    const call = (url, options) => fetch(base + url, {
      ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}),
    });

    // Write a project and a fake MP4 exactly where the store keeps them.
    const created = await call("/api/projects", { method: "POST", body: JSON.stringify({ topic: "restore test", durationMinutes: 1, sceneCount: 2 }) });
    const project = (await created.json()).project;
    const projectDir = path.join(dataDir, "projects", project.id);
    fs.mkdirSync(path.join(projectDir, "render"), { recursive: true });
    const videoBytes = crypto.randomBytes(2048);
    const videoPath = path.join(projectDir, "render", "final.mp4");
    fs.writeFileSync(videoPath, videoBytes);

    const recordFile = path.join(dataDir, "projects", project.id + ".json");
    const stored = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    stored.render = { videoPath, size: videoBytes.length, duration: 60, layout: { width: 1280, height: 720 } };
    stored.story = { title: "बचाया हुआ", scenes: [] };
    fs.writeFileSync(recordFile, JSON.stringify(stored));

    // Back up through the real library the server uses.
    const storageLib = require("../lib/storage");
    const driver = storageLib.storageFromEnv(process.env);
    assert.equal(driver.name, "local");
    await storageLib.backupProject(driver, stored, projectDir);

    // Redeploy: the project directory and its record are gone.
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(recordFile, { force: true });
    assert.equal(fs.existsSync(videoPath), false);

    const restored = await call("/api/projects/" + project.id + "/restore", { method: "POST" });
    const body = await restored.json();
    assert.equal(restored.status, 200, JSON.stringify(body));
    assert.ok(body.restored >= 2, "expected at least the video and the JSON back: " + JSON.stringify(body));
    // The restored MP4 lands inside the project directory, which is where the
    // store looks for it; the record is rewritten to point there.
    const restoredVideo = path.join(projectDir, "final.mp4");
    assert.ok(fs.existsSync(restoredVideo), "the MP4 must be restored: " +
      JSON.stringify(fs.readdirSync(path.join(dataDir, "projects"), { recursive: true })));
    assert.equal(sha(fs.readFileSync(restoredVideo)), sha(videoBytes), "bytes must be identical");
    const rewritten = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    assert.equal(rewritten.render.videoPath, restoredVideo);

    // And the project is downloadable again.
    const download = await call("/api/projects/" + project.id + "/download");
    assert.equal(download.status, 200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.equal(sha(downloaded), sha(videoBytes));

    fs.rmSync(dataDir, { recursive: true, force: true });
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("restore is refused for another user's project", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-api-"));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_LOCAL_DIR = path.join(dataDir, "backup");
  delete require.cache[require.resolve("../server")];
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const owner = await registerAndLogin(base, "owner_user", { registrationKey: process.env.APP_REGISTRATION_KEY });
    const other = await registerAndLogin(base, "other_user", { registrationKey: process.env.APP_REGISTRATION_KEY });
    const created = await fetch(base + "/api/projects", {
      method: "POST", headers: authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ topic: "mine", durationMinutes: 1, sceneCount: 2 }),
    });
    const project = (await created.json()).project;

    // The attacker must not learn whether a backup exists, and must not be able
    // to restore one that belongs to someone else.
    const storageLib = require("../lib/storage");
    const projectDir = path.join(dataDir, "projects", project.id);
    const recordFile = path.join(dataDir, "projects", project.id + ".json");
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "final.mp4"), Buffer.from("owner-video"));
    await storageLib.backupProject(storageLib.storageFromEnv(process.env), record, projectDir);

    const res = await fetch(base + "/api/projects/" + project.id + "/restore", {
      method: "POST", headers: authHeaders(other),
    });
    assert.equal(res.status, 403, "another user's backup must be refused");
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
