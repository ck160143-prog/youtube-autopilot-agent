"use strict";

// A new story used to leave the previous story's assets in place. Measured: a
// 6-scene story replaced by a 3-scene story kept 6 asset entries, so the render
// showed the OLD story's pictures (or looked for images that were never made).
// This is reachable from the dashboard now that "rewrite the story" has a button.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pipeline = require("../lib/pipeline");
const { ProjectStore, createProject } = require("../lib/projects");

function providerWith(sceneCount) {
  return {
    text: {
      generate: async () => JSON.stringify({
        title: "नई कहानी",
        scenes: Array.from({ length: sceneCount }, (_, i) => ({
          title: "दृश्य " + i, narration: "नई कहानी का दृश्य " + i, imagePrompt: "prompt " + i,
        })),
      }),
    },
  };
}

test("regenerating the story discards every asset made for the old one", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "story-reset-"));
  const store = new ProjectStore({ root: path.join(dataDir, "projects") });
  const project = createProject({ ownerId: "u", topic: "t", durationMinutes: 1, sceneCount: 6 });

  // A previous successful run: 6 scenes, each with an image and a voice clip.
  project.story = {
    title: "पुरानी", scenes: Array.from({ length: 6 }, (_, i) => ({ index: i, title: "old" + i, narration: "पुराना " + i })),
  };
  project.assets = {
    scenes: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, {
      image: { path: "/nonexistent/old-" + i + ".png", provider: "old" },
      audio: { path: "/nonexistent/old-" + i + ".wav", source: "old" },
    }])),
  };
  project.timeline = [{ index: 0, duration: 10 }];
  store.save(project);

  await pipeline.generateStory(project, { provider: providerWith(3), characters: [] });

  assert.equal(project.story.scenes.length, 3);
  assert.deepEqual(project.assets.scenes, {},
    "stale assets survived: " + JSON.stringify(Object.keys(project.assets.scenes)));
  assert.equal(project.timeline, null, "an old timeline would describe the old story");
  // The shape must stay what the store and the pipeline expect.
  assert.ok(project.assets && typeof project.assets.scenes === "object");
});

test("a failed story regeneration leaves the previous story and assets intact", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "story-fail-"));
  const store = new ProjectStore({ root: path.join(dataDir, "projects") });
  const project = createProject({ ownerId: "u", topic: "t", durationMinutes: 1, sceneCount: 3 });
  project.story = { title: "अच्छी", scenes: [{ index: 0, title: "a", narration: "मौजूदा" }] };
  project.assets = { scenes: { 0: { image: { path: "/tmp/keep.png" }, audio: { path: "/tmp/keep.wav" } } } };
  store.save(project);

  // The model returns garbage: parseStory throws before anything is replaced.
  await assert.rejects(() => pipeline.generateStory(project, {
    provider: { text: { generate: async () => "not json at all" } }, characters: [],
  }));

  assert.equal(project.story.title, "अच्छी", "a failed attempt must not destroy the working story");
  assert.ok(project.assets.scenes[0] && project.assets.scenes[0].image,
    "a failed attempt must not destroy usable assets");
});
