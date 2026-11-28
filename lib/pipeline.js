"use strict";

// Provider-agnostic production pipeline: story -> per-scene image + voice ->
// timeline -> FFmpeg render. Providers are injected, so the whole chain is
// testable without network access; the Express layer wires the real Gemini
// adapters and this module never touches process.env directly.

const fs = require("fs");
const path = require("path");

const story = require("./story");
const timelineLib = require("./timeline");
const renderer = require("./renderer");
const charactersLib = require("./characters");
const lipsync = require("./lipsync");
const animator = require("./animator");

const IMAGE_SIGNATURES = {
  "image/png": bytes => bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  "image/jpeg": bytes => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/webp": bytes => bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
};

function extensionFor(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

// Write an image only if the bytes really match the declared type. Declared
// MIME alone is not evidence: a mislabelled payload must not reach FFmpeg.
function saveImage(sceneDir, index, result) {
  const mime = String((result && result.mimeType) || "image/png").toLowerCase();
  const bytes = Buffer.from(String((result && result.imageBase64) || ""), "base64");
  const check = IMAGE_SIGNATURES[mime];
  if (!check || !check(bytes)) {
    throw Object.assign(
      new Error("दृश्य " + index + " की image फ़ाइल signature नहीं मिली (PNG/JPEG/WebP चाहिए)।"),
      { statusCode: 502 }
    );
  }
  const filePath = path.join(sceneDir, "scene-" + String(index).padStart(4, "0") + "." + extensionFor(mime));
  fs.writeFileSync(filePath, bytes);
  return { path: filePath, mime, bytes: bytes.length, source: result.source || "ai" };
}

function wavHeader({ sampleRate, channels, bitsPerSample, dataBytes }) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// Normalise any provider audio (raw PCM, WAV, MP3...) into a 44.1 kHz stereo
// WAV so the renderer has one predictable input and real durations.
async function saveAudio(sceneDir, index, result, runFfmpeg) {
  const mime = String((result && result.mimeType) || "").toLowerCase();
  const bytes = Buffer.from(String((result && result.audioBase64) || ""), "base64");
  if (!bytes.length) {
    throw Object.assign(new Error("दृश्य " + index + " की आवाज़ खाली मिली।"), { statusCode: 502 });
  }
  const outPath = path.join(sceneDir, "voice-" + String(index).padStart(4, "0") + ".wav");
  if (mime.includes("l16") || mime.includes("pcm")) {
    const rateMatch = mime.match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const header = wavHeader({ sampleRate, channels: 1, bitsPerSample: 16, dataBytes: bytes.length });
    fs.writeFileSync(outPath, Buffer.concat([header, bytes]));
  } else {
    const rawPath = path.join(sceneDir, "voice-" + String(index).padStart(4, "0") + ".bin");
    fs.writeFileSync(rawPath, bytes);
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y", "-i", rawPath,
      "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", outPath,
    ]);
    fs.rmSync(rawPath, { force: true });
  }
  const info = await require("./ffmpeg").probe(outPath);
  // A zero-length or sub-frame clip means the provider returned noise, not
  // speech; rendering it would silently drop this scene's narration.
  if (!Number.isFinite(info.duration) || info.duration < 0.3) {
    throw Object.assign(
      new Error("दृश्य " + index + " की आवाज़ बहुत छोटी/खाली मिली (" + (info.duration || 0).toFixed(2) + "s)।"),
      { statusCode: 502 }
    );
  }
  return {
    path: outPath,
    mime: "audio/wav",
    seconds: info.duration,
    voice: (result && result.voiceName) || null,
    bytes: bytes.length,
  };
}

