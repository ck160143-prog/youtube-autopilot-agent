"use strict";

// Devanagari font resolution. A Noto Sans Devanagari TTF ships in ./fonts so
// burned Hindi captions and thumbnail titles render correctly on hosts with no
// system fonts (Render, slim containers). CAPTION_FONT_FILE still wins.

const fs = require("fs");
const path = require("path");

const BUNDLED = path.join(__dirname, "..", "fonts", "NotoSansDevanagari-Regular.ttf");
const FAMILY = "Noto Sans Devanagari";

function resolveFontFile() {
  const configured = process.env.CAPTION_FONT_FILE;
  if (configured && fs.existsSync(configured)) return configured;
  if (fs.existsSync(BUNDLED)) return BUNDLED;
  return null;
}

function resolveFontDir() {
  const file = resolveFontFile();
  return file ? path.dirname(file) : null;
}

module.exports = { resolveFontFile, resolveFontDir, FAMILY, BUNDLED };
