"use strict";

// SEO package, thumbnail and the optional access gate. The Gemini client is a
// fake; the thumbnail is a real FFmpeg encode of a real PNG.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-seo-"));
process.env.DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "test-key-not-real";
process.env.GEMINI_SCRIPT_MODEL = "test-script-model";
process.env.GEMINI_IMAGE_MODEL = "test-image-model";
process.env.GEMINI_TTS_MODEL = "test-tts-model";
process.env.APP_ACCESS_KEY = "test-access-key";

const { app, setAIClientFactoryForTests, resetAIClientFactory } = require("../server");
const { ProjectStore, createProject } = require("../lib/projects");
const { authedHeaders } = require("./helpers");
const ffmpegTools = require("../lib/ffmpeg");

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fakeGemini() {
  return {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          title: "टोटो और जंगल की खोज",
          description: "एक प्यारी कहानी।",
          tags: ["hindi cartoon", "kids story"],
          hashtags: ["#HindiCartoon", "#KidsStory"],
          thumbnailText: "जंगल की खोज",
        }),
      }),
    },
  };
}

let server;
let base;

async function call(url, options = {}) {
  const headers = Object.assign({}, await authedHeaders(base), (options && options.headers) || {});
  return fetch(base + url, { ...(options || {}), headers });
}

test("start server", async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

test("health stays open but other APIs require the access key", async () => {
  const health = await call("/api/health");
  assert.equal(health.status, 200);

  const denied = await call("/api/projects");
  assert.equal(denied.status, 401);
  assert.match((await denied.json()).error, /Access key/);

  const allowed = await call("/api/projects", { headers: { "x-access-key": "test-access-key" } });
  assert.equal(allowed.status, 200);

  const session = await authedHeaders(base);
  const cookie = await call("/api/projects", {
    headers: { Cookie: session.Cookie + "; baba_access_key=test-access-key" },
  });
  assert.equal(cookie.status, 200);
});

test("SEO package is generated and stored on the project", async () => {
  setAIClientFactoryForTests(fakeGemini);
  try {
    const store = new ProjectStore({ root: path.join(dataDir, "projects") });
    const project = createProject({ topic: "टोटो और जंगल की खोज", durationMinutes: 1, sceneCount: 3 });
    project.story = {
      title: "टोटो और जंगल की खोज",
      characters: [],
      scenes: [{ index: 1, title: "दृश्य 1", narration: "narration", dialogue: [], imagePrompt: "p" }],
    };
    store.save(project);

    const response = await call("/api/projects/" + project.id + "/seo", {
      method: "POST",
      headers: { "x-access-key": "test-access-key" },
    });
    assert.equal(response.status, 200);
    const { seo } = await response.json();
    assert.equal(seo.title, "टोटो और जंगल की खोज");
    assert.deepEqual(seo.tags, ["hindi cartoon", "kids story"]);
    assert.ok(seo.description.length > 0);

    const stored = await call("/api/projects/" + project.id + "/seo", { headers: { "x-access-key": "test-access-key" } });
    assert.equal((await stored.json()).seo.hashtags[0], "#HindiCartoon");
  } finally {
    resetAIClientFactory();
  }
});

test("thumbnail is a real JPEG built from scene 1", async () => {
  const store = new ProjectStore({ root: path.join(dataDir, "projects") });
  const project = createProject({ topic: "thumbnail", durationMinutes: 1, sceneCount: 3 });
  const sceneDir = path.join(store.dirFor(project.id), "scenes");
  fs.mkdirSync(sceneDir, { recursive: true });
  const imagePath = path.join(sceneDir, "scene-0001.png");
  fs.writeFileSync(imagePath, Buffer.from(PNG_1X1, "base64"));
  project.assets.scenes[1] = { image: { path: imagePath, mime: "image/png" } };
  store.save(project);

  const response = await call("/api/projects/" + project.id + "/thumbnail", {
    method: "POST", headers: { "x-access-key": "test-access-key" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(["image-only", "image+title"].includes(body.thumbnail.mode));

  const image = await call("/api/projects/" + project.id + "/thumbnail", { headers: { "x-access-key": "test-access-key" } });
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type") || "", /image\/jpeg/);
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8, "payload is a real JPEG");
});

test("thumbnail without a scene image returns 409, not a fake file", async () => {
  const store = new ProjectStore({ root: path.join(dataDir, "projects") });
  const project = createProject({ topic: "empty", durationMinutes: 1, sceneCount: 3 });
  store.save(project);
  const response = await call("/api/projects/" + project.id + "/thumbnail", {
    method: "POST", headers: { "x-access-key": "test-access-key" },
  });
  assert.equal(response.status, 409);
});

test("stop server", async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