async function generateStory(project, options) {
  const { provider, characters } = options;
  const prompt = story.buildStoryPrompt({
    topic: project.topic,
    language: project.language,
    style: project.style,
    sceneCount: project.sceneCount,
    characters: characters || [],
    durationMinutes: project.durationMinutes,
    // When the project has a research brief, the writer must stay faithful to it.
    researchContext: project.research
      ? require("./research").researchContextForPrompt(project.research)
      : "",
  });
  const text = await provider.text.generate(prompt);
  const parsed = story.parseStory(text, {
    sceneCount: project.sceneCount,
    characters: characters || [],
    language: project.language,
    style: project.style,
  });
  project.story = parsed;
  project.sceneCount = parsed.scenes.length;
  // A new story invalidates every asset made for the old one. Without this, a
  // shorter story kept the previous scenes' images and audio (6 stale entries
  // for a 3-scene story), and the render showed the old story's pictures — or
  // failed looking for images that were never made. Measured before the fix.
  project.assets = { scenes: {} };
  project.timeline = null;
  return parsed;
}

function buildTimeline(project, measured) {
  const targetSeconds = project.durationMinutes * 60;
  const entries = timelineLib.planTimeline(project.story.scenes, {
    targetSeconds,
    durations: measured,
  });
  project.timeline = entries;
  return entries;
}

async function generateAssets(project, options) {
  const { provider, store, runFfmpeg, onProgress = () => {}, onlyScenes = null } = options;
  const sceneDir = path.join(store.dirFor(project.id), "scenes");
  fs.mkdirSync(sceneDir, { recursive: true });
  const characters = (project.story && project.story.characters) || [];
  const list = project.story.scenes.filter(scene =>
    !onlyScenes || onlyScenes.includes(Number(scene.index))
  );
  let done = 0;
  for (const scene of list) {
    const current = (project.assets.scenes[scene.index] = project.assets.scenes[scene.index] || {});
    if (!current.image || !fs.existsSync(current.image.path)) {
      onProgress({
        stage: "generating", percent: Math.round((done / list.length) * 40),
        message: "दृश्य " + scene.index + " की image बन रही है", scene: scene.index,
      });
      const imageResult = await provider.image.generate(story.buildImagePrompt(scene, {
        characters, style: project.style, aspect: project.aspect,
      }));
      current.image = saveImage(sceneDir, scene.index, imageResult);
      // Signature match is not enough: a one-colour image is a failed
      // generation and would silently produce a blank scene in the MP4.
      const blank = await require("./media").detectBlankImage({ imagePath: current.image.path });
      if (blank.blank) {
        fs.rmSync(current.image.path, { force: true });
        throw Object.assign(
          new Error("दृश्य " + scene.index + " की image blank मिली (luma spread " + blank.spread + ") — retry करें।"),
          { statusCode: 502 }
        );
      }
      store.save(project);
    }
    if (!current.audio || !fs.existsSync(current.audio.path)) {
      onProgress({
        stage: "generating", percent: 40 + Math.round((done / list.length) * 40),
        message: "दृश्य " + scene.index + " की आवाज़ बन रही है", scene: scene.index,
      });
      const speaker = pickSpeaker(scene, characters);
      const spoken = spokenText(scene);
      const audioResult = await provider.voice.generate(spoken, {
        voiceName: speaker ? speaker.voiceName : undefined,
        character: speaker ? speaker.name : null,
      });
      current.audio = await saveAudio(sceneDir, scene.index, audioResult, runFfmpeg);
      store.save(project);
    }
    done++;
  }
  onProgress({ stage: "generating", percent: 80, message: "सभी scenes के assets तैयार" });
  return project;
}

function pickSpeaker(scene, characters) {
  const line = (scene.dialogue || [])[0];
  if (!line) return characters[0] || null;
  return characters.find(c => c.name.toLowerCase() === String(line.character).toLowerCase()) || characters[0] || null;
}

function spokenText(scene) {
  const narration = String(scene.narration || "").trim();
  const dialogue = (scene.dialogue || []).map(d => d.text).filter(Boolean).join(" ");
  return (narration + " " + dialogue).trim();
}

