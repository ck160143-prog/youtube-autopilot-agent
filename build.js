"use strict";

// Deterministic source manifest for the downloadable project archive.
// Never add .env, generated output, credentials, or runtime data here.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const ZIP = path.join(DIST, "baba-ai-youtube-agent.zip");
const MANIFEST = [
  ".gitignore",
  ".env.example",
  ".github/workflows/ci.yml",
  ".github/workflows/node-test.yml",
  ".github/workflows/test.yml",
  "README.md",
  "build.js",
  "index.html",
  "netlify.toml",
  "package-lock.json",
  "package.json",
  "render.yaml",
  "security-hardening.js",
  "server.js",
  "server.test.js",
  "test/api.test.js",
  "test/gemini-image-quota.test.js",
  "test/quota-recovery.test.js",
  "test/security-hardening.test.js"
];

function assertSafeManifest() {
  for (const relativePath of MANIFEST) {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      throw new Error("Unsafe ZIP manifest path: " + relativePath);
    }
    if (/^(?:\.env(?:$|\.)|.*(?:secret|credential|token).*)/i.test(path.basename(relativePath)) && relativePath !== ".env.example") {
      throw new Error("Secret-like file is forbidden in ZIP manifest: " + relativePath);
    }
    const fullPath = path.join(ROOT, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error("ZIP manifest file is missing: " + relativePath);
    }
  }
}

function build() {
  fs.mkdirSync(DIST, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(DIST, "index.html"));
  assertSafeManifest();
  fs.rmSync(ZIP, { force: true });
  execFileSync("zip", ["-X", "-q", "-r", ZIP, ...MANIFEST], { cwd: ROOT, stdio: "inherit" });
  console.log("Build OK: dist/index.html and dist/baba-ai-youtube-agent.zip created from " + MANIFEST.length + " manifest entries");
}

if (require.main === module) build();
module.exports = { MANIFEST, build };
