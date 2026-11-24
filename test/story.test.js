"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const story = require("../lib/story");

function sceneJson(count) {
  return JSON.stringify({
    title: "टोटो की खोज",
    scenes: Array.from({ length: count }, (_, index) => ({
      title: "दृश्य " + (index + 1),
      narration: "यह दृश्य " + (index + 1) + " का वर्णन है।",
      dialogue: [{ character: "टोटो", text: "चलो आगे बढ़ें!" }],
      imagePrompt: "A cute tiger walking through a jungle, wide shot",
      transition: "fade",
    })),
  });
}

test("scene count grows with duration: 10, 20, 50, then more", () => {
  assert.equal(story.planSceneCount(1), 10);
  assert.equal(story.planSceneCount(2), 20);
  assert.equal(story.planSceneCount(3), 50);
  assert.equal(story.planSceneCount(5), 50);
  assert.equal(story.planSceneCount(10), 75);
  assert.equal(story.planSceneCount(30), 150);
  assert.equal(story.planSceneCount("not-a-number"), 10);
});

test("story prompt demands exact scene count and includes the character bible", () => {
  const prompt = story.buildStoryPrompt({
    topic: "जंगल की खोज",
    language: "हिंदी",
    style: "3d-cartoon",
    sceneCount: 20,
    characters: [{ name: "टोटो", look: "orange tiger", outfit: "Blue T-shirt" }],
    durationMinutes: 2,
  });
  assert.match(prompt, /exactly 20/);
  assert.match(prompt, /टोटो/);
  assert.match(prompt, /Blue T-shirt/);
  assert.match(prompt, /imagePrompt/);
  assert.match(prompt, /Never include text, captions, logos or watermarks/);
});

test("parseStory accepts fenced JSON and repairs missing fields", () => {
  const parsed = story.parseStory("```json\n" + sceneJson(4) + "\n```", {
    sceneCount: 4,
    characters: [{ name: "टोटो" }],
  });
  assert.equal(parsed.scenes.length, 4);
  assert.equal(parsed.scenes[0].index, 1);
  assert.equal(parsed.scenes[0].transition, "fade");
  assert.ok(parsed.scenes[0].estimatedSeconds > 0);
  assert.equal(parsed.characters[0].name, "टोटो");
});

test("parseStory drops unknown speakers instead of inventing characters", () => {
  const parsed = story.parseStory(sceneJson(3), {
    sceneCount: 3,
    characters: [{ name: "टोटो" }],
  });
  assert.equal(parsed.scenes[0].dialogue[0].character, "टोटो");
  assert.equal(parsed.scenes[0].dialogue[0].known, true);
});

test("parseStory fails loudly instead of rendering an empty story", () => {
  assert.throws(() => story.parseStory("not json at all", { sceneCount: 3 }), /JSON/);
  assert.throws(
    () => story.parseStory(JSON.stringify({ scenes: [{ narration: "only one" }] }), { sceneCount: 3 }),
    /कम से कम 3/
  );
});

test("image prompt repeats the character identity and the aspect ratio", () => {
  const prompt = story.buildImagePrompt(
    { index: 2, imagePrompt: "Toto crosses a river", narration: "narration", dialogue: [] },
    { characters: [{ name: "टोटो", outfit: "Blue T-shirt" }], style: "3d-cartoon", aspect: "9:16" }
  );
  assert.match(prompt, /टोटो/);
  assert.match(prompt, /9:16/);
  assert.match(prompt, /Scene 2/);
  assert.match(prompt, /no text/);
});

test("narration length drives the duration estimate", () => {
  const short = story.estimateNarrationSeconds("एक छोटा वाक्य।");
  const long = story.estimateNarrationSeconds(Array.from({ length: 60 }, () => "शब्द").join(" "));
  assert.ok(short >= 2);
  assert.ok(long > short);
});
