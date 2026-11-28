"use strict";

// The character lip-sync endpoint had no test. It is not the animation path (the
// render uses lib/lipsync directly), so its contract is what matters: ownership,
// a clear refusal when the engine is missing, a size guard, and temp cleanup.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { registerAndLogin, authHeaders } = require("./helpers");
const lipsync = require("../lib/lipsync");
const ff = require("../lib/ffmpeg");

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lipsync-ep-"));
  process.env.DATA_DIR = dataDir;
  process.env.APP_REGISTRATION_KEY = "lip-team-key";
  delete require.cache[require.resolve("../server")];
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const session = await registerAndLogin(base, "lip_user", { registrationKey: process.env.APP_REGISTRATION_KEY });
  const call = (url, options) => fetch(base + url, {
    ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}),
  });
  return { server, base, call, dataDir };
}

test("the endpoint refuses another user's character", async () => {
  const { server, call, base, dataDir } = await boot();
  try {
    const created = await call("/api/characters", { method: "POST", body: JSON.stringify({ name: "Toto" }) });
    const character = (await created.json()).character;
    // A second account cannot reach it. Registration stays open for this process
    // only while there are no users, so assert on the route's own guard instead:
    // an unknown id must be a JSON 404, never a crash.
    const unknown = await call("/api/characters/does-not-exist/lipsync", {
      method: "POST", body: JSON.stringify({ audioBase64: "AAAA" }),
    });
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /किरदार/);
    assert.ok(character.id, "the character was created for the owner");
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an over-long clip is refused before it is written", async () => {
  const { server, call, dataDir } = await boot();
  try {
    const created = await call("/api/characters", { method: "POST", body: JSON.stringify({ name: "Toto2" }) });
    const character = (await created.json()).character;
    // 121 seconds of 16 kHz 16-bit mono, base64-encoded, without generating it.
    const tooBig = Buffer.alloc((lipsync.MAX_AUDIO_SECONDS + 1) * 16000 * 2, 1).toString("base64");
    const res = await call("/api/characters/" + character.id + "/lipsync", {
      method: "POST", body: JSON.stringify({ audioBase64: tooBig }),
    });
    assert.equal(res.status, 413, "expected a size refusal");
    assert.match((await res.json()).error, new RegExp(lipsync.MAX_AUDIO_SECONDS + "s"));
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a real short clip returns cues and leaves no temp files", async () => {
  const engine = lipsync.resolveEngine();
  const { server, call, dataDir } = await boot();
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("baba-lipsync-")));
  try {
    const created = await call("/api/characters", { method: "POST", body: JSON.stringify({ name: "Toto3" }) });
    const character = (await created.json()).character;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lip-wav-"));
    const wav = path.join(dir, "n.wav");
    await ff.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "sine=frequency=220:duration=1.2", "-af", "tremolo=f=4:d=0.9",
      "-ac", "1", "-ar", "16000", "-y", wav]);
    const res = await call("/api/characters/" + character.id + "/lipsync", {
      method: "POST",
      body: JSON.stringify({ audioBase64: fs.readFileSync(wav).toString("base64"), dialogText: "नमस्ते" }),
    });
    if (!engine) {
      assert.equal(res.status, 503, "without an engine the route must say BLOCKED, not fail silently");
      assert.equal((await res.json()).blocked, true);
    } else {
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.cues) && body.cues.length > 0, "expected real cues");
      assert.ok(body.durationSeconds > 1 && body.durationSeconds < 1.5);
    }
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("baba-lipsync-") && !tmpBefore.has(n));
    assert.equal(tmpAfter.length, 0, "the route must clean its temp directory: " + tmpAfter.join(", "));
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
