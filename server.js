
require("dotenv").config();

const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

// Render payloads contain base64-encoded scene images plus narration; allow the documented 12 MB image + 8 MB audio payload with base64 overhead.
app.use(express.json({ limit: "35mb" }));
app.use(express.static("dist"));

const crypto = require("crypto");

// Bounded in-memory LRU: max 12 successful audio responses; cleared on restart.
const ttsCache = new Map();
const TTS_CACHE_MAX = 12;
const TTS_CACHE_MAX_BYTES = 24 * 1024 * 1024;
let ttsCacheBytes = 0;

function getStatus(error) {
  const raw = error?.status ?? error?.statusCode ?? error?.code;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  const match = String(error?.message || "").match(/\b(429|500|502|503|504)\b/);
  return match ? Number(match[1]) : 0;
}

function isQuotaError(error) {
  // Do not classify generic billing/permission messages as quota exhaustion.
  // Stop retries for explicit provider quota/rate-limit responses only.
  return getStatus(error) === 429 ||
    /RESOURCE_EXHAUSTED|quota(?:\s+has been)?\s+(?:exceeded|exhausted)|rate[ -]?limit/i.test(String(error?.message || ""));
}

function safeLog(label, error) {
  // Do not log request bodies, API keys, or raw provider payloads.
  console.error(label, { status: getStatus(error), code: String(error?.code || "").slice(0, 80) });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTemporaryRetries(operation, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const status = getStatus(error);
      if (status === 429 || isQuotaError(error)) throw error;
      if (![500, 502, 503, 504].includes(status) || attempt >= maxRetries) throw error;
      // 300ms, then 600ms; keep retry budget small.
      await wait(300 * (2 ** attempt));
    }
  }
}

/**
 * Text generation gets one quota-aware fallback to a separately rate-limited,
 * lighter model. Never loop across models: if both are quota-limited, stop cleanly.
 */
async function generateTextWithQuotaFallback(ai, prompt, primaryModel) {
  try {
    const response = await withTemporaryRetries(() => ai.models.generateContent({
      model: primaryModel,
      contents: prompt,
    }));
    return { response, model: primaryModel };
  } catch (primaryError) {
    // A bad/stale Render model ID (404) and quota exhaustion (429) both get one safe fallback.
    // Do not cascade on auth errors or transient server failures.
    if (!isQuotaError(primaryError) && getStatus(primaryError) !== 404) throw primaryError;
    const fallbackModel = process.env.GEMINI_SCRIPT_FALLBACK_MODEL || "gemini-3.5-flash-lite";
    if (!fallbackModel || fallbackModel === primaryModel) {
      primaryError.model = primaryModel;
      throw primaryError;
    }
    try {
      const response = await withTemporaryRetries(() => ai.models.generateContent({
        model: fallbackModel,
        contents: prompt,
      }));
      return { response, model: fallbackModel, usedFallback: true };
    } catch (fallbackError) {
      if (isQuotaError(fallbackError)) {
        fallbackError.model = fallbackModel;
        fallbackError.primaryModel = primaryModel;
        fallbackError.message = "मुख्य मॉडल " + primaryModel + " पर quota (429) मिला और fallback मॉडल " + fallbackModel + " पर भी quota उपलब्ध नहीं है। " + String(fallbackError.message || "");
      } else if (getStatus(fallbackError) === 404) {
        fallbackError.model = fallbackModel;
        fallbackError.primaryModel = primaryModel;
        fallbackError.message = "मुख्य मॉडल " + primaryModel + " और fallback मॉडल " + fallbackModel + " में से कोई उपलब्ध नहीं मिला (404)। Render Environment में GEMINI_SCRIPT_MODEL और GEMINI_SCRIPT_FALLBACK_MODEL हटाएँ या सही model ID रखें।";
      }
      throw fallbackError;
    }
  }
}

