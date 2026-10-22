
require("dotenv").config();

const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({ limit: "20mb" }));
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
  if (kind === "voice") {
    const hint = extractRetryHint(error);
    return "Gemini TTS quota खत्म हो गई है (429)।" + (model ? " मॉडल: " + model + "." : "") +
      (hint ? " Google का retry/reset संकेत: " + hint + "." : "") +
      " Google AI Studio में usage, quota और billing जाँचें।";
  }
  return quotaInfo(error, model || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image").message;
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
    return res.status(429).json({ error: quotaMessage(kind, process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts", error) });
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

    const response = await withTemporaryRetries(() => ai.models.generateContent({
      model: process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash",
      contents: prompt,
    }));

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
    const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
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
    quotaOperation = "image generation";
    let imageQuota = null;
    let temporaryImageFailure = false;
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
        const temporaryHit = [500, 502, 503, 504].includes(getStatus(sceneError));
        if (temporaryHit) temporaryImageFailure = true;
        if (quotaHit) imageQuota = quotaInfo(sceneError, imageModel, "image generation");
        failedScenes.push({ scene: i + 1, title: String(scene.title || `दृश्य ${i + 1}`).slice(0, 120),
          error: quotaHit
            ? "Gemini quota exhausted; आगे image requests रोक दी गईं।"
            : "इस दृश्य की तस्वीर नहीं बन सकी; अस्थायी Gemini त्रुटि पर सीमित retry के बाद रुक गए।" });
        if (quotaHit) break;
      }
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
    setYoutubeSession(res, { access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || oldSession.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 });
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
function validBase64(value) {
  return typeof value === "string" && value.length > 0 && value.length < 18 * 1024 * 1024 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
app.post("/api/render", async (req, res) => {
  const scenes = req.body?.scenes;
  const audioBase64 = req.body?.audioBase64;
  const audioMime = String(req.body?.audioMime || "audio/L16").toLowerCase();
  if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 3 ||
      scenes.some(s => !validBase64(s?.imageBase64) || !/^image\/(png|jpeg|webp)$/.test(String(s?.mimeType || ""))) ||
      !validBase64(audioBase64)) {
    return res.status(400).json({ error: "1–3 generated scene images और valid TTS audio चाहिए। पहले Images और Voice बनाएँ।" });
  }
  const imageBytes = scenes.reduce((sum, s) => sum + Math.floor(s.imageBase64.length * 0.75), 0);
  const audioBytes = Math.floor(audioBase64.length * 0.75);
  if (imageBytes > 12 * 1024 * 1024 || audioBytes > 8 * 1024 * 1024) {
    return res.status(413).json({ error: "Generated assets बहुत बड़े हैं। छोटा script/voice या कम images चुनें।" });
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "baba-render-"));
  try {
    const ffmpegPath = require("ffmpeg-static");
    if (!ffmpegPath) return res.status(503).json({ error: "FFmpeg binary उपलब्ध नहीं।" });
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
    let duration = isPcm ? audioBytes / (24000 * 2) : 0;
    if (!isPcm) {
      const probe = await execFileAsync(ffmpegPath, ["-i", audioPath, "-f", "null", "-"], { timeout: 30000 }).catch(e => e);
      const textOut = String(probe.stderr || probe.message || "");
      const m = textOut.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 180) {
      return res.status(422).json({ error: "Voice duration 0.5–180 seconds के बीच होनी चाहिए। छोटे narration से retry करें।" });
    }
    const clipDuration = duration / scenes.length;
    const args = [];
    for (const p of imagePaths) args.push("-loop", "1", "-framerate", "1", "-t", "1", "-i", p);
    if (isPcm) args.push("-f", "s16le", "-ar", "24000", "-ac", "1", "-i", audioPath);
    else args.push("-i", audioPath);
    const filters = imagePaths.map((_, i) =>
      "[" + i + ":v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='min(zoom+0.0004,1.06)':d=" +
      Math.max(1, Math.round(clipDuration * 25)) + ":s=1280x720:fps=25,setsar=1,format=yuv420p[v" + i + "]"
    );
    filters.push(imagePaths.map((_, i) => "[v" + i + "]").join("") +
      "concat=n=" + imagePaths.length + ":v=1:a=0[outv]");
    const outputPath = path.join(tempDir, "baba-video.mp4");
    args.push("-filter_complex", filters.join(";"), "-map", "[outv]", "-map", imagePaths.length + ":a:0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", outputPath);
    await execFileAsync(ffmpegPath, args, { timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
    const stat = await fs.promises.stat(outputPath);
    if (!stat.size || stat.size > 90 * 1024 * 1024) return res.status(413).json({ error: "Rendered video 90 MB से बड़ा है। छोटा/कम resolution वाला project बनाएँ।" });
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="BABA-AI-video.mp4"');
    res.setHeader("Content-Length", String(stat.size));
    return res.sendFile(outputPath, err => { if (err) safeLog("MP4 response failed", err); fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {}); });
  } catch (error) {
    safeLog("FFmpeg video render failed", error);
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return res.status(503).json({ error: "वीडियो render नहीं हो सका। FFmpeg/Render resources जाँचें और छोटे script से retry करें।" });
  }
});

// 6. सर्वर शुरू करना

const PORT = process.env.PORT || 3000;

// Allow node:test to import retry/quota helpers without binding a server port.
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("BABA AI Server running on port " + PORT);
  });
}

module.exports = { app, getStatus, isQuotaError, extractRetryHint, quotaInfo, withTemporaryRetries, setAIClientFactoryForTests, resetAIClientFactory };