async function render(project, options) {
  const { store, runFfmpeg, onProgress = () => {}, userMusicPath, userMusicLicense } = options;
  const layout = timelineLib.layoutFor(project.aspect, project.quality);
  const measured = {};
  for (const [index, asset] of Object.entries(project.assets.scenes)) {
    if (asset && asset.audio && Number(asset.audio.seconds) > 0) measured[index] = asset.audio.seconds;
  }
  const entries = buildTimeline(project, measured);
  store.save(project);

  // 2D lip-sync: only when the scene's speaker has a rig with real mouth
  // sprites and a real analysis engine is installed. Otherwise nothing happens
  // and the render stays an honest narrated slideshow.
  const lipSyncEnabled = options.lipSync !== false && Boolean(lipsync.resolveEngine());
  const lipSyncStats = { scenes: 0, cues: 0, shapes: [] };
  const rigForScene = scene => {
    const speakerName = (scene.dialogue && scene.dialogue[0] && scene.dialogue[0].character) ||
      (scene.characters && scene.characters[0]) || "";
    if (!speakerName) return null;
    // Prefer the live character library: a rig uploaded after the story was
    // written must still be found.
    const cast = (options.characters && options.characters.length)
      ? options.characters
      : ((project.story && project.story.characters) || []);
    const match = cast.find(item => String(item.name || "").toLowerCase() === String(speakerName).toLowerCase());
    const character = match || null;
    if (!character || !character.rig || !character.rig.animationReady) return null;
    return character;
  };

  const result = await renderer.renderProject({
    project,
    workDir: path.join(store.dirFor(project.id), "render"),
    runFfmpeg,
    afterSceneClip: async ({ clipPath, entry, scene, layout, resumed }) => {
      if (!lipSyncEnabled) return null;
      const character = rigForScene(scene);
      if (!character) return null;
      const asset = project.assets.scenes[entry.index];
      if (!asset || !asset.audio || !fs.existsSync(asset.audio.path)) return null;
      const outPath = clipPath.replace(/\.mp4$/, ".lip.mp4");
      if (resumed && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return { path: outPath };
      try {
        const analysis = await lipsync.analyseAudioCached({
          audioPath: asset.audio.path,
          dialogText: (scene.narration || "") + " " + (scene.dialogue || []).map(d => d.text).join(" "),
          runFfmpeg,
        });
        const readiness = animator.animationReadiness(character, analysis.cues);
        if (!readiness.ready) return null;
        const applied = await animator.applyMouthCues({
          runFfmpeg, videoPath: clipPath, cues: analysis.cues,
          sprites: character.rig.mouth, anchor: character.rig.anchor,
          width: layout.width, height: layout.height, outPath,
        });
        if (applied) {
          lipSyncStats.scenes += 1;
          lipSyncStats.cues += applied.cuesApplied;
          lipSyncStats.shapes = Array.from(new Set(lipSyncStats.shapes.concat(applied.shapes)));
        }
        return applied ? { path: applied.path } : null;
      } catch (error) {
        // A failed overlay must not lose the whole render; the clean clip stays.
        options.onProgress && onProgress({
          stage: "rendering",
          warning: "lip-sync overlay skip: " + String(error.message || error).slice(0, 120),
        });
        return null;
      }
    },
    layout,
    timeline: entries,
    scenes: project.story.scenes,
    perChunk: options.perChunk || 10,
    // Precedence: an explicit call-site option (tests, resume re-runs), then
    // the choice the user made for this project, then the historical default.
    motion: options.motion || project.motion || "kenburns-in",
    transition: "fade",
    music: options.music !== undefined ? options.music !== false : project.music !== false,
    burnSubtitles: options.burnSubtitles !== false,
    soundEffects: options.soundEffects !== undefined ? options.soundEffects !== false : project.soundEffects !== false,
    userMusicPath,
    userMusicLicense,
    musicVolume: options.musicVolume,
    captionFont: options.captionFont,
    fontsDir: require("./fonts").resolveFontDir(),
    onProgress: event => onProgress({ stage: "rendering", ...event }),
  });
  project.render = {
    ...result,
    lipSync: lipSyncStats.scenes ? lipSyncStats : { scenes: 0, cues: 0, shapes: [] },
    layout,
    aspect: project.aspect,
    quality: project.quality,
    renderedAt: new Date().toISOString(),
  };
  store.save(project);
  return result;
}

module.exports = {
  generateStory,
  generateAssets,
  buildTimeline,
  render,
  saveImage,
  saveAudio,
  spokenText,
  pickSpeaker,
  IMAGE_SIGNATURES,
};