function extractRetryHint(error) {
  // Google SDK errors may carry retryDelay in message/details. Return only a short hint,
  // never the raw provider payload.
  const detailStrings = [];
  if (typeof error?.message === "string") detailStrings.push(error.message);
  if (Array.isArray(error?.details)) {
    for (const detail of error.details) {
      if (typeof detail === "string") detailStrings.push(detail);
      else if (typeof detail?.retryDelay === "string") detailStrings.push("retryDelay: " + detail.retryDelay);
      else if (typeof detail?.metadata?.retryDelay === "string") detailStrings.push("retryDelay: " + detail.metadata.retryDelay);
    }
  }
  if (typeof error?.retryDelay === "string") detailStrings.push("retryDelay: " + error.retryDelay);
  const detailText = detailStrings.join(" ");
  const retry = detailText.match(/(?:please\s+)?(?:retry(?:\s+in)?|retryDelay|retry_after)\s*["']?\s*[:=]?\s*["']?([0-9]+(?:\.[0-9]+)?\s*(?:ms|s|seconds?|m|minutes?|h|hours?)(?:\s*[0-9]+(?:\.[0-9]+)?\s*(?:s|m|h))?)/i);
  if (retry) return retry[1].trim();
  const reset = detailText.match(/(?:reset(?:s|\s+at)?|retry\s+after)\s*[:=]?\s*["']?([^"'\n,;]{3,60})/i);
  return reset ? reset[1].trim() : null;
}

function quotaInfo(error, model, operation = "image generation") {
  const retryHint = extractRetryHint(error);
  const message = "Gemini " + operation + " quota समाप्त/सीमित है (429 RESOURCE_EXHAUSTED)। आगे की संबंधित requests रोक दी गईं। मॉडल: " + model +
    (retryHint ? " Google का retry/reset संकेत: " + retryHint + "." : " Google ने इस error में retry/reset समय नहीं दिया।") +
    " Google AI Studio में इसी API key/project का usage, quota और billing देखें।";
  return { model, retryHint, message };
}

function quotaMessage(kind, model, error) {
  const hint = extractRetryHint(error);
  if (kind === "voice") {
    return "Gemini TTS quota खत्म/सीमित है (429)।" + (model ? " मॉडल: " + model + "." : "") +
      (hint ? " Google का retry/reset संकेत: " + hint + "." : "") +
      " Google AI Studio में usage और quota जाँचें; quota खत्म होने पर बार-बार retry न करें।";
  }
  if (kind === "script" || kind === "seo") {
    return "Gemini " + (kind === "seo" ? "SEO" : "script") + " generation quota खत्म/सीमित है (429)।" +
      (model ? " मॉडल: " + model + "." : "") +
      (hint ? " Google का retry/reset संकेत: " + hint + "." : "") +
      " Google AI Studio में उसी API key/project का usage और quota जाँचें।";
  }
  return quotaInfo(error, model || process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1").message;
}

let aiClientFactory = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function setAIClientFactoryForTests(factory) {
  aiClientFactory = factory;
}

function resetAIClientFactory() {
  aiClientFactory = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY सेट नहीं है।");
    error.code = "NO_API_KEY";
    throw error;
  }

  return aiClientFactory();
}

function sendAPIError(res, error, fallbackMessage, kind) {
  safeLog(fallbackMessage, error);

  if (error.code === "NO_API_KEY") {
    return res.status(500).json({ error: "सर्वर पर Gemini API key configure नहीं है।" });
  }
  if (isQuotaError(error)) {
    const operationKind = kind || "script";
    const model = operationKind === "voice"
      ? (process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts")
      : operationKind === "images"
        ? (process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1")
        : (error.model || process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash");
    return res.status(429).json({ error: quotaMessage(operationKind, model, error) });
  }
  const status = getStatus(error);
  if ([500, 502, 503, 504].includes(status)) {
    return res.status(503).json({ error: "Google Gemini सर्वर पर अस्थायी समस्या (HTTP " + status + ") है। 30–60 सेकंड बाद दोबारा कोशिश करें। यदि लगातार हो, Render Logs में request का status देखें।" });
  }
  if (status === 401 || status === 403) {
    return res.status(502).json({ error: "Gemini API key स्वीकार नहीं हुई या इस मॉडल की अनुमति नहीं है (HTTP " + status + ")। Render Environment में GEMINI_API_KEY और Google AI Studio के उसी project की API access जाँचें।" });
  }
  if (status === 404) {
    return res.status(502).json({ error: "Gemini मॉडल नहीं मिला (HTTP 404)। Render Environment में GEMINI_SCRIPT_MODEL / GEMINI_IMAGE_MODEL / GEMINI_TTS_MODEL का model ID जाँचें।" });
  }
  if (status === 400) {
    return res.status(502).json({ error: "Gemini ने request अस्वीकार की (HTTP 400)। मॉडल/feature compatibility या request format जाँचें।" });
  }
  return res.status(500).json({ error: fallbackMessage + " (server status " + (status || "unknown") + ") Render Logs जाँचें।" });
}

// 1. सर्वर की स्थिति
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    message: "BABA AI सर्वर चल रहा है।",
  });
});

// 2. हिंदी आवाज़ बनाना
app.post("/api/voice", async (req, res) => {
  try {
    const text = req.body?.text;

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        error: "पहले स्क्रिप्ट तैयार करें।",
      });
    }

    // एक अनुरोध में बहुत लंबा टेक्स्ट भेजने से बचें।
    if (text.length > 5000) {
      return res.status(413).json({
        error:
          "स्क्रिप्ट बहुत लंबी है। आवाज़ के लिए इसे छोटे हिस्सों में बाँटना होगा।",
      });
    }

    const model = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
    const voiceName = "Kore";
    const cacheKey = crypto.createHash("sha256")
      .update(JSON.stringify([model, voiceName, text]))
      .digest("hex");

    // LRU hit: refresh recency and reuse only a previously successful audio result.
    if (ttsCache.has(cacheKey)) {
      const cached = ttsCache.get(cacheKey);
      ttsCache.delete(cacheKey);
      ttsCache.set(cacheKey, cached);
      const { _cacheBytes, ...cachedAudio } = cached;
      return res.json({ success: true, ...cachedAudio, cached: true });
    }

    const ai = getAIClient();
    const ttsModels = [...new Set([model, "gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"])];
    let response = null;
    let lastTtsError = null;
    for (let modelIndex = 0; modelIndex < ttsModels.length; modelIndex++) {
      const candidateModel = ttsModels[modelIndex];
      try {
        response = await withTemporaryRetries(() => ai.models.generateContent({
          model: candidateModel,
          contents: [{ parts: [{ text: "नैचुरल और स्पष्ट हिंदी में यह टेक्स्ट बोलें: " + text }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }));
        break;
      } catch (ttsError) {
        lastTtsError = ttsError;
        // Quota is not a model-ID issue; stop immediately instead of spending more requests.
        if (isQuotaError(ttsError)) throw ttsError;
        if (getStatus(ttsError) !== 404 || modelIndex === ttsModels.length - 1) throw ttsError;
      }
    }
    if (!response) throw lastTtsError || new Error("TTS model ने response नहीं दिया।");

    const parts = response.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(part => part.inlineData?.data);
    if (!audioPart) {
      return res.status(502).json({ error: "Gemini ने audio payload नहीं लौटाया। बाद में पुनः प्रयास करें।" });
    }

    const audioResult = {
      mimeType: audioPart.inlineData.mimeType || "audio/L16",
      audioBase64: audioPart.inlineData.data,
    };
    const audioBytes = Math.floor(audioResult.audioBase64.length * 0.75);
    // Skip caching unusually large clips; cache must stay within a bounded memory budget.
    if (audioBytes <= TTS_CACHE_MAX_BYTES) {
      ttsCache.set(cacheKey, { ...audioResult, _cacheBytes: audioBytes });
      ttsCacheBytes += audioBytes;
      while (ttsCache.size > TTS_CACHE_MAX || ttsCacheBytes > TTS_CACHE_MAX_BYTES) {
        const oldestKey = ttsCache.keys().next().value;
        const oldest = ttsCache.get(oldestKey);
        ttsCacheBytes -= oldest?._cacheBytes || 0;
        ttsCache.delete(oldestKey);
      }
    }
    return res.json({ success: true, ...audioResult, cached: false });
  } catch (error) {
    return sendAPIError(
      res,
      error,
      "आवाज़ नहीं बन सकी।", "voice"
    );
  }
});

// 3. पूरी AI स्क्रिप्ट
app.post("/api/script", async (req, res) => {
  try {
    const { topic, duration, language, visualStyle } = req.body || {};

    if (typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({
        error: "कृपया वीडियो का विषय लिखें।",
      });
    }

    if (topic.trim().length > 500) {
      return res.status(400).json({ error: "विषय 500 अक्षरों से छोटा रखें।" });
    }
    const videoLanguage = language === "English" ? "English" : "हिंदी";
    const style = ["3d-cartoon", "cinematic", "realistic"].includes(visualStyle) ? visualStyle : "3d-cartoon";
    const styleInstructions = style === "3d-cartoon"
      ? `यह 3D कार्टून कॉमेडी वीडियो है। स्क्रिप्ट में 2-4 भारतीय दोस्त/किरदार, छोटे स्वाभाविक हिंदी संवाद, चेहरे के स्पष्ट भाव, मजेदार प्रतिक्रिया, और हर दृश्य के लिए स्थान/एक्शन लिखें। पात्रों के नाम, कपड़े, बाल और पहचान पूरी कहानी में एक-जैसी रखें। दृश्य निर्देश AI 3D cartoon visuals के अनुकूल हों।`
      : style === "cinematic" ? "सिनेमैटिक वीडियो के लिए दृश्य निर्देश, कैमरा एंगल और ट्रांज़िशन दें।" : "वास्तविक तस्वीरों/फुटेज के लिए व्यावहारिक दृश्य निर्देश दें।";
    const parsedDuration = Number(duration);
    const videoDuration = Number.isFinite(parsedDuration) && parsedDuration >= 1 && parsedDuration <= 30
      ? parsedDuration : 30;

    const ai = getAIClient();

    const prompt = `आप एक अनुभवी YouTube स्क्रिप्ट लेखक हैं।

विषय: ${topic}
भाषा: ${videoLanguage}
वीडियो अवधि: ${videoDuration} मिनट
विज़ुअल स्टाइल: ${style}
${styleInstructions}

निर्देश:
1. पहले 30 सेकंड के लिए आकर्षक शुरुआत लिखें।
2. कम से कम 6 अध्याय बनाएँ।
3. हर अध्याय में शीर्षक, नैरेशन, दृश्य निर्देश और अगले दृश्य का ट्रांज़िशन दें।
4. प्राकृतिक बोलचाल की भाषा में पूरी स्क्रिप्ट लिखें।
5. तथ्य गढ़कर न लिखें; अनिश्चित दावों को स्पष्ट बताएँ।
6. अवधि के अनुरूप विस्तृत सामग्री दें।
7. अंत में निष्कर्ष और लाइक तथा सब्सक्राइब करने का अनुरोध दें।
8. आउटपुट ${videoLanguage} में दें।`;

    const primaryModel = process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash";
    const generated = await generateTextWithQuotaFallback(ai, prompt, primaryModel);
    const response = generated.response;

    const scriptText = response.text;

    if (!scriptText || !scriptText.trim()) {
      return res.status(502).json({
        error: "AI ने खाली स्क्रिप्ट लौटाई।",
      });
    }

    return res.json({ script: scriptText });
  } catch (error) {
    return sendAPIError(
      res,
      error,
      "स्क्रिप्ट नहीं बन सकी। Render Logs जाँचें।"
    );
  }
});

// 4. YouTube SEO
app.post("/api/seo", async (req, res) => {
  try {
    const { topic, language } = req.body || {};

    if (typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({
        error: "कृपया वीडियो का विषय लिखें।",
      });
    }

    if (topic.trim().length > 500) {
      return res.status(400).json({ error: "विषय 500 अक्षरों से छोटा रखें।" });
    }
    const videoLanguage = language === "English" ? "English" : "हिंदी";
    const ai = getAIClient();

    const prompt = `आप YouTube SEO विशेषज्ञ हैं।

विषय: ${topic}
भाषा: ${videoLanguage}

तैयार करें:
1. 3 आकर्षक शीर्षक।
2. वीडियो का विस्तृत विवरण।
3. 15-20 संबंधित कीवर्ड्स।
4. 10-15 हैशटैग्स।
5. थंबनेल के लिए 3 छोटे टेक्स्ट सुझाव।
6. YouTube टैग्स।

उत्तर ${videoLanguage} में दें। कीवर्ड्स और हैशटैग्स अंग्रेज़ी में भी हो सकते हैं।`;

    const primaryModel = process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash";
    const generated = await generateTextWithQuotaFallback(ai, prompt, primaryModel);
    const response = generated.response;

    const seoText = response.text;

    if (!seoText || !seoText.trim()) {
      return res.status(502).json({
        error: "AI ने खाली SEO उत्तर लौटाया।",
      });
    }

    return res.json({ seo: seoText });
  } catch (error) {
    return sendAPIError(
      res,
      error,
      "SEO जानकारी नहीं बन सकी। Render Logs जाँचें।"
    );
  }
});

// Free, license-attributed photo fallback for Gemini image quota failures.
// Search Commons explicitly, then fetch image metadata separately for better API compatibility.
async function findCommonsSceneImage(scene) {
  const stopWords = new Set(["the","and","with","from","that","this","for","into","over","under","cinematic","polished","youtube","friendly","landscape","image","photo","realistic","high","quality","16:9","no","text","watermark","a","an","of","in","on","to","at","is","are","was","were","ultra","detailed","wide","shot","lighting","style"]);
  const raw = String(scene?.title || "") + " " + String(scene?.prompt || "");
  const terms = raw.replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word.toLowerCase())).slice(0, 8);
  const primary = terms.join(" ").trim();
  const queries = [...new Set([primary, String(scene?.title || "").trim(), "Taj Mahal India", "Indian historical architecture"].filter(Boolean))];
  const clean = value => String(value?.value || "").replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 300);
  for (const searchTerm of queries) {
    try {
      const searchUrl = new URL("https://commons.wikimedia.org/w/api.php");
      searchUrl.search = new URLSearchParams({ action: "query", list: "search", srsearch: searchTerm, srnamespace: "6", srlimit: "8", format: "json", origin: "*" }).toString();
      const searchResponse = await fetch(searchUrl, { headers: { "User-Agent": "BABA-AI-YouTube-Agent/1.0 (scene-image-fallback)" }, signal: AbortSignal.timeout(10000) });
      if (!searchResponse.ok) continue;
      const searchData = await searchResponse.json();
      const titles = (searchData?.query?.search || []).map(item => item.title).filter(Boolean);
      if (!titles.length) continue;
      const infoUrl = new URL("https://commons.wikimedia.org/w/api.php");
      infoUrl.search = new URLSearchParams({ action: "query", titles: titles.join("|"), prop: "imageinfo", iiprop: "url|mime|extmetadata", iiurlwidth: "1280", format: "json", origin: "*" }).toString();
      const infoResponse = await fetch(infoUrl, { headers: { "User-Agent": "BABA-AI-YouTube-Agent/1.0 (scene-image-fallback)" }, signal: AbortSignal.timeout(10000) });
      if (!infoResponse.ok) continue;
      const infoData = await infoResponse.json();
      const pages = Object.values(infoData?.query?.pages || {});
      for (const page of pages) {
        const info = page?.imageinfo?.[0];
        const imageUrl = info?.thumburl || info?.url;
        if (!imageUrl || !/^https:\/\//i.test(imageUrl) || !/^image\/(png|jpeg|webp)$/i.test(info?.mime || "")) continue;
        try {
          const imageResponse = await fetch(imageUrl, { headers: { "User-Agent": "BABA-AI-YouTube-Agent/1.0" }, signal: AbortSignal.timeout(10000) });
          if (!imageResponse.ok) continue;
          const bytes = Buffer.from(await imageResponse.arrayBuffer());
          if (!bytes.length || bytes.length > 5 * 1024 * 1024) continue;
          const meta = info.extmetadata || {};
          const mimeType = info.mime === "image/jpeg" ? "image/jpeg" : (info.mime === "image/webp" ? "image/webp" : "image/png");
          return { mimeType, imageBase64: bytes.toString("base64"), source: "Wikimedia Commons", sourceUrl: info.descriptionurl || "https://commons.wikimedia.org/", title: clean(meta.ObjectName) || String(page.title || "Wikimedia Commons image").replace(/^File:/, ""), license: clean(meta.LicenseShortName) || "See source page", credit: clean(meta.Artist) || "See source page", attribution: clean(meta.Attribution) || clean(meta.Artist) || "See source page" };
        } catch (_) { /* try the next image */ }
      }
    } catch (_) { /* try the next broader query */ }
  }
  return null;
}

// 5. स्क्रिप्ट से अधिकतम 3 दृश्य-तस्वीरें बनाना (Gemini Image)
app.post("/api/images", async (req, res) => {
  let quotaModel = process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash";
  let quotaOperation = "script/scene planning";
  try {
    const script = req.body?.script;
    if (typeof script !== "string" || !script.trim()) {
      return res.status(400).json({ error: "पहले AI Script Studio में स्क्रिप्ट तैयार करें।" });
    }
    if (script.length > 30000) {
      return res.status(413).json({ error: "स्क्रिप्ट बहुत लंबी है। पहले छोटा भाग चुनें (30,000 अक्षरों तक)।" });
    }

    const ai = getAIClient();
    const scriptModel = process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash";
    const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1";
    const visualStyle = ["3d-cartoon", "cinematic", "realistic"].includes(req.body?.visualStyle) ? req.body.visualStyle : "3d-cartoon";
    const stylePrompt = visualStyle === "3d-cartoon"
      ? "High-quality polished 3D animated Indian comedy cartoon, stylized expressive characters, detailed Indian roadside tea stall or village street when appropriate, cinematic soft lighting, vibrant but natural colors, family-friendly, consistent character designs across every scene. Same characters must keep identical face, hairstyle, outfit and body proportions in all scenes. Clearly 3D CGI animation render, not a real photograph, not live-action. "
      : visualStyle === "cinematic" ? "Polished cinematic visual, detailed environment, cinematic lighting, consistent visual continuity. " : "Photorealistic real-world scene, documentary style, natural lighting. ";
    let scenes;
    // Failed-scene retries reuse the original prompts; they do not re-plan or regenerate successful scenes.
    if (Array.isArray(req.body?.scenePrompts) && req.body.scenePrompts.length) {
      scenes = req.body.scenePrompts.slice(0, 3).map((scene, index) => ({
        title: String(scene?.title || ("दृश्य " + (scene?.scene || index + 1))).slice(0, 120),
        prompt: typeof scene?.prompt === "string" ? scene.prompt : "",
        originalScene: Number.isInteger(Number(scene?.scene)) ? Number(scene.scene) : index + 1
      })).filter(scene => scene.prompt.trim());
      if (!scenes.length) return res.status(400).json({ error: "दोबारा बनाने के लिए वैध failed-scene prompts नहीं मिले।" });
    } else {
      quotaModel = scriptModel;
      let planResponse;
      try {
        planResponse = await withTemporaryRetries(() => ai.models.generateContent({
          model: scriptModel,
          contents: `इस वीडियो स्क्रिप्ट से 3 मुख्य दृश्य चुनें और हर दृश्य के लिए एक विस्तृत image prompt लिखें।
Visual style: ${visualStyle}. ${stylePrompt}
सभी दृश्य एक ही visual style में हों: polished, YouTube-friendly, 9:16 vertical composition, कोई लिखावट/टेक्स्ट/वॉटरमार्क नहीं। यदि पात्र हों तो हर दृश्य में उनका character design समान रखें।
स्क्रिप्ट:
${script.slice(0, 18000)}

केवल वैध JSON लौटाएँ, इस schema में:
{"scenes":[{"title":"दृश्य का छोटा शीर्षक","prompt":"English image prompt"}]}
3 से अधिक दृश्य न दें।`,
          config: { responseMimeType: "application/json" }
        }));
      } catch (planningError) {
        // In 3D-cartoon mode, never silently substitute real photos for requested cartoon artwork.
        if (!isQuotaError(planningError)) throw planningError;
        if (visualStyle === "3d-cartoon") {
          return res.status(429).json({
            success: false,
            error: quotaMessage("script", scriptModel, planningError) + " 3D कार्टून दृश्य बनाने के लिए image quota उपलब्ध होना चाहिए; इस मोड में वास्तविक फोटो को कार्टून बताकर नहीं दिखाया जाएगा।",
            images: [],
            failedScenes: [],
            model: scriptModel
          });
        }
        const topic = /ताजमहल|taj\s*mahal/i.test(script) ? "Taj Mahal India" :
          ((script.match(/(?:विषय|title|शीर्षक)\s*[:：-]\s*([^\n.!]{3,100})/i) || [])[1] || script.slice(0, 100)).trim();
        const fallbackScenes = [
          { scene: 1, title: topic + " — मुख्य दृश्य", prompt: "Real photograph of " + topic + " exterior, wide cinematic view" },
          { scene: 2, title: topic + " — वास्तुकला", prompt: "Real photograph of " + topic + " architecture and detailed structure" },
          { scene: 3, title: topic + " — परिवेश", prompt: "Real photograph of " + topic + " gardens and surrounding landscape" }
        ];
        const fallbackImages = [];
        const failedScenes = [];
        for (const scene of fallbackScenes) {
          const found = await findCommonsSceneImage(scene);
          if (found) fallbackImages.push({ ...found, scene: scene.scene, title: scene.title });
          else failedScenes.push({ scene: scene.scene, title: scene.title, error: "Wikimedia Commons पर उपयुक्त वास्तविक तस्वीर नहीं मिली।" });
        }
        if (fallbackImages.length) {
          return res.json({ success: true, images: fallbackImages, failedScenes, model: "Wikimedia Commons fallback", warning: "Gemini scene planning quota सीमित है; वास्तविक, attribution सहित Commons तस्वीरें दिखाई जा रही हैं।" });
        }
        return res.status(429).json({ success: false, error: quotaMessage("script", scriptModel, planningError) + " Wikimedia Commons से भी कोई वास्तविक तस्वीर उपलब्ध नहीं हुई।", images: [], failedScenes, model: scriptModel });
      }
      let planText = planResponse.text || "";
      planText = planText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      let plan;
      try { plan = JSON.parse(planText); }
      catch (_) { return res.status(502).json({ error: "AI से दृश्य योजना सही JSON में नहीं मिली। दोबारा प्रयास करें।" }); }
      scenes = (Array.isArray(plan.scenes) ? plan.scenes.slice(0, 3) : []).map((scene, index) => ({
        ...scene, originalScene: index + 1
      }));
      if (!scenes.length) return res.status(502).json({ error: "स्क्रिप्ट से कोई दृश्य नहीं निकला।" });
    }

    const images = [];
    const failedScenes = [];
    quotaModel = imageModel;
    quotaOperation = "image generation";
    let imageQuota = null;
    let temporaryImageFailure = false;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (!scene || typeof scene.prompt !== "string" || !scene.prompt.trim()) continue;

      try {
        // A 429 is project/key quota exhaustion: never send more image requests to fallback models.
        // Only model-compatibility errors (400/404) may try one explicitly configured fallback.
        const imageModels = [...new Set([imageModel, "gemini-3.1-flash-image"])];
        let imageResponse = null;
        let lastImageError = null;
        for (let modelIndex = 0; modelIndex < imageModels.length; modelIndex++) {
          const candidateModel = imageModels[modelIndex];
          quotaModel = candidateModel;
          try {
            imageResponse = await withTemporaryRetries(() => ai.models.generateContent({
              model: candidateModel,
              contents: stylePrompt + scene.prompt + (visualStyle === "3d-cartoon" ? " Keep the same recurring Indian cartoon friends and their outfits consistent; portrait 9:16 composition." : ""),
              config: { responseModalities: ["TEXT", "IMAGE"] }
            }));
            break;
          } catch (candidateError) {
            lastImageError = candidateError;
            const status = getStatus(candidateError);
            // Never try a second image model after an explicit HTTP 429 or quota code.
            if (status === 429 || isQuotaError(candidateError) ||
                /RESOURCE_EXHAUSTED/i.test(String(candidateError?.code || ""))) {
              throw candidateError;
            }
            if (![400, 404].includes(status) || modelIndex === imageModels.length - 1) throw candidateError;
          }
        }
        if (!imageResponse) throw lastImageError || new Error("Image model ने response नहीं दिया।");
        const parts = imageResponse.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(part => part.inlineData?.data && (part.inlineData.mimeType || "").startsWith("image/"));
        if (!imagePart) throw new Error("Image payload missing");
        images.push({
          scene: scene.originalScene || i + 1,
          title: String(scene.title || `दृश्य ${scene.originalScene || i + 1}`).slice(0, 120),
          mimeType: imagePart.inlineData.mimeType || "image/png",
          imageBase64: imagePart.inlineData.data
        });
      } catch (sceneError) {
        safeLog("Gemini image scene failed", sceneError);
        const quotaHit = isQuotaError(sceneError);
        const temporaryHit = [500, 502, 503, 504].includes(getStatus(sceneError));
        if (temporaryHit) temporaryImageFailure = true;
        if (quotaHit) imageQuota = quotaInfo(sceneError, imageModel, "image generation");
        failedScenes.push({ scene: scene.originalScene || i + 1, title: String(scene.title || `दृश्य ${scene.originalScene || i + 1}`).slice(0, 120), prompt: scene.prompt,
          error: quotaHit
            ? "Gemini quota exhausted; आगे image requests रोक दी गईं।"
            : "इस दृश्य की तस्वीर नहीं बन सकी; अस्थायी Gemini त्रुटि पर सीमित retry के बाद रुक गए।" });
        if (quotaHit) {
          // Quota is normally project-wide. Mark the remaining scenes as deferred without making more API calls.
          for (let pending = i + 1; pending < scenes.length; pending++) {
            const next = scenes[pending];
            failedScenes.push({ scene: next.originalScene || pending + 1, title: String(next.title || ("दृश्य " + (next.originalScene || pending + 1))).slice(0, 120), prompt: next.prompt, error: "Quota limit के कारण request नहीं भेजी गई; quota reset के बाद ही retry करें।" });
          }
          break;
        }
      }
    }

    // When Gemini returns 429, do not retry another paid model. Try free, real, license-attributed Wikimedia Commons photos instead.
    if (imageQuota && failedScenes.length && visualStyle !== "3d-cartoon") {
      const remainingFailures = [];
      for (const failed of failedScenes) {
        try {
          const fallback = await findCommonsSceneImage(failed);
          if (fallback) {
            images.push({
              scene: failed.scene,
              title: failed.title,
              mimeType: fallback.mimeType,
              imageBase64: fallback.imageBase64,
              source: fallback.source,
              sourceUrl: fallback.sourceUrl,
              sourceTitle: fallback.title,
              license: fallback.license,
              credit: fallback.credit,
              attribution: fallback.attribution
            });
          } else {
            remainingFailures.push({ ...failed, error: "Gemini quota खत्म है और इस दृश्य के लिए Wikimedia Commons पर उपयुक्त तस्वीर नहीं मिली।" });
          }
        } catch (_) {
          remainingFailures.push({ ...failed, error: "Gemini quota खत्म है; मुफ्त Wikimedia फोटो सेवा अभी उपलब्ध नहीं हुई।" });
        }
      }
      failedScenes.splice(0, failedScenes.length, ...remainingFailures);
    }

    if (!images.length) {
      const quotaHit = failedScenes.some(item => /quota/.test(item.error));
      return res.status(quotaHit ? 429 : (temporaryImageFailure ? 503 : 502)).json({
        success: false,
        error: quotaHit ? imageQuota?.message :
          (temporaryImageFailure
            ? "Gemini image service अभी अस्थायी रूप से अनुपलब्ध है। सीमित retry किए गए; कुछ देर बाद फिर कोशिश करें।"
            : "कोई तस्वीर सफलतापूर्वक जनरेट नहीं हुई।"),
        images: [],
        failedScenes,
        model: imageModel,
        quotaInfo: imageQuota
      });
    }
    return res.json({ success: true, images, failedScenes, model: imageModel, quotaInfo: imageQuota });
  } catch (error) {
    safeLog("Gemini scene image plan failed", error);
    if (error.code === "NO_API_KEY") {
      return res.status(500).json({ error: "सर्वर पर Gemini API key configure नहीं है।" });
    }
    if (isQuotaError(error)) {
      const failedModel = quotaModel || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
      const info = quotaInfo(error, failedModel, quotaOperation);
      return res.status(429).json({ error: info.message, model: info.model, quotaInfo: info, images: [], failedScenes: [] });
    }
    if ([500, 502, 503, 504].includes(getStatus(error))) {
      return res.status(503).json({ error: "Gemini अभी व्यस्त/अस्थायी रूप से अनुपलब्ध है। थोड़ी देर बाद पुनः प्रयास करें।" });
    }
    return res.status(502).json({ error: "Image generation request विफल हुई। बाद में पुनः प्रयास करें।" });
  }
});


