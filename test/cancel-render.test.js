"use strict";

// Cancellation during the render stage, end to end through the HTTP API.
//
// Measured before the fix: cancel returned HTTP 200 while the project was
// "rendering", the render then ran to the end, the project became "completed"
// and the video was backed up — the user's cancel was silently ignored, and a
// cancelled video was presented as a finished one. Both halves are pinned here,
// plus the second bug the fix exposed: a cancelled project could never be
// finished again, because the stale flag also stopped the resume.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ffmpegTools = require("../lib/ffmpeg");
const { registerAndLogin, authHeaders } = require("./helpers");

// A fake Gemini that really answers, so the pipeline runs for real. Ten scenes
// keep the render long enough to cancel in the middle of it.
function fakeClientFactory(pngBase64, toneBase64) {
  return () => ({
    models: {
      generateContent: async (args) => {
        if (!args.config) {
          return {
            text: JSON.stringify({
              title: "रद्द परीक्षण",
              scenes: Array.from({ length: 10 }, (_, i) => ({
                title: "दृश्य " + i, narration: "दृश्य " + (i + 1) + " का वर्णन यहाँ है।", imagePrompt: "x " + i,
              })),
            }),
          };
        }
        if ((args.config.responseModalities || []).includes("IMAGE")) {
          return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pngBase64 } }] } }] };
        }
        return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: toneBase64 } }] } }] };
      },
    },
  });
}

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-render-"));
  process.env.DATA_DIR = dataDir;
  process.env.APP_REGISTRATION_KEY = "cancel-key";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  process.env.FFMPEG_PRESET = "ultrafast";

  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-fixtures-"));
  const imagePath = path.join(fixtures, "scene.png");
  const audioPath = path.join(fixtures, "voice.wav");
  await ffmpegTools.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=0x1b3b2a:s=1280x720:d=1", "-vf", "drawgrid=w=90:h=720:t=45:c=0xf0b040@0.9",
    "-frames:v", "1", "-y", imagePath]);
  await ffmpegTools.runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=200:duration=1.2", "-ac", "1", "-ar", "24000", "-y", audioPath]);

  delete require.cache[require.resolve("../server")];
  const server = require("../server");
  server.setAIClientFactoryForTests(fakeClientFactory(
    fs.readFileSync(imagePath).toString("base64"),
    fs.readFileSync(audioPath).toString("base64"),
  ));
  const http = server.app.listen(0, "127.0.0.1");
  await new Promise(resolve => http.once("listening", resolve));
  const base = "http://127.0.0.1:" + http.address().port;
  const session = await registerAndLogin(base, "cancel_user");
  const call = (url, options) => fetch(base + url, {
    ...(options || {}), headers: authHeaders(session, (options && options.headers) || {}),
  });
  const project = async id => (await (await call("/api/projects/" + id)).json()).project;
  const close = () => {
    http.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fixtures, { recursive: true, force: true });
  };
  return { call, project, close, dataDir };
}

test("cancelling a render leaves an honest cancelled state, then resumes to completion", { timeout: 600000 }, async () => {
  if (!(await ffmpegTools.ffmpegAvailable())) {
    return test.skip("FFmpeg binary not available (set FFMPEG_PATH)");
  }
  const { call, project, close, dataDir } = await setup();
  try {
    const created = await call("/api/projects", {
      method: "POST", body: JSON.stringify({ topic: "रद्द", durationMinutes: 1, sceneCount: 10 }),
    });
    const id = (await created.json()).project.id;
    await call("/api/projects/" + id + "/automate", { method: "POST" });

    let cancelled = false;
    for (let i = 0; i < 240; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const current = await project(id);
      if (current.status === "rendering") {
        const res = await call("/api/projects/" + id + "/cancel", { method: "POST" });
        assert.ok([200, 202].includes(res.status), "cancel must be accepted: " + res.status);
        cancelled = true;
        break;
      }
      if (["completed", "failed", "cancelled"].includes(current.status)) break;
    }
    assert.equal(cancelled, true, "the render stage was never reached, so this test proved nothing");

    // The cancel route writes the flag instantly; what must be proven is that the
    // RENDER stopped. Only the renderer's own catch writes "... पर रोका गया", so
    // wait for that message specifically — waiting for "cancelled" alone would
    // pass even if the render kept going to the end (the original bug).
    let after = null;
    const stopped = /पर रोका गया/;
    for (let i = 0; i < 180; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      after = await project(id);
      if (after.progress && stopped.test(String(after.progress.message))) break;
      if (["completed", "failed"].includes(after.status)) break;
    }
    assert.equal(after.status, "cancelled", "a cancelled render must not be reported as " + after.status);
    assert.equal(after.progress.stage, "cancelled");
    assert.match(String(after.progress.message), stopped,
      "the renderer must report where it stopped, got: " + after.progress.message);
    assert.ok(!after.render || !after.render.videoPath, "no finished MP4 may be attached to a cancelled run");
    assert.ok(!after.backup || !after.backup.location, "a cancelled render must not be backed up as finished");

    // Work already done stays on disk, so the retry is a resume rather than a
    // repeat of the whole paid generation.
    const clips = fs.existsSync(path.join(dataDir, "projects", id, "render"))
      ? fs.readdirSync(path.join(dataDir, "projects", id, "render"), { recursive: true }).join(" ")
      : "";
    assert.match(clips, /clips|chunk/, "finished intermediates must be kept: " + clips);

    // And the project must still be finishable: the cancel flag is cleared by an
    // explicit new run, otherwise "cancelled" would be a dead end. Allow the job
    // lock a moment to clear: a 409 here means the old job is still winding down.
    let resumed = null;
    for (let i = 0; i < 30; i++) {
      resumed = await call("/api/projects/" + id + "/automate", { method: "POST" });
      if (resumed.status !== 409) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok([200, 202].includes(resumed.status), "resume must be accepted: " + resumed.status);
    let final = null;
    for (let i = 0; i < 420; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      final = await project(id);
      if (["completed", "failed", "cancelled"].includes(final.status)) break;
    }
    assert.equal(final.status, "completed", "the resumed render must finish: " + (final.error || ""));
    assert.ok(final.render && final.render.videoPath, "the resumed render must produce an MP4");
    assert.ok(final.render.size > 10000, "the MP4 must be real: " + final.render.size);
  } finally {
    close();
  }
});

test("cancelling a project that is not running changes nothing it should not", async () => {
  const { call, project, close } = await setup();
  try {
    const created = await call("/api/projects", {
      method: "POST", body: JSON.stringify({ topic: "शांत", durationMinutes: 1, sceneCount: 3 }),
    });
    const id = (await created.json()).project.id;
    const before = await project(id);
    const res = await call("/api/projects/" + id + "/cancel", { method: "POST" });
    assert.ok([200, 409].includes(res.status), "unexpected status " + res.status);
    const after = await project(id);
    // Either the cancel is refused, or it is recorded — never a fabricated success.
    if (res.status === 200) {
      assert.equal(after.status, "cancelled");
    } else {
      assert.equal(after.status, before.status, "a refused cancel must not change the project");
    }
  } finally {
    close();
  }
});
