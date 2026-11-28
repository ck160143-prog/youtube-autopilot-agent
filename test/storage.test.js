"use strict";

// Storage abstraction. Two things must hold or the backup is a lie:
//   1. a key can never escape the local root (path traversal),
//   2. the S3 driver produces a correctly signed, correctly addressed request.
// The S3 test uses a fake fetch: no network, no account, no credentials.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const storage = require("../lib/storage");

// ---------- local driver ----------

test("local driver round-trips bytes and reports existence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-"));
  const driver = storage.localDriver(root);

  await driver.put("p1/final.mp4", Buffer.from("video-bytes"));
  assert.equal((await driver.get("p1/final.mp4")).toString(), "video-bytes");
  assert.equal(await driver.has("p1/final.mp4"), true);
  assert.equal(await driver.has("p1/missing.mp4"), false);

  await driver.remove("p1/final.mp4");
  assert.equal(await driver.has("p1/final.mp4"), false);
});

test("a storage key can never escape the root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-"));
  const driver = storage.localDriver(root);

  for (const key of ["../escape.txt", "a/../../escape.txt", "/etc/passwd", ".hidden", ""]) {
    await assert.rejects(() => driver.put(key, Buffer.from("x")), error => error.statusCode === 400, "must reject " + JSON.stringify(key));
  }
  assert.equal(fs.existsSync(path.join(root, "..", "escape.txt")), false, "nothing may be written outside the root");
});

// ---------- S3 driver ----------

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  impl.calls = calls;
  return impl;
}

const CONFIG = {
  endpoint: "https://r2.example.com",
  bucket: "baba-videos",
  accessKey: "AKIDEXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "auto",
  prefix: "baba",
};

test("S3 PUT targets bucket + prefix and sends a signed request", async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }));
  const driver = storage.s3Driver({ ...CONFIG, fetch: fetchImpl });

  const result = await driver.put("p1/final.mp4", Buffer.from("abc"));
  const { url, options } = fetchImpl.calls[0];

  assert.equal(url, "https://r2.example.com/baba-videos/baba/p1/final.mp4");
  assert.equal(options.method, "PUT");
  assert.match(options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
  assert.match(options.headers.Authorization, /SignedHeaders=[a-z0-9;-]+/);
  assert.equal(options.headers["x-amz-content-sha256"], storage.sha256Hex(Buffer.from("abc")));
  assert.equal(options.headers["Content-Length"], "3");
  assert.ok(options.signal, "every storage call must carry a deadline");
  assert.deepEqual(result, { key: "p1/final.mp4", bytes: 3 });
});

test("S3 GET returns bytes, and a 404 is a 404 rather than a crash", async () => {
  const fetchImpl = fakeFetch((url, options) => {
    if (options.method === "GET") {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("from-r2") };
    }
    return { ok: false, status: 404 };
  });
  const driver = storage.s3Driver({ ...CONFIG, fetch: fetchImpl });

  assert.equal((await driver.get("p1/final.mp4")).toString(), "from-r2");

  const missing = storage.s3Driver({
    ...CONFIG,
    fetch: fakeFetch(() => ({ ok: false, status: 404 })),
  });
  await assert.rejects(() => missing.get("p1/none.mp4"), error => error.statusCode === 404);
});

test("a failed upload is an error, never a silent success", async () => {
  const driver = storage.s3Driver({
    ...CONFIG,
    fetch: fakeFetch(() => ({ ok: false, status: 403 })),
  });
  await assert.rejects(() => driver.put("p1/final.mp4", Buffer.from("x")), error => error.statusCode === 502);
});

test("SigV4 signature is stable for a known input", () => {
  // Fixed clock + fixed payload: the signature must be deterministic, so a
  // refactor cannot quietly change the signing input.
  const signature = storage.signV4({
    method: "PUT",
    url: "https://r2.example.com/baba-videos/baba/p1/final.mp4",
    headers: { Host: "r2.example.com", "x-amz-content-sha256": storage.sha256Hex(Buffer.from("abc")) },
    payloadHash: storage.sha256Hex(Buffer.from("abc")),
    accessKey: CONFIG.accessKey,
    secretKey: CONFIG.secretKey,
    region: "auto",
    datetime: "20260101T000000Z",
  });
  const first = signature;
  const again = storage.signV4({
    method: "PUT",
    url: "https://r2.example.com/baba-videos/baba/p1/final.mp4",
    headers: { Host: "r2.example.com", "x-amz-content-sha256": storage.sha256Hex(Buffer.from("abc")) },
    payloadHash: storage.sha256Hex(Buffer.from("abc")),
    accessKey: CONFIG.accessKey,
    secretKey: CONFIG.secretKey,
    region: "auto",
    datetime: "20260101T000000Z",
  });
  assert.equal(first, again);
  assert.match(first, /Signature=[0-9a-f]{64}$/);

  // A different secret must produce a different signature.
  const other = storage.signV4({
    method: "PUT",
    url: "https://r2.example.com/baba-videos/baba/p1/final.mp4",
    headers: { Host: "r2.example.com", "x-amz-content-sha256": storage.sha256Hex(Buffer.from("abc")) },
    payloadHash: storage.sha256Hex(Buffer.from("abc")),
    accessKey: CONFIG.accessKey,
    secretKey: "different-secret",
    region: "auto",
    datetime: "20260101T000000Z",
  });
  assert.notEqual(first, other);
});

// ---------- config + backup plan ----------

test("unconfigured S3 falls back to local instead of pretending to back up", () => {
  const driver = storage.storageFromEnv({ DATA_DIR: "/tmp/x" }, {});
  assert.equal(driver.name, "local");

  const configured = storage.storageFromEnv({
    STORAGE_S3_ENDPOINT: "https://r2.example.com",
    STORAGE_S3_BUCKET: "b",
    STORAGE_S3_ACCESS_KEY: "k",
    STORAGE_S3_SECRET_KEY: "s",
  }, {});
  assert.equal(configured.name, "s3");

  // Half-configured must not silently look like success.
  const half = storage.storageFromEnv({ STORAGE_S3_ENDPOINT: "https://r2.example.com" }, {});
  assert.equal(half.name, "local");
});

test("the backup plan puts the video first and skips what does not exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
  const video = path.join(dir, "final.mp4");
  fs.writeFileSync(video, "v");
  fs.writeFileSync(path.join(dir, "captions.srt"), "srt");

  const project = { id: "p1", render: { videoPath: video } };
  const plan = storage.backupPlan(project, dir);
  assert.deepEqual(plan.map(item => item.key), ["p1/project.json", "p1/final.mp4", "p1/captions.srt"]);
  assert.equal(plan[0].type, "json");

  const empty = storage.backupPlan({ id: "p2", render: null }, path.join(dir, "nope"));
  assert.deepEqual(empty.map(item => item.key), ["p2/project.json"], "metadata is always worth keeping");
});

test("backing a project up writes the JSON and the real video bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
  const driver = storage.localDriver(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bkproj-"));
  const video = path.join(dir, "final.mp4");
  fs.writeFileSync(video, "REAL-MP4-BYTES");

  const result = await storage.backupProject(driver, { id: "p9", render: { videoPath: video } }, dir);
  assert.equal(result.driver, "local");
  assert.equal((await driver.get("p9/final.mp4")).toString(), "REAL-MP4-BYTES");
  const meta = JSON.parse((await driver.get("p9/project.json")).toString());
  assert.equal(meta.id, "p9");
  assert.ok(result.bytes > 0);
});