/* ---- Real YouTube OAuth + resumable upload (single-user browser session) ---- */
function youtubeConfigReady() {
  return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET &&
    process.env.YOUTUBE_REDIRECT_URI && process.env.APP_SESSION_SECRET &&
    process.env.APP_SESSION_SECRET.length >= 32);
}
function cookieOptions() {
  return "Path=/; HttpOnly; SameSite=Lax; Max-Age=86400" +
    (process.env.NODE_ENV === "production" ? "; Secure" : "");
}
function encryptSession(payload) {
  const key = crypto.createHash("sha256").update(process.env.APP_SESSION_SECRET || "").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
function decryptSession(req) {
  try {
    const cookie = (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith("baba_youtube_session="));
    if (!cookie || !process.env.APP_SESSION_SECRET) return {};
    const packed = Buffer.from(cookie.split("=").slice(1).join("="), "base64url");
    if (packed.length < 29) return {};
    const key = crypto.createHash("sha256").update(process.env.APP_SESSION_SECRET).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
  } catch (_) { return {}; }
}
function setYoutubeSession(res, payload) {
  res.setHeader("Set-Cookie", "baba_youtube_session=" + encryptSession(payload) + "; " + cookieOptions());
}
function clearYoutubeSession(res) {
  res.setHeader("Set-Cookie", "baba_youtube_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" +
    (process.env.NODE_ENV === "production" ? "; Secure" : ""));
}
function youtubeNotConfigured(res) {
  return res.status(503).json({ error: "YouTube OAuth configure नहीं है। Render Environment में YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI और कम-से-कम 32 अक्षरों का APP_SESSION_SECRET सेट करें।" });
}
async function getYoutubeAccessToken(req, res) {
  const session = decryptSession(req);
  if (!session.refresh_token && !session.access_token) {
    res.status(401).json({ error: "पहले YouTube चैनल Connect करें।" });
    return null;
  }
  if (session.access_token && session.expires_at && Date.now() < session.expires_at - 60000) return session.access_token;
  if (!session.refresh_token) {
    clearYoutubeSession(res);
    res.status(401).json({ error: "YouTube login expire हो गया। चैनल फिर Connect करें।" });
    return null;
  }
  const form = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: session.refresh_token,
    grant_type: "refresh_token"
  });
  const refreshed = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form
  });
  const tokenData = await refreshed.json().catch(() => ({}));
  if (!refreshed.ok || !tokenData.access_token) {
    clearYoutubeSession(res);
    res.status(401).json({ error: "Google token refresh विफल हुआ। YouTube चैनल फिर Connect करें।" });
    return null;
  }
  const next = { ...session, access_token: tokenData.access_token,
    expires_at: Date.now() + (Number(tokenData.expires_in) || 3600) * 1000 };
  setYoutubeSession(res, next);
  return next.access_token;
}
app.get("/api/youtube/status", async (req, res) => {
  if (!youtubeConfigReady()) return res.json({ configured: false, connected: false });
  const session = decryptSession(req);
  if (!session.access_token && !session.refresh_token) return res.json({ configured: true, connected: false });
  const token = await getYoutubeAccessToken(req, res);
  if (!token) return;
  const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return res.status(502).json({ configured: true, connected: false, error: "YouTube चैनल की जानकारी नहीं मिल सकी।" });
  const channel = data.items?.[0];
  return res.json({ configured: true, connected: Boolean(channel),
    channel: channel ? { title: channel.snippet?.title, id: channel.id } : null });
});
app.get("/api/youtube/connect", (req, res) => {
  if (!youtubeConfigReady()) return youtubeNotConfigured(res);
  const state = crypto.randomBytes(24).toString("hex");
  setYoutubeSession(res, { oauth_state: state });
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    access_type: "offline",
    prompt: "consent",
    state
  });
  return res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
});
app.get("/api/youtube/callback", async (req, res) => {
  if (!youtubeConfigReady()) return youtubeNotConfigured(res);
  const oldSession = decryptSession(req);
  if (!req.query.code || !req.query.state || req.query.state !== oldSession.oauth_state) {
    clearYoutubeSession(res);
    return res.status(400).send("OAuth state mismatch. Please start YouTube Connect again.");
  }
  try {
    const form = new URLSearchParams({
      code: String(req.query.code),
      client_id: process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
      grant_type: "authorization_code"
    });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.access_token) {
      safeLog("YouTube OAuth token exchange failed", { status: tokenResponse.status });
      return res.status(502).send("Google OAuth token exchange failed. Check OAuth setup and redirect URI.");
    }
    // Verify the real authenticated YouTube channel before marking OAuth as connected.
    const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: "Bearer " + tokens.access_token }
    });
    const channelData = await channelResponse.json().catch(() => ({}));
    const channel = channelData.items?.[0];
    if (!channelResponse.ok || !channel?.id) {
      safeLog("YouTube channel verification failed", { status: channelResponse.status });
      clearYoutubeSession(res);
      return res.status(502).send("Google login सफल हुआ, लेकिन YouTube चैनल सत्यापित नहीं हो सका। YouTube Data API v3 और खाते की अनुमति जाँचें, फिर Connect दोबारा करें।");
    }
    setYoutubeSession(res, { access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || oldSession.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      channel: { id: channel.id, title: channel.snippet?.title || "" } });
    return res.redirect("/?youtube=connected");
  } catch (error) {
    safeLog("YouTube OAuth callback failed", error);
    return res.status(502).send("YouTube OAuth callback failed.");
  }
});
app.post("/api/youtube/disconnect", (req, res) => {
  clearYoutubeSession(res);
  return res.json({ success: true });
});
app.post("/api/youtube/upload", express.raw({ type: "video/*", limit: "90mb" }), async (req, res) => {
  if (!youtubeConfigReady()) return youtubeNotConfigured(res);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "MP4 वीडियो फ़ाइल भेजें।" });
  if (req.body.length > 90 * 1024 * 1024) return res.status(413).json({ error: "इस hosted upload में 90 MB तक की फ़ाइल स्वीकार है।" });
  const title = String(req.headers["x-video-title"] || "").trim().slice(0, 100);
  const description = String(req.headers["x-video-description"] || "").slice(0, 5000);
  const privacy = String(req.headers["x-video-privacy"] || "private");
  const mime = String(req.headers["content-type"] || "video/mp4").split(";")[0];
  if (!title) return res.status(400).json({ error: "YouTube वीडियो का title भरें।" });
  if (!["private", "unlisted", "public"].includes(privacy)) return res.status(400).json({ error: "Privacy private/unlisted/public में से चुनें।" });
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(mime)) return res.status(415).json({ error: "समर्थित फ़ाइल: MP4, MOV या WebM।" });
  try {
    const token = await getYoutubeAccessToken(req, res);
    if (!token) return;
    const initUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
    const init = await fetch(initUrl, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(req.body.length) },
      body: JSON.stringify({ snippet: { title, description }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } })
    });
    if (!init.ok) {
      const details = await init.json().catch(() => ({}));
      safeLog("YouTube upload session creation failed", { status: init.status });
      return res.status(init.status === 401 ? 401 : 502).json({ error: details.error?.message || "YouTube upload session नहीं बन सका। Google API quota/permissions जाँचें।" });
    }
    const uploadUrl = init.headers.get("location");
    if (!uploadUrl) return res.status(502).json({ error: "Google ने resumable upload URL नहीं दिया।" });
    const uploaded = await fetch(uploadUrl, {
      method: "PUT", headers: { "Content-Type": mime, "Content-Length": String(req.body.length),
        "Content-Range": "bytes 0-" + (req.body.length - 1) + "/" + req.body.length },
      body: req.body
    });
    const result = await uploaded.json().catch(() => ({}));
    if (!uploaded.ok || !result.id) {
      safeLog("YouTube video transfer failed", { status: uploaded.status });
      return res.status(502).json({ error: result.error?.message || "YouTube वीडियो upload पूरा नहीं हुआ।" });
    }
    return res.json({ success: true, videoId: result.id, url: "https://youtu.be/" + result.id, privacy });
  } catch (error) {
    safeLog("YouTube upload failed", error);
    return res.status(502).json({ error: "YouTube upload विफल हुआ। Render logs में सुरक्षित status जाँचें।" });
  }
});


