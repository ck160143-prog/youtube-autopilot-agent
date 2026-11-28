"use strict";

// Backup was already tested; restore did not exist at all, so a backed-up
// project could never come back. This exercises the real round trip: a project
// is backed up, its directory is destroyed, and it is restored with every byte
// verified against the manifest hash. The S3 path runs against an in-memory
// transport so no account or network is needed.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const storage = require("../lib/storage");

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");

function makeProject() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
  const dir = path.join(dataDir, "projects", "abc123");
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, "final.mp4");
  fs.writeFileSync(video, crypto.randomBytes(4096));
  fs.writeFileSync(path.join(dir, "captions.srt"), "1\n00:00:00,000 --> 00:00:02,000\nनमस्ते\n");
  fs.writeFileSync(path.join(dir, "thumbnail.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
  const project = {
    id: "abc123", ownerId: "u1", topic: "टेस्ट", status: "completed",
    story: { title: "Asli title" },
    render: { videoPath: video, size: fs.statSync(video).size, duration: 60 },
  };
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(project));
  return { dataDir, dir, video, project };
}

function fakeS3() {
  const objects = new Map();
  const fetchImpl = async (url, options = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.split("/").slice(2).join("/").replace(/^baba\//, ""));
    const method = options.method || "GET";
    if (method === "PUT") {
      objects.set(key, Buffer.from(options.body));
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (method === "HEAD") {
      return { ok: objects.has(key), status: objects.has(key) ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (method === "GET") {
      if (!objects.has(key)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      const body = objects.get(key);
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { objects, driver: storage.s3Driver({
    endpoint: "https://fake.example", bucket: "media", accessKey: "AK", secretKey: "SK",
    prefix: "baba", fetch: fetchImpl,
  }) };
}

for (const kind of ["local", "s3"]) {
  test("a " + kind + " backup can be restored byte for byte after the disk is lost", async () => {
    const { dataDir, dir, video, project } = makeProject();
    const s3 = kind === "s3" ? fakeS3() : null;
    const driver = s3 ? s3.driver : storage.localDriver(path.join(dataDir, "backup"));

    const videoBytes = fs.readFileSync(video);
    const backup = await storage.backupProject(driver, project, dir);
    assert.equal(backup.files.length, 4, "json + mp4 + srt + png should be backed up");
    assert.ok(backup.manifest.sha256, "a manifest hash is required");

    // Simulate the ephemeral filesystem: everything is gone.
    fs.rmSync(path.join(dataDir, "projects", project.id), { recursive: true, force: true });
    assert.equal(fs.existsSync(video), false);

    const result = await storage.restoreProject(driver, project.id, { dataDir });
    assert.equal(result.restored.length, 4);
    assert.equal(result.skipped.length, 0);
    const restoredVideo = path.join(dataDir, "projects", project.id, "final.mp4");
    assert.ok(fs.existsSync(restoredVideo), "the video must come back");
    assert.equal(sha(fs.readFileSync(restoredVideo)), sha(videoBytes), "restored bytes must be identical");
    assert.equal(result.project.story.title, "Asli title");
    // The rewritten project must point at the restored file, not the dead path.
    assert.equal(result.project.render.videoPath, restoredVideo);
    assert.equal(result.project.render.size, videoBytes.length);
  });
}

test("a tampered backup object is refused instead of silently restored", async () => {
  const { dataDir, dir, project } = makeProject();
  const driver = storage.localDriver(path.join(dataDir, "backup"));
  await storage.backupProject(driver, project, dir);
  fs.rmSync(path.join(dataDir, "projects", project.id), { recursive: true, force: true });

  // Flip one byte in the stored video.
  const stored = path.join(dataDir, "backup", project.id, "final.mp4");
  const bytes = fs.readFileSync(stored);
  bytes[0] = bytes[0] ^ 0xff;
  fs.writeFileSync(stored, bytes);

  await assert.rejects(
    () => storage.restoreProject(driver, project.id, { dataDir }),
    error => {
      assert.equal(error.statusCode, 422);
      assert.match(error.message, /hash/);
      return true;
    }
  );
});

test("a manifest that points outside the project is never written", async () => {
  const { dataDir, dir, project } = makeProject();
  const driver = storage.localDriver(path.join(dataDir, "backup"));
  await storage.backupProject(driver, project, dir);

  const manifestFile = path.join(dataDir, "backup", project.id, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files.push({ key: project.id + "/../../escape.txt", bytes: 3, sha256: sha(Buffer.from("bad")) });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  await driver.put(project.id + "/../../escape.txt", Buffer.from("bad")).catch(() => {});

  const result = await storage.restoreProject(driver, project.id, { dataDir });
  assert.ok(result.skipped.some(item => /unknown slot/.test(item.reason)), "the foreign key must be skipped");
  assert.equal(fs.existsSync(path.join(dataDir, "projects", "escape.txt")), false);
});

test("restoring a project that was never backed up says so", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-none-"));
  const driver = storage.localDriver(path.join(dataDir, "backup"));
  await assert.rejects(
    () => storage.restoreProject(driver, "nope", { dataDir }),
    error => {
      assert.equal(error.statusCode, 404);
      return true;
    }
  );
});

test("a corrupt manifest is reported, not guessed at", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-bad-"));
  const driver = storage.localDriver(path.join(dataDir, "backup"));
  await driver.put("abc123/manifest.json", Buffer.from("{not json"));
  await assert.rejects(
    () => storage.restoreProject(driver, "abc123", { dataDir }),
    error => {
      assert.equal(error.statusCode, 422);
      return true;
    }
  );
});
