
require("dotenv").config();

const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({ limit: "2mb" }));
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
  return getStatus(error) === 429 ||
    /RESOURCE_EXHAUSTED|quota|rate.?limit|billing|payment/i.test(String(error?.message || ""));
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
  const retry = detailText.match(/(?:please\s+)?retry(?:\s+in)?\s*["']?\s*[:=]?\s*["']?([0-9]+(?:\\.[0-9]+)?\s*(?:ms|s|seconds?|m|minutes?|h|hours?)(?:\s*[0-9]+(?:\\.[0-9]+)?\s*(?:s|m|h))?)/i);
  if (retry) return retry[1].trim();
  const reset = detailText.match(/(?:reset(?:s|\s+at)?|retry\s+after)\s*[:=]?\s*["']?([^"'\n,;]{3,60})/i);
  return reset ? reset[1].trim() : null;
}

function quotaInfo(error, model) {
  const retryHint = extractRetryHint(error);
  const message = "Gemini image quota समाप्त/सीमित है (429 RESOURCE_EXHAUSTED)। आगे की image requests रोक दी गईं। मॉडल: " + model +
    (retryHint ? " Google का retry/reset संकेत: " + retryHint + "." : " Google ने इस error में retry/reset समय नहीं दिया।") +
    " Google AI Studio में इसी API key/project का usage, quota और billing देखें।";
  return { model, retryHint, message };
}

function quotaMessage(kind, model, error) {
  if (kind === "voice") {
    const hint = extractRetryHint(error);
    return "Gemini TTS quota खत्म हो गई है (429)।" + (model ? " मॉडल: " + model + "." : "") +
      (hint ? " Google का retry/reset संकेत: " + hint + "." : "") +
      " Google AI Studio में usage, quota और billing जाँचें।";
  }
  return quotaInfo(error, model || process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image").message;
}

function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY सेट नहीं है।");
    error.code = "NO_API_KEY";
    throw error;
  }

  return new GoogleGenAI({ apiKey });
}

function sendAPIError(res, error, fallbackMessage, kind) {
  safeLog(fallbackMessage, error);

  if (error.code === "NO_API_KEY") {
    return res.status(500).json({ error: "सर्वर पर Gemini API key configure नहीं है।" });
  }
  if (isQuotaError(error)) {
    return res.status(429).json({ error: quotaMessage(kind, process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts", error) });
  }
  const status = getStatus(error);
  if ([500, 502, 503, 504].includes(status)) {
    return res.status(503).json({ error: "Gemini सेवा अभी अस्थायी रूप से उपलब्ध नहीं है। कुछ देर बाद पुनः प्रयास करें।" });
  }
  return res.status(500).json({ error: fallbackMessage });
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

    const model = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
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
    const response = await withTemporaryRetries(() => ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: "नैचुरल और स्पष्ट हिंदी में यह टेक्स्ट बोलें: " + text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    }));

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
    const { topic, duration, language } = req.body || {};

    if (typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({
        error: "कृपया वीडियो का विषय लिखें।",
      });
    }

    const videoLanguage = language || "हिंदी";
    const videoDuration = Number(duration) || 30;

    const ai = getAIClient();

    const prompt = `आप एक अनुभवी YouTube स्क्रिप्ट लेखक हैं।

विषय: ${topic}
भाषा: ${videoLanguage}
वीडियो अवधि: ${videoDuration} मिनट

निर्देश:
1. पहले 30 सेकंड के लिए आकर्षक शुरुआत लिखें।
2. कम से कम 6 अध्याय बनाएँ।
3. हर अध्याय में शीर्षक, नैरेशन, दृश्य निर्देश और अगले दृश्य का ट्रांज़िशन दें।
4. प्राकृतिक बोलचाल की भाषा में पूरी स्क्रिप्ट लिखें।
5. तथ्य गढ़कर न लिखें; अनिश्चित दावों को स्पष्ट बताएँ।
6. अवधि के अनुरूप विस्तृत सामग्री दें।
7. अंत में निष्कर्ष और लाइक तथा सब्सक्राइब करने का अनुरोध दें।
8. आउटपुट ${videoLanguage} में दें।`;

    const response = await ai.models.generateContent({
      model:
        process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash",
      contents: prompt,
    });

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

    const videoLanguage = language || "हिंदी";
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

    const response = await ai.models.generateContent({
      model:
        process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash",
      contents: prompt,
    });

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

// 5. स्क्रिप्ट से अधिकतम 3 दृश्य-तस्वीरें बनाना (Gemini Image)
app.post("/api/images", async (req, res) => {
  let quotaModel = process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash";
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
    const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
    quotaModel = scriptModel;
    const planResponse = await withTemporaryRetries(() => ai.models.generateContent({
      model: scriptModel,
      contents: `इस वीडियो स्क्रिप्ट से 3 मुख्य दृश्य चुनें और हर दृश्य के लिए एक विस्तृत image prompt लिखें।
सभी दृश्य एक ही visual style में हों: cinematic, polished, YouTube-friendly, 16:9 landscape, कोई लिखावट/टेक्स्ट/वॉटरमार्क नहीं।
स्क्रिप्ट:
${script.slice(0, 18000)}

केवल वैध JSON लौटाएँ, इस schema में:
{"scenes":[{"title":"दृश्य का छोटा शीर्षक","prompt":"English image prompt"}]}
3 से अधिक दृश्य न दें।`,
      config: { responseMimeType: "application/json" }
    }));

    let planText = planResponse.text || "";
    planText = planText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let plan;
    try { plan = JSON.parse(planText); }
    catch (_) { return res.status(502).json({ error: "AI से दृश्य योजना सही JSON में नहीं मिली। दोबारा प्रयास करें।" }); }

    const scenes = Array.isArray(plan.scenes) ? plan.scenes.slice(0, 3) : [];
    if (!scenes.length) return res.status(502).json({ error: "स्क्रिप्ट से कोई दृश्य नहीं निकला।" });

    const images = [];
    const failedScenes = [];
    quotaModel = imageModel;
    let imageQuota = null;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (!scene || typeof scene.prompt !== "string" || !scene.prompt.trim()) continue;

      try {
        const imageResponse = await withTemporaryRetries(() => ai.models.generateContent({
          model: imageModel,
          contents: scene.prompt,
          config: { responseModalities: ["IMAGE"] }
        }));
        const parts = imageResponse.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(part => part.inlineData?.data && (part.inlineData.mimeType || "").startsWith("image/"));
        if (!imagePart) throw new Error("Image payload missing");
        images.push({
          scene: i + 1,
          title: String(scene.title || `दृश्य ${i + 1}`).slice(0, 120),
          mimeType: imagePart.inlineData.mimeType || "image/png",
          imageBase64: imagePart.inlineData.data
        });
      } catch (sceneError) {
        safeLog("Gemini image scene failed", sceneError);
        const quotaHit = isQuotaError(sceneError);
        if (quotaHit) imageQuota = quotaInfo(sceneError, imageModel);
        failedScenes.push({ scene: i + 1, title: String(scene.title || `दृश्य ${i + 1}`).slice(0, 120),
          error: quotaHit
            ? "Gemini quota exhausted; आगे image requests रोक दी गईं।"
            : "इस दृश्य की तस्वीर नहीं बन सकी; अस्थायी Gemini त्रुटि पर सीमित retry के बाद रुक गए।" });
        if (quotaHit) break;
      }
    }

    if (!images.length) {
      const quotaHit = failedScenes.some(item => /quota/.test(item.error));
      return res.status(quotaHit ? 429 : 502).json({
        success: false,
        error: quotaHit ? imageQuota?.message : "कोई तस्वीर सफलतापूर्वक जनरेट नहीं हुई।",
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
      const info = quotaInfo(error, quotaModel || process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image");
      return res.status(429).json({ error: info.message, model: info.model, quotaInfo: info, images: [], failedScenes: [] });
    }
    if ([500, 502, 503, 504].includes(getStatus(error))) {
      return res.status(503).json({ error: "Gemini अभी व्यस्त/अस्थायी रूप से अनुपलब्ध है। थोड़ी देर बाद पुनः प्रयास करें।" });
    }
    return res.status(502).json({ error: "Image generation request विफल हुई। बाद में पुनः प्रयास करें।" });
  }
});

// 6. सर्वर शुरू करना

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("BABA AI Server running on port " + PORT);
});