/* ---- Render a narrated slideshow MP4 from generated scene images + Gemini TTS ---- */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
function getPcmDurationSeconds(audioBase64, sampleRate = 24000, channels = 1, bytesPerSample = 2) {
  if (typeof audioBase64 !== "string" || !audioBase64) return 0;
  const bytes = Buffer.from(audioBase64, "base64").length;
  const bytesPerSecond = Number(sampleRate) * Number(channels) * Number(bytesPerSample);
  return Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? bytes / bytesPerSecond : 0;
}

function validBase64(value) {
  return typeof value === "string" && value.length > 0 && value.length < 18 * 1024 * 1024 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
function validateRenderPayload(body) {
  const scenes = body?.scenes;
  const audioBase64 = body?.audioBase64;
  if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 3 ||
      scenes.some(s => !validBase64(s?.imageBase64) || !/^image[\\/](png|jpeg|webp)$/.test(String(s?.mimeType || ""))) ||
      !validBase64(audioBase64)) {
    return { status: 400, error: "1–3 generated scene images और valid TTS audio चाहिए। पहले Images और Voice बनाएँ।" };
  }
  const imageBytes = scenes.reduce((sum, s) => sum + Math.floor(s.imageBase64.length * 0.75), 0);
  const audioBytes = Math.floor(audioBase64.length * 0.75);
  if (imageBytes > 12 * 1024 * 1024 || audioBytes > 8 * 1024 * 1024) {
    return { status: 413, error: "Generated assets बहुत बड़े हैं। छोटा script/voice या कम images चुनें।" };
  }
  return null;
}
const renderJobs = new Map();
const MAX_RENDER_JOBS = 3;
const MAX_RETAINED_RENDER_JOBS = 30;

