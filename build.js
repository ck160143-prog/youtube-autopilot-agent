"use strict";

// Deterministic source archive for the dashboard's "download project" link.
// The archive is built from an explicit manifest with execFileSync (no shell
// quoting), and any failure throws instead of printing a fake success line.

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
  "GOAL.md",
  "README.md",
  "build.js",
  "index.html",
  "fonts/NotoSansDevanagari-Regular.ttf",
  "fonts/OFL.txt",
  "lib/animator.js",
  "lib/auth.js",
  "lib/captions.js",
  "lib/characters.js",
  "lib/ffmpeg.js",
  "lib/fonts.js",
  "lib/jobs.js",
  "lib/lipsync.js",
  "lib/media.js",
  "lib/models.js",
  "lib/pipeline.js",
  "lib/projects.js",
  "lib/ratelimit.js",
  "lib/setup.js",
  "lib/renderer.js",
  "lib/story.js",
  "lib/timeline.js",
  "package-lock.json",
  "package.json",
  "render.yaml",
  "scripts/verify-models.js",
  "server.js",
  "server.test.js",
  "test/api.test.js",
  "test/build.test.js",
  "test/captions.test.js",
  "test/characters.test.js",
  "test/animator.test.js",
  "test/auth.test.js",
  "test/csrf.test.js",
  "test/e2e-pipeline.test.js",
  "test/fonts.test.js",
  "test/gemini-image-quota.test.js",
  "test/helpers.js",
  "test/jobs.test.js",
  "test/lipsync.test.js",
  "test/project-api.test.js",
  "test/quota-recovery.test.js",
  "test/renderer.test.js",
  "test/ownership.test.js",
  "test/ratelimit.test.js",
  "test/recovery.test.js",
  "test/render-30min.test.js",
  "test/rig.test.js",
  "test/setup.test.js",
  "test/seo-auth.test.js",
  "test/ui-auth.test.js",
  "test/ui-mobile.test.js",
  "test/youtube-preflight.test.js",
  "test/story.test.js",
  "test/timeline.test.js",
];

function assertSafeManifest() {
  for (const relativePath of MANIFEST) {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      throw new Error("Unsafe archive path: " + relativePath);
    }
    if (/^\.env$/.test(relativePath)) {
      throw new Error("Real env files are forbidden in the archive: " + relativePath);
    }
    const fullPath = path.join(ROOT, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error("Archive file is missing: " + relativePath);
    }
  }
}

function build() {
  fs.mkdirSync(DIST, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(DIST, "index.html"));
  assertSafeManifest();
  fs.rmSync(ZIP, { force: true });
  execFileSync("zip", ["-X", "-q", "-r", ZIP, ...MANIFEST], { cwd: ROOT, stdio: "inherit" });
  const size = fs.statSync(ZIP).size;
  console.log("Build OK: dist/index.html + dist/baba-ai-youtube-agent.zip (" +
    MANIFEST.length + " files, " + (size / 1024).toFixed(1) + " KB)");
  return { zip: ZIP, size, files: MANIFEST.length };
}

if (require.main === module) {
  try {
    build();
  } catch (error) {
    console.error("Build FAILED:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { MANIFEST, build, ZIP };
