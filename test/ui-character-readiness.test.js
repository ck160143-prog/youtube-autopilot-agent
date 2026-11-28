"use strict";

// A character without a rig renders as a static picture, and the dashboard used
// to show no difference between the two. Worse, the "ready" flag was stored when
// sprites were uploaded: uninstalling the lip-sync engine afterwards left a
// character claiming to be animatable. Both are pinned here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch (_) { JSDOM = null; }
const run = JSDOM ? test : test.skip;

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function jsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text, json: async () => body };
}

async function boot(characters) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "http://localhost/",
    beforeParse(window) {
      window.fetch = async (url) => (String(url).includes("/api/characters")
        ? jsonResponse({ characters })
        : jsonResponse({}));
      if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  await dom.window.p2.init();
  return dom;
}

test("a rigged character is shown as animatable, with its real shapes", async () => {
  const dom = await boot([{
    id: "toto", name: "Toto", voiceGender: "female",
    rig: { animationReady: true, shapes: ["B", "C"], mouth: { B: "/x/B.png", C: "/x/C.png" } },
  }]);
  const w = dom.window;
  await w.p2.loadCharacters();
  const list = w.document.getElementById("p2CharacterList").textContent;
  assert.match(list, /Lip-sync तैयार/, "a rigged character must say so: " + list);
  assert.match(list, /2 mouth shapes/, "the real shape count must be shown");
  assert.match(list, /B, C/, "the claim must be backed by the actual shapes");
  dom.window.close();
});

test("a character without a rig is marked as static, not silently equal", async () => {
  const dom = await boot([{ id: "plain", name: "Plain", voiceGender: "male" }]);
  const w = dom.window;
  await w.p2.loadCharacters();
  const list = w.document.getElementById("p2CharacterList").textContent;
  assert.match(list, /Lip-sync बंद/, "a character with no rig must be marked: " + list);
  assert.match(list, /स्थिर तस्वीर/, "the honest consequence must be stated");
  dom.window.close();
});