async function renderToFile(body) {
  const scenes = body.scenes;
  const audioBase64 = body.audioBase64;
  const audioMime = String(body.audioMime || "audio/L16").toLowerCase();
  let tempDir;
  try {
    // Keep filesystem failures inside this route's JSON error boundary.
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "baba-render-"));
    const ffmpegPath = require("ffmpeg-static");
    if (!ffmpegPath) throw Object.assign(new Error("FFmpeg binary उपलब्ध नहीं।"), { statusCode: 503 });
    const imagePaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const ext = scenes[i].mimeType === "image/jpeg" ? "jpg" : scenes[i].mimeType === "image/webp" ? "webp" : "png";
      const p = path.join(tempDir, "scene-" + i + "." + ext);
      await fs.promises.writeFile(p, Buffer.from(scenes[i].imageBase64, "base64"));
      imagePaths.push(p);
    }
    const isPcm = audioMime.includes("l16") || audioMime.includes("pcm");
    const audioPath = path.join(tempDir, isPcm ? "narration.pcm" : "narration.audio");
    await fs.promises.writeFile(audioPath, Buffer.from(audioBase64, "base64"));
    // Gemini's raw L16 response is 24 kHz mono, 16-bit PCM. Derive duration without ffprobe.
    const audioBuffer = Buffer.from(audioBase64, "base64");
    let duration = isPcm ? getPcmDurationSeconds(audioBase64) : 0;
    if (!isPcm) {
      const probe = await execFileAsync(ffmpegPath, ["-i", audioPath, "-f", "null", "-"], { timeout: 30000 }).catch(e => e);
      const textOut = String(probe.stderr || probe.message || "");
      const m = textOut.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 180) {
      throw Object.assign(new Error("Voice duration 0.5–180 seconds के बीच होनी चाहिए। छोटे narration से retry करें।"), { statusCode: 422 });
    }
    const clipDuration = duration / scenes.length;
    // Render within Render's 512 MiB memory limit: SD 480p, 15 fps, single encoder thread.
    // High-resolution zoompan at 720p/25fps can OOM-kill the whole service and cause HTTP 502.
    const renderWidth = 854, renderHeight = 480, renderFps = 15;
    const args = ["-hide_banner", "-loglevel", "error", "-threads", "1"];
    for (const p of imagePaths) args.push("-loop", "1", "-framerate", String(renderFps), "-t", String(clipDuration), "-i", p);
    if (isPcm) args.push("-f", "s16le", "-ar", "24000", "-ac", "1", "-i", audioPath);
    else args.push("-i", audioPath);
    const filters = imagePaths.map((_, i) =>
      "[" + i + ":v]scale=" + renderWidth + ":" + renderHeight + ":force_original_aspect_ratio=increase,crop=" + renderWidth + ":" + renderHeight +
      ",fps=" + renderFps + ",setsar=1,format=yuv420p[v" + i + "]"
    );
    filters.push(imagePaths.map((_, i) => "[v" + i + "]").join("") +
      "concat=n=" + imagePaths.length + ":v=1:a=0[outv]");
    const outputPath = path.join(tempDir, "baba-video.mp4");
    args.push("-filter_complex", filters.join(";"), "-map", "[outv]", "-map", imagePaths.length + ":a:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-crf", "28", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-max_muxing_queue_size", "512", "-shortest", "-movflags", "+faststart", outputPath);
    await execFileAsync(ffmpegPath, args, { timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
    const stat = await fs.promises.stat(outputPath);
    if (!stat.size || stat.size > 90 * 1024 * 1024) throw Object.assign(new Error("Rendered video 90 MB से बड़ा है। छोटा/कम resolution वाला project बनाएँ।"), { statusCode: 413 });
    return { tempDir, outputPath, size: stat.size };
  } catch (error) {
    safeLog("FFmpeg video render failed", error);
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (error.statusCode) throw error;
    throw Object.assign(new Error("वीडियो render नहीं हो सका। FFmpeg/Render resources जाँचें और छोटे script से retry करें।"), { statusCode: 503 });
  }
}

app.post("/api/render", async (req, res) => {
  const invalid = validateRenderPayload(req.body);
  if (invalid) return res.status(invalid.status).json({ error: invalid.error });
  const activeJobs = Array.from(renderJobs.values()).filter(j => j.status === "queued" || j.status === "processing").length;
  if (activeJobs >= MAX_RENDER_JOBS) return res.status(429).json({ error: "अभी दूसरे वीडियो render हो रहे हैं। थोड़ी देर बाद retry करें।" });
  if (renderJobs.size >= MAX_RETAINED_RENDER_JOBS) {
    for (const [id, oldJob] of renderJobs) {
      if (oldJob.status === "completed" || oldJob.status === "failed") {
        if (oldJob.tempDir) fs.promises.rm(oldJob.tempDir, { recursive: true, force: true }).catch(() => {});
        renderJobs.delete(id);
        if (renderJobs.size < MAX_RETAINED_RENDER_JOBS) break;
      }
    }
  }
  const jobId = require("crypto").randomUUID();
  const job = { id: jobId, status: "queued", createdAt: Date.now(), updatedAt: Date.now(), error: null, tempDir: null, outputPath: null, size: null };
  renderJobs.set(jobId, job);
  res.status(202).json({ jobId, status: job.status, statusUrl: "/api/render/status/" + jobId });
  setImmediate(async () => {
    job.status = "processing"; job.updatedAt = Date.now();
    try {
      const result = await renderToFile(req.body);
      job.tempDir = result.tempDir; job.outputPath = result.outputPath; job.size = result.size;
      job.status = "completed"; job.updatedAt = Date.now();
    } catch (error) {
      safeLog("Background render job failed", error);
      job.status = "failed"; job.error = error.statusCode ? error.message : "वीडियो render नहीं हो सका। FFmpeg/Render resources जाँचें और retry करें।";
      job.updatedAt = Date.now();
    }
  });
});

app.get("/api/render/status/:jobId", (req, res) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Render job नहीं मिला या server restart के बाद हट गया।" });
  return res.json({ jobId: job.id, status: job.status, error: job.error, size: job.size,
    downloadUrl: job.status === "completed" ? "/api/render/download/" + job.id : null,
    updatedAt: new Date(job.updatedAt).toISOString() });
});

