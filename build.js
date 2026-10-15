const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const distDir = path.join(__dirname, "dist");
fs.mkdirSync(distDir, { recursive: true });

fs.copyFileSync(
  path.join(__dirname, "index.html"),
  path.join(distDir, "index.html")
);

// Create a project ZIP (excluding secrets, node_modules, dist, bolt config)
const zipPath = path.join(distDir, "baba-ai-youtube-agent.zip");
const files = [
  ".gitignore",
  ".env.example",
  "README.md",
  "build.js",
  "index.html",
  "netlify.toml",
  "package-lock.json",
  "package.json",
  "server.js",
].join(" ");

try {
  execSync(`zip -j ${zipPath} ${files} -x "*.env" "*/node_modules/*" "*/dist/*" "*/.bolt/*" "*/.v3/*"`, {
    cwd: __dirname,
    stdio: "pipe",
  });
  console.log("Build OK: dist/index.html + dist/baba-ai-youtube-agent.zip created");
} catch (e) {
  // zip might not be available; skip silently
  console.log("Build OK: dist/index.html created (zip skipped — zip not available)");
}
