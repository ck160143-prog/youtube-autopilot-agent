"use strict";

// The dashboard links to /baba-ai-youtube-agent.zip, so the archive must really
// exist and must contain the whole runnable project — no secrets.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MANIFEST, ZIP } = require("../build");

test("build produces an archive matching the manifest", () => {
  const result = spawnSync(process.execPath, ["build.js"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(ZIP), "archive exists");
  assert.ok(fs.statSync(ZIP).size > 1000, "archive is not empty");

  const listing = spawnSync("unzip", ["-Z1", ZIP], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const entries = listing.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(entries, [...MANIFEST].sort());

  const secretLike = entries.filter(entry => /(^|\/)\.env$|credential|\.pem$|\.key$/i.test(entry));
  assert.deepEqual(secretLike, [], "no credential files in the archive");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-zip-"));
  try {
    const extracted = spawnSync("unzip", ["-q", ZIP, "-d", tempDir], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    for (const file of MANIFEST) {
      assert.equal(fs.existsSync(path.join(tempDir, file)), true, "missing " + file);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.test, "node --test");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("every local module the server requires is inside the archive", () => {
  // server.js is shipped in the zip, so anything it requires must ship too —
  // otherwise the downloaded project crashes on first start.
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Node resolves "./lib/auth" to lib/auth.js, so normalise before comparing.
  const required = [...server.matchAll(/require\("\.\/([^"]+)"\)/g)]
    .map(match => match[1])
    .map(relative => (relative.endsWith(".js") ? relative : relative + ".js"));
  assert.ok(required.length > 0, "expected relative requires in server.js");
  const missing = required.filter(relative => !MANIFEST.includes(relative));
  assert.deepEqual(missing, [], "these modules would be missing from the downloaded project");
});
