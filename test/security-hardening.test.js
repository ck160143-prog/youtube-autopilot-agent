"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const security = require("../security-hardening");
const { app } = require("../server");

async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    await run("http://127.0.0.1:" + server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("security headers and CSP are present without exposing Express", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/health");
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-powered-by"), null);
  });
});

test("cross-origin state-changing requests are rejected", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/youtube/disconnect", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 403);
  });
});

test("cookie-authenticated state changes require an Origin header", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/youtube/disconnect", {
      method: "POST",
      headers: { Cookie: "baba_youtube_session=opaque", "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 403);
  });
});

test("API rate limits return 429 after the configured threshold", async () => {
  const previous = process.env.API_RATE_LIMIT_MAX;
  process.env.API_RATE_LIMIT_MAX = "2";
  security._resetForTests();
  try {
    await withServer(async base => {
      assert.equal((await fetch(base + "/api/health")).status, 200);
      assert.equal((await fetch(base + "/api/health")).status, 200);
      const limited = await fetch(base + "/api/health");
      assert.equal(limited.status, 429);
      assert.ok(limited.headers.get("retry-after"));
    });
  } finally {
    if (previous === undefined) delete process.env.API_RATE_LIMIT_MAX;
    else process.env.API_RATE_LIMIT_MAX = previous;
    security._resetForTests();
  }
});

test("upload validators check file signatures rather than MIME declarations", () => {
  const mp4 = Buffer.alloc(16);
  mp4.write("ftyp", 4, "ascii");
  assert.equal(security.validateVideoSignature(mp4, "video/mp4"), true);
  assert.equal(security.validateVideoSignature(Buffer.from("not a video"), "video/mp4"), false);
  assert.equal(security.validateVideoSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), "video/webm"), true);
  assert.equal(security.validateVideoSignature(mp4, "image/png"), false);
  assert.equal(security.validateImageSignature({ mimeType: "image/png", imageBase64: Buffer.from("<svg>").toString("base64") }), false);
});

test("render status does not authorize access to an unknown job ID", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/render/status/../../etc/passwd");
    assert.ok([400, 404].includes(response.status));
    assert.doesNotMatch(await response.text(), /root:/);
  });
});

test("build ZIP extracts successfully and contains only the explicit manifest", () => {
  const build = spawnSync(process.execPath, ["build.js"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const root = path.join(__dirname, "..");
  const archive = path.join(root, "dist", "baba-ai-youtube-agent.zip");
  const listing = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const entries = listing.stdout.trim().split(/\r?\n/).sort();
  const { MANIFEST } = require("../build");
  assert.deepEqual(entries, [...MANIFEST].sort());
  assert.equal(entries.some(entry => /(^|\/)\.env(?:$|\.)/.test(entry) && entry !== ".env.example"), false);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-zip-test-"));
  try {
    const extracted = spawnSync("unzip", ["-q", archive, "-d", tempDir], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    for (const file of MANIFEST) assert.equal(fs.existsSync(path.join(tempDir, file)), true, file);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