app.get("/api/render/download/:jobId", (req, res) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Render job नहीं मिला या server restart के बाद हट गया।" });
  if (job.status !== "completed" || !job.outputPath) return res.status(409).json({ error: "वीडियो अभी डाउनलोड के लिए तैयार नहीं है।" });
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", 'attachment; filename="BABA-AI-video.mp4"');
  res.setHeader("Content-Length", String(job.size));
  return res.sendFile(job.outputPath, err => {
    if (err) safeLog("MP4 download failed", err);
    if (job.tempDir) fs.promises.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
    renderJobs.delete(job.id);
  });
});


// Unknown API routes must return JSON, not Express's default HTML 404 page.
app.use("/api", (req, res) => {
  return res.status(404).json({
    error: "API endpoint नहीं मिला: " + req.method + " " + req.originalUrl +
      "। Render पर सही/latest deployment और frontend version जाँचें।"
  });
});

// Convert parser and unexpected API middleware failures to safe JSON responses.
app.use((error, req, res, next) => {
  if (!req.path.startsWith("/api")) return next(error);
  if (res.headersSent) return next(error);
  const status = Number(error?.status || error?.statusCode);
  if (status === 413) return res.status(413).json({ error: "Request बहुत बड़ा है। छोटा input या कम assets चुनें।" });
  if (status === 400) return res.status(400).json({ error: "Request JSON सही नहीं है। डेटा जाँचकर दोबारा प्रयास करें।" });
  safeLog("Unhandled API middleware error", error);
  return res.status(500).json({ error: "सर्वर अनुरोध पूरा नहीं कर सका। कृपया थोड़ी देर बाद पुनः प्रयास करें।" });
});

// 6. सर्वर शुरू करना

const PORT = process.env.PORT || 3000;

// Allow node:test to import retry/quota helpers without binding a server port.
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("BABA AI Server running on port " + PORT);
  });
}

module.exports = { app, getStatus, isQuotaError, extractRetryHint, quotaInfo, withTemporaryRetries, generateTextWithQuotaFallback, getPcmDurationSeconds, setAIClientFactoryForTests, resetAIClientFactory };
