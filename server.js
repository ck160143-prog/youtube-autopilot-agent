
require("dotenv").config();

const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const path = require("path");

const dataRoot = process.env.DATA_DIR || path.join(__dirname, "data");

const app = express();

// Render payloads contain base64-encoded scene images plus narration; allow the documented 12 MB image + 8 MB audio payload with base64 overhead.
app.use(express.json({ limit: "35mb" }));
// Serve the built dashboard. Paths are absolute so `npm start` works from any
// cwd, and a missing build falls back to the source page instead of a 404.
const distDir = path.join(__dirname, "dist");
app.use(express.static(distDir));
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
}

/* ---- Phase 3: sessions, CSRF, rate limiting ---- */
const {
  AuthStore, sessionMiddleware, requireAuth, csrfMiddleware,
  cookieHeader, clearCookieHeader, readCookie, SESSION_COOKIE,
} = require("./lib/auth");
const { createRateLimiter } = require("./lib/ratelimit");
const { redactSecrets, readSecret, keyShape } = require("./lib/setup");

app.set("trust proxy", 1);
const authStore = new AuthStore({ dir: dataRoot }).load();
const rateLimit = createRateLimiter({ multiplier: Number(process.env.API_RATE_LIMIT_MULTIPLIER) || 1 });

app.use("/api", sessionMiddleware(authStore));
// Rate limit before CSRF/auth so a flood is rejected cheaply, and the bucket
// can key on the resolved user.
app.use("/api", rateLimit);
app.use("/api", csrfMiddleware());

// Public endpoints: liveness, auth status, login/register and the OAuth
// redirect targets (which carry their own state validation).
const PUBLIC_API_PATHS = new Set([
  "/health", "/auth/status", "/auth/login", "/auth/register", "/youtube/callback",
]);
app.use("/api", (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (req.path === "/youtube/connect" && !req.user) {
    return res.redirect("/?login=1");
  }
  return requireAuth(req, res, next);
});

app.get("/api/auth/status", (req, res) => {
  return res.json({
    authenticated: Boolean(req.user),
    registrationOpen: authStore.userCount() === 0 || Boolean(process.env.APP_REGISTRATION_KEY),
    user: req.user || null,
  });
});

app.post("/api/auth/register", (req, res) => {
  try {
    const { username, password, registrationKey } = req.body || {};
    const user = authStore.register({ username, password, registrationKey });
    if (user.role === "owner") {
      // First account adopts everything created before authentication existed.
      projectStore.adoptOwner(user.id);
      characterLibrary.adoptOwner(user.id);
    }
    const session = authStore.createSession(user.id);
    res.setHeader("Set-Cookie", cookieHeader(session.id));
    return res.status(201).json({ user, csrfToken: session.csrfToken });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || "Account नहीं बना।" });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { username, password } = req.body || {};
    const session = authStore.login(username, password);
    res.setHeader("Set-Cookie", cookieHeader(session.id));
    const user = authStore.getUser(session.userId);
    return res.json({ user, csrfToken: session.csrfToken });
  } catch (error) {
    return res.status(error.statusCode || 401).json({ error: error.message || "Login विफल।" });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) authStore.destroySession(id);
  res.setHeader("Set-Cookie", clearCookieHeader());
  return res.json({ success: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  return res.json({ user: req.user, csrfToken: req.session ? req.session.csrfToken : null });
});

// Optional access gate for a personal deployment. Off unless APP_ACCESS_KEY is
// set, so local development is unchanged; when set, every /api request must
// present the key (header or cookie) except the health check and the OAuth
// redirect endpoints, which a browser reaches without custom headers.
const ACCESS_KEY = process.env.APP_ACCESS_KEY || "";
if (ACCESS_KEY) {
  app.use("/api", (req, res, next) => {
    const open = req.path === "/health" || req.path === "/youtube/callback" || req.path === "/youtube/connect";
    if (open) return next();
    const cookie = String(req.headers.cookie || "").split(";").map(v => v.trim())
      .find(v => v.startsWith("baba_access_key="));
    const supplied = req.get("x-access-key") || (cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : "");
    const expected = Buffer.from(ACCESS_KEY);
    const given = Buffer.from(String(supplied));
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    return res.status(401).json({ error: "Access key जरूरी है। Settings में APP_ACCESS_KEY भरें।" });
  });
}

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

// A hung provider call would otherwise block the single-job worker forever.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Gemini request समय पर जवाब नहीं दे रही (" + label + ")।");
      error.statusCode = 504;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function geminiTimeoutMs() {
  const raw = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.min(raw, 600000) : 90000;
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
  return quotaInfo(error, model || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image").message;
}

let aiClientFactory = () => new GoogleGenAI({ apiKey: readSecret("GEMINI_API_KEY") });

function setAIClientFactoryForTests(factory) {
  aiClientFactory = factory;
}

function resetAIClientFactory() {
  aiClientFactory = () => new GoogleGenAI({ apiKey: readSecret("GEMINI_API_KEY") });
}

function getAIClient() {
  const apiKey = readSecret("GEMINI_API_KEY");

  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY सेट नहीं है।");
    error.code = "NO_API_KEY";
    throw error;
  }
  // A pasted key with a newline or a space fails inside the SDK with a
  // confusing message; fail here with an actionable one instead.
  if (/\s/.test(apiKey)) {
    const error = new Error("GEMINI_API_KEY में whitespace/newline है। Key को फिर से साफ़ करके सेट करें।");
    error.code = "BAD_API_KEY";
    error.statusCode = 500;
    throw error;
  }

  return aiClientFactory();
}

// A missing key is a configuration state, never a server fault. Every Gemini
// route answers with the same shape: 503 + blocked:true + setup.steps.
const GEMINI_SETUP_STEPS = [
  "Google AI Studio (aistudio.google.com/app/apikey) पर key बनाएँ",
  "GEMINI_API_KEY को .env या hosting के environment में डालें",
  "सर्वर रीस्टार्ट करके 'Verify setup' दबाएँ",
];

function geminiKeyBlocked(featureLabel) {
  const label = featureLabel ? " " + featureLabel + " BLOCKED है।" : "";
  return {
    error: "GEMINI_API_KEY सेट नहीं है।" + label + " Dashboard का Setup panel खोलें या README देखें।",
    blocked: true,
    setup: { steps: GEMINI_SETUP_STEPS.slice() },
  };
}

// A DNS/TLS/socket failure says nothing about the key: reporting it as
// "key rejected" sends the user to rotate a perfectly good credential. The
// underlying cause string is kept because it is actionable (ENOTFOUND,
// certificate expired, proxy refused) and contains no secret.
function networkErrorDetail(error) {
  const cause = error && error.cause ? error.cause : null;
  const code = String((cause && cause.code) || error?.code || "").slice(0, 40);
  const text = String((cause && cause.message) || error?.message || "").slice(0, 120);
  return [code, text].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
}

function isNetworkError(error) {
  const status = getStatus(error);
  if (status >= 400) return false;
  const code = String((error && error.cause && error.cause.code) || error?.code || "");
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|CERT_|UNABLE_TO_)/i.test(code)) return true;
  return /fetch failed|network|getaddrinfo|socket hang up/i.test(String(error?.message || ""));
}

function sendAPIError(res, error, fallbackMessage, kind) {
  safeLog(fallbackMessage, error);

  if (isNetworkError(error)) {
    return res.status(503).json({
      error: "Gemini सर्वर तक पहुँच नहीं बनी (network/DNS/TLS)। यह API key की गलती नहीं है — key बदलने की ज़रूरत नहीं। होस्टिंग का outbound network, proxy या firewall जाँचें, फिर दोबारा कोशिश करें।",
      code: "NETWORK_UNREACHABLE",
      reason: networkErrorDetail(error),
    });
  }
  if (error.code === "NO_API_KEY") {
    return res.status(503).json(geminiKeyBlocked());
  }
  if (error.code === "BAD_API_KEY") {
    return res.status(500).json({ error: redactSecrets(error.message) });
  }
  if (isQuotaError(error)) {
    const operationKind = kind || "script";
    const model = operationKind === "voice"
      ? (process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts")
      : operationKind === "images"
        ? (process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image")
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
  // Never echo the provider's raw message to the client: it can carry request
  // fragments. The status code is enough to act on; details stay in safeLog.
  return res.status(500).json({ error: redactSecrets(fallbackMessage) + " (server status " + (status || "unknown") + ") Render Logs जाँचें।" });
}

// 1. सर्वर की स्थिति
app.get("/api/health", (req, res) => {
  // Liveness only: this stays 200 so the platform health check never fails a
  // deploy. Readiness is reported separately, because "process is serving" and
  // "the pipeline can run" are different claims.
  const blocked = [];
  if (!readSecret("GEMINI_API_KEY")) blocked.push("GEMINI_API_KEY");
  if (!ffmpegTools.ffmpegVersionSync()) blocked.push("FFMPEG");
  res.json({
    status: "ok",
    ready: blocked.length === 0,
    blocked,
    geminiKeyConfigured: Boolean(readSecret("GEMINI_API_KEY")),
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
    const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
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
        // Declared default first; the previously declared model stays as the only
        // model-compatibility fallback, so the candidate set is unchanged.
        const imageModels = [...new Set([imageModel, "gemini-nano-banana-2.1"])];
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
      // Configuration state, not a server fault: same blocked shape as /api/voice.
      return res.status(503).json(geminiKeyBlocked("Image generation"));
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
    scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly " + ANALYTICS_SCOPE,
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
    setYoutubeSession(res, { scope: String(tokens.scope || ""), access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || oldSession.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      channel: { id: channel.id, title: channel.snippet?.title || "" } });
    return res.redirect("/?youtube=connected");
  } catch (error) {
    safeLog("YouTube OAuth callback failed", error);
    return res.status(502).send("YouTube OAuth callback failed.");
  }
});
// Read-only channel analytics. Never writes anything to YouTube and never
// stores the report; the numbers are returned to the owner's browser only.
app.get("/api/youtube/analytics", async (req, res) => {
  const linked = decryptSession(req);
  if (!linked || !linked.access_token) {
    return res.status(409).json({
      error: "पहले YouTube चैनल Connect करें।",
      code: "CHANNEL_NOT_CONNECTED",
    });
  }
  // A connection made before the analytics scope existed has no consent for it.
  // Google answers 403; say that plainly rather than blaming the server.
  const scopeText = String(linked.scope || "");
  if (scopeText && !scopeText.includes("yt-analytics.readonly")) {
    return res.status(409).json({
      error: "इस connection में Analytics की अनुमति नहीं है। 'Chैनल फिर Connect करें' दबाएँ (नई अनुमति माँगी जाएगी)। Upload पहले की तरह काम करता रहेगा।",
      code: "ANALYTICS_SCOPE_MISSING",
    });
  }
  const range = validateAnalyticsRange(req.query.startDate, req.query.endDate);
  if (!range.ok) {
    return res.status(400).json({ error: range.message, code: "INVALID_RANGE", reason: range.reason });
  }
  try {
    const token = await getYoutubeAccessToken(req, res);
    if (!token) return;
    const url = "https://youtubeanalytics.googleapis.com/v2/reports?" + new URLSearchParams({
      ids: "channel==MINE",
      startDate: range.startDate,
      endDate: range.endDate,
      metrics: ANALYTICS_METRICS.join(","),
      dimensions: "day",
      sort: "day",
    }).toString();
    const response = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      safeLog("YouTube analytics query failed", { status: response.status });
      const detail = payload && payload.error && payload.error.message ? String(payload.error.message).slice(0, 160) : "";
      if (response.status === 403) {
        return res.status(409).json({
          error: "Analytics की अनुमति नहीं मिली। चैनल फिर Connect करें।",
          code: "ANALYTICS_SCOPE_MISSING",
        });
      }
      return res.status(502).json({ error: redactSecrets("Analytics query विफल (HTTP " + response.status + ")। " + detail).trim() });
    }
    const shaped = shapeAnalyticsReport(payload);
    return res.json({
      channel: linked.channel || null,
      startDate: range.startDate,
      endDate: range.endDate,
      days: range.days,
      ...shaped,
      // Honest labelling: YouTube's analytics data lags 24-72 hours.
      note: "YouTube Analytics में 24–72 घंटे की देरी होती है; हाल के दिन अधूरे हो सकते हैं।",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (isNetworkError(error)) {
      return res.status(503).json({
        error: "YouTube Analytics तक पहुँच नहीं बनी (network/DNS/TLS)।",
        code: "NETWORK_UNREACHABLE",
        reason: networkErrorDetail(error),
      });
    }
    safeLog("YouTube analytics failed", error);
    return res.status(502).json({ error: "Analytics नहीं पढ़ा जा सका।" });
  }
});

app.post("/api/youtube/disconnect", (req, res) => {
  clearYoutubeSession(res);
  return res.json({ success: true });
});
// YouTube counts tags as one comma-separated string capped at 500 characters,
// and a tag longer than 60 characters is rejected outright. Normalising here
// keeps the preflight honest: it checks the same rules the insert will enforce.
function normalizeYoutubeTags(tags) {
  const cleaned = (tags || [])
    .map(tag => String(tag == null ? "" : tag).replace(/[<>]/g, "").trim())
    .filter(Boolean)
    .filter(tag => tag.length <= 60)
    .slice(0, 30);
  const length = cleaned.join(",").length;
  return { tags: cleaned, length, ok: length <= 500 };
}

// Scheduling: YouTube has no scheduler endpoint. `status.publishAt` (RFC 3339,
// UTC) is the only mechanism, and Google accepts it ONLY while
// status.privacyStatus is "private" — public/unlisted + publishAt returns
// invalidPublishAt (400), and a video that has been public once can never be
// scheduled again. A past timestamp publishes immediately instead of erroring,
// so it is rejected here rather than silently going live.
const SCHEDULE_MIN_LEAD_MS = 5 * 60 * 1000;

function validateScheduleAt(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, publishAt: null, reason: null };
  }
  const text = String(value).trim();
  const parsed = new Date(text);
  if (!text || Number.isNaN(parsed.getTime())) {
    return { ok: false, publishAt: null, reason: "invalid",
      message: "publishAt की तारीख़ समझ नहीं आई। ISO 8601 (जैसे 2026-12-01T09:00:00Z) भेजें।" };
  }
  // 5 minutes of slack: a schedule a few seconds out would publish immediately.
  if (parsed.getTime() < now + SCHEDULE_MIN_LEAD_MS) {
    return { ok: false, publishAt: null, reason: "past",
      message: "publishAt आज से कम से कम " + (SCHEDULE_MIN_LEAD_MS / 60000) + " मिनट आगे होना चाहिए। बीता समय YouTube तुरंत publish कर देता है।" };
  }
  return { ok: true, publishAt: parsed.toISOString(), reason: null };
}

// Builds the `status` block for videos.insert. Scheduling forces private until
// the scheduled moment, which is exactly what Google requires; the caller never
// gets to send public + publishAt.
function buildVideoStatus({ privacy, publishAt }) {
  const base = { selfDeclaredMadeForKids: false };
  if (!publishAt) return { ...base, privacyStatus: privacy };
  return { ...base, privacyStatus: "private", publishAt };
}

// ---- YouTube Analytics (read-only) --------------------------------------
// reports.query needs BOTH scopes: youtube.readonly (already requested for the
// channel check) and yt-analytics.readonly. A connection made before this scope
// existed keeps working for uploads; analytics simply reports that it needs a
// fresh consent, instead of looking like a server fault.

const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
const ANALYTICS_METRICS = ["views", "estimatedMinutesWatched", "averageViewDuration", "subscribersGained", "likes"];

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// startDate/endDate are inclusive; YouTube refuses a range that starts today
// because the current day is still being processed (data lags 24-72 hours).
function validateAnalyticsRange(startDate, endDate, now = Date.now()) {
  const fallbackEnd = isoDay(now - 24 * 3600 * 1000);
  const fallbackStart = isoDay(now - 29 * 24 * 3600 * 1000);
  const start = startDate ? String(startDate).trim() : fallbackStart;
  const end = endDate ? String(endDate).trim() : fallbackEnd;
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(start) || !pattern.test(end)) {
    return { ok: false, reason: "format", message: "तारीख़ YYYY-MM-DD रूप में भेजें।" };
  }
  const startMs = Date.parse(start + "T00:00:00Z");
  const endMs = Date.parse(end + "T00:00:00Z");
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { ok: false, reason: "format", message: "तारीख़ मान्य नहीं है।" };
  }
  if (endMs < startMs) {
    return { ok: false, reason: "order", message: "endDate, startDate से पहले नहीं हो सकती।" };
  }
  if (endMs > now - 24 * 3600 * 1000) {
    return { ok: false, reason: "future", message: "Analytics में 24–72 घंटे की देरी होती है; endDate कल या उससे पहले रखें।" };
  }
  const days = Math.round((endMs - startMs) / (24 * 3600 * 1000)) + 1;
  if (days > 366) {
    return { ok: false, reason: "range", message: "एक बार में अधिकतम 366 दिन।" };
  }
  return { ok: true, startDate: start, endDate: end, days };
}

// Turns reports.query's column/row shape into named rows. Returns [] for a
// channel with no views in range, which is a valid answer, not an error.
function shapeAnalyticsReport(report) {
  const headers = (report && report.columnHeaders) || [];
  const rows = (report && report.rows) || [];
  const columns = headers.map(h => h && h.name);
  const entries = rows.map(row => {
    const entry = {};
    columns.forEach((name, index) => { entry[name] = row[index]; });
    return entry;
  });
  const totals = {};
  for (const metric of ANALYTICS_METRICS) {
    const at = columns.indexOf(metric);
    if (at === -1) continue;
    // Average metrics must not be summed across days.
    if (metric === "averageViewDuration") {
      const values = entries.map(e => Number(e[metric])).filter(Number.isFinite);
      totals[metric] = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
    } else {
      totals[metric] = entries.reduce((sum, e) => sum + (Number(e[metric]) || 0), 0);
    }
  }
  return { columns, entries, totals };
}

// Upload preflight: everything the real upload would check, minus the upload.
// It never calls Google's upload endpoints; the only optional network call is a
// read-only channels.list when `verifyToken` is requested.
app.post("/api/youtube/upload/preflight", async (req, res) => {
  const body = req.body || {};
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

  push("OAUTH_CONFIG", youtubeConfigReady(),
    youtubeConfigReady() ? "client id/secret/redirect + APP_SESSION_SECRET present" : "YOUTUBE_* env vars या APP_SESSION_SECRET गायब हैं");

  let token = null;
  try {
    token = youtubeConfigReady() ? readYoutubeSession(req) : null;
  } catch (_) { token = null; }
  push("CHANNEL_CONNECTED", Boolean(token && token.access_token),
    token && token.access_token
      ? "चैनल connected" + (token.channel && token.channel.title ? " (" + token.channel.title + ")" : "")
      : "पहले 'YouTube चैनल Connect करें'");

  if (token && token.access_token && body.verifyToken === true) {
    try {
      const fresh = await getYoutubeAccessToken(req, res);
      const probe = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: "Bearer " + fresh },
      });
      const data = await probe.json().catch(() => ({}));
      push("TOKEN_VALID", probe.ok && Boolean(data.items && data.items[0]),
        probe.ok ? "token वाज़िब है" : "token reject हुआ (HTTP " + probe.status + ")");
    } catch (error) {
      push("TOKEN_VALID", false, redactSecrets(error.message || "token check विफल"));
    }
  }

  // Video: either a project that has been rendered, or an explicit size/mime.
  let bytes = null;
  let mime = String(body.mime || "video/mp4").split(";")[0];
  if (body.projectId) {
    const project = ownedProjectById(req, res, String(body.projectId));
    if (!project) return;
    const file = project.render && project.render.videoPath;
    if (file && fs.existsSync(file)) {
      bytes = fs.statSync(file).size;
      push("VIDEO_FILE", true, "rendered MP4 मौजूद है (" + (bytes / 1024 / 1024).toFixed(1) + " MB)");
    } else {
      push("VIDEO_FILE", false, "इस project का rendered MP4 नहीं मिला — पहले render करें");
    }
  } else {
    bytes = Number(body.size) || null;
    push("VIDEO_FILE", bytes !== null, bytes !== null ? "declared size " + (bytes / 1024 / 1024).toFixed(1) + " MB" : "size या projectId भेजें");
  }
  if (bytes !== null) {
    push("VIDEO_SIZE_LIMIT", bytes <= 90 * 1024 * 1024, bytes <= 90 * 1024 * 1024 ? "90 MB सीमा के अंदर" : "90 MB से बड़ा — hosted upload नहीं होगा");
  }
  push("VIDEO_MIME", ["video/mp4", "video/quicktime", "video/webm"].includes(mime), "mime: " + mime);

  const title = String(body.title || "").trim();
  const description = String(body.description || "");
  const privacy = String(body.privacy || "private");
  const tags = Array.isArray(body.tags) ? body.tags.map(t => String(t).trim()).filter(Boolean) : [];
  const normalizedTags = normalizeYoutubeTags(tags);
  push("TAGS", normalizedTags.ok,
    tags.length
      ? normalizedTags.ok
        ? normalizedTags.tags.length + " tags, " + normalizedTags.length + "/500 अक्षर"
        : "tags बहुत लंबे: " + normalizedTags.length + "/500 अक्षर (YouTube सीमा)"
      : "कोई tag नहीं — video खोज में कम दिखेगा");
  // YouTube requires snippet.categoryId on insert; a missing value is a failed
  // upload, so it is validated here where nothing is published.
  const categoryId = String(body.categoryId || process.env.DEFAULT_YOUTUBE_CATEGORY_ID || "22");
  push("CATEGORY", /^[0-9]{1,3}$/.test(categoryId), "categoryId: " + categoryId);
  const schedule = validateScheduleAt(body.publishAt);
  push("SCHEDULE", schedule.ok,
    schedule.ok
      ? (schedule.publishAt
        ? "निर्धारित: " + schedule.publishAt + " (private रहेगा, तब public होगा)"
        : "कोई schedule नहीं — अभी upload होगा")
      : schedule.message);
  push("TITLE", title.length > 0 && title.length <= 100, title ? title.length + "/100 अक्षर" : "title जरूरी है");
  push("DESCRIPTION", description.length <= 5000, description.length + "/5000 अक्षर");
  push("PRIVACY", ["private", "unlisted", "public"].includes(privacy), "privacy: " + privacy);

  const ok = checks.every(item => item.ok);
  return res.json({
    ok,
    checks,
    wouldUpload: false,
    note: ok
      ? "सब कुछ तैयार है। असली upload आपके explicit confirm के बिना नहीं होगा।"
      : "जो checks fail हुए हैं उन्हें पहले ठीक करें। कोई upload नहीं हुआ।",
  });
});

app.post("/api/youtube/upload", express.raw({ type: "video/*", limit: "90mb" }), async (req, res) => {
  // Publishing is irreversible: the client must state the confirmation again
  // in the request itself, not just in the UI.
  if (String(req.get("x-confirm-upload") || "").toLowerCase() !== "yes") {
    return res.status(409).json({
      error: "Upload के लिए explicit confirmation चाहिए (x-confirm-upload: yes)।",
      code: "CONFIRM_REQUIRED",
    });
  }
  if (!youtubeConfigReady()) return youtubeNotConfigured(res);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "MP4 वीडियो फ़ाइल भेजें।" });
  if (req.body.length > 90 * 1024 * 1024) return res.status(413).json({ error: "इस hosted upload में 90 MB तक की फ़ाइल स्वीकार है।" });
  let title = String(req.headers["x-video-title"] || "").trim().slice(0, 100);
  let description = String(req.headers["x-video-description"] || "").slice(0, 5000);
  let privacy = String(req.headers["x-video-privacy"] || "private");
  // YouTube requires snippet.categoryId on insert. "22" is People & Blogs, the
  // right shelf for a Hindi kids' cartoon channel, and is a valid default.
  let categoryId = String(req.headers["x-video-category"] || process.env.DEFAULT_YOUTUBE_CATEGORY_ID || "22");
  let tags = String(req.headers["x-video-tags"] || "").split(",").map(t => t.trim()).filter(Boolean);
  // ISO timestamps are ASCII, so a header is fine; the meta blob can also carry it.
  let publishAtInput = req.headers["x-video-publish-at"];
  // Non-Latin-1 text (Hindi titles/descriptions) cannot travel in an HTTP
  // header: browsers reject header values above 0xFF before the request is
  // sent. Metadata therefore also accepts a base64 JSON blob.
  const metaHeader = req.headers["x-video-meta-b64"];
  if (metaHeader) {
    try {
      const meta = JSON.parse(Buffer.from(String(metaHeader), "base64").toString("utf8"));
      if (typeof meta.title === "string") title = meta.title.trim().slice(0, 100);
      if (typeof meta.description === "string") description = meta.description.slice(0, 5000);
      if (typeof meta.privacy === "string") privacy = meta.privacy;
      if (Array.isArray(meta.tags)) tags = meta.tags.map(t => String(t).slice(0, 60)).slice(0, 30);
      if (meta.categoryId !== undefined) categoryId = String(meta.categoryId).trim().slice(0, 3);
      if (meta.publishAt !== undefined) publishAtInput = meta.publishAt;
    } catch (_) {
      return res.status(400).json({ error: "Video metadata decode नहीं हुई।" });
    }
  }
  const mime = String(req.headers["content-type"] || "video/mp4").split(";")[0];
  if (!title) return res.status(400).json({ error: "YouTube वीडियो का title भरें।" });
  if (!["private", "unlisted", "public"].includes(privacy)) return res.status(400).json({ error: "Privacy private/unlisted/public में से चुनें।" });
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(mime)) return res.status(415).json({ error: "समर्थित फ़ाइल: MP4, MOV या WebM।" });
  // The preflight validated these; the real upload must too, or an invalid
  // categoryId or an over-long tag string reaches Google and the publisher gets
  // an opaque 400 after the bytes were already sent. Fail here, before upload.
  if (!/^[0-9]{1,3}$/.test(categoryId)) {
    return res.status(400).json({ error: "YouTube categoryId 1–3 अंकों का होना चाहिए।" });
  }
  const prepared = normalizeYoutubeTags(tags);
  if (!prepared.ok) {
    return res.status(400).json({ error: "Tags YouTube सीमा से बड़े हैं (कुल 500 अक्षर तक)। कुछ tags हटाएँ।" });
  }
  tags = prepared.tags;
  const schedule = validateScheduleAt(publishAtInput);
  if (!schedule.ok) return res.status(400).json({ error: schedule.message, code: "INVALID_PUBLISH_AT" });
  const statusBlock = buildVideoStatus({ privacy, publishAt: schedule.publishAt });
  try {
    const token = await getYoutubeAccessToken(req, res);
    if (!token) return;
    const initUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
    const init = await fetch(initUrl, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(req.body.length) },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          categoryId,
          ...(tags.length ? { tags } : {}),
        },
        status: statusBlock,
      })
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
    return res.json({
      success: true,
      videoId: result.id,
      url: "https://youtu.be/" + result.id,
      // When a schedule is set, Google keeps the video private until publishAt.
      privacy: statusBlock.privacyStatus,
      publishAt: statusBlock.publishAt || null,
    });
  } catch (error) {
    safeLog("YouTube upload failed", error);
    return res.status(502).json({ error: "YouTube upload विफल हुआ। Render logs में सुरक्षित status जाँचें।" });
  }
});


/* ---- Render a narrated slideshow MP4 from generated scene images + Gemini TTS ---- */
const os = require("os");
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
  return typeof value === "string" && value.length > 0 && value.length < 24 * 1024 * 1024 &&
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
  if (imageBytes > 12 * 1024 * 1024 || audioBytes > 16 * 1024 * 1024) {
    return { status: 413, error: "Generated assets बहुत बड़े हैं। छोटा script/voice या कम images चुनें।" };
  }
  return null;
}
// One render runs at a time; a second request waits in the persistent queue
// instead of being rejected, so long videos survive a server restart.
const MAX_RENDER_JOBS = 2;

async function renderToFile(body) {
  const scenes = body.scenes;
  const audioBase64 = body.audioBase64;
  const audioMime = String(body.audioMime || "audio/L16").toLowerCase();
  let tempDir;
  try {
    // Keep filesystem failures inside this route's JSON error boundary.
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "baba-render-"));
    const ffmpegPath = require("./lib/ffmpeg").resolveFfmpegPath();
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
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 300) {
      throw Object.assign(new Error("Voice duration 0.5–300 seconds (5 minutes) के बीच होनी चाहिए। छोटी narration से retry करें।"), { statusCode: 422 });
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
    await execFileAsync(ffmpegPath, args, { timeout: 420000, maxBuffer: 4 * 1024 * 1024 });
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
  // The queue is persistent: a render accepted before a restart resumes from
  // its stored payload instead of being lost with the process.
  const backlog = jobQueue.list({ type: "render" }).filter(job => job.status === "queued" || job.status === "processing");
  if (backlog.length >= MAX_RENDER_JOBS) return res.status(429).json({ error: "अभी दूसरे वीडियो render हो रहे हैं। थोड़ी देर बाद retry करें।" });
  const job = jobQueue.create({ type: "render", ownerId: req.user.id, payload: req.body, maxAttempts: 1 });
  res.status(202).json({ jobId: job.id, status: job.status, statusUrl: "/api/render/status/" + job.id });
});

app.get("/api/render/status/:jobId", (req, res) => {
  const job = jobQueue.get(req.params.jobId);
  // Another user's job id must be indistinguishable from an unknown one.
  if (!job || (job.ownerId && job.ownerId !== req.user.id)) {
    return res.status(404).json({ error: "Render job नहीं मिला।" });
  }
  return res.json({ jobId: job.id, status: job.status, error: job.error, size: job.result && job.result.size,
    downloadUrl: job.status === "completed" ? "/api/render/download/" + job.id : null,
    updatedAt: new Date(job.updatedAt).toISOString() });
});

app.get("/api/render/download/:jobId", (req, res) => {
  const job = jobQueue.get(req.params.jobId);
  if (!job || (job.ownerId && job.ownerId !== req.user.id)) {
    return res.status(404).json({ error: "Render job नहीं मिला।" });
  }
  if (job.status !== "completed" || !job.result || !job.result.outputPath) {
    return res.status(409).json({ error: "वीडियो अभी डाउनलोड के लिए तैयार नहीं है।" });
  }
  const outputPath = job.result.outputPath;
  const size = job.result.size;
  if (!fs.existsSync(outputPath)) return res.status(410).json({ error: "Rendered फ़ाइल अब उपलब्ध नहीं है। दोबारा render करें।" });
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", 'attachment; filename="BABA-AI-video.mp4"');
  if (size) res.setHeader("Content-Length", String(size));
  return res.sendFile(outputPath, err => {
    if (err) safeLog("MP4 download failed", err);
    if (job.result.tempDir) fs.promises.rm(job.result.tempDir, { recursive: true, force: true }).catch(() => {});
    jobQueue.remove(job.id);
  });
});


/* ---- Phase 2: characters, story engine, project pipeline, real renderer ---- */
const { CharacterLibrary } = require("./lib/characters");
const characterLibrary = new CharacterLibrary({
  file: path.join(dataRoot, "characters.json"),
}).load();

const { ProjectStore, createProject } = require("./lib/projects");
const projectStore = new ProjectStore({ root: path.join(dataRoot, "projects") });
const recoveredProjects = projectStore.recoverInterrupted();
if (recoveredProjects) console.log("Resumed " + recoveredProjects + " interrupted project(s) from disk");

const storyEngine = require("./lib/story");
const timelineEngine = require("./lib/timeline");
const pipeline = require("./lib/pipeline");
const ffmpegTools = require("./lib/ffmpeg");

// Persistent queue: job state (and the render payload) is written to disk, so
// jobs accepted before a restart are resumed instead of silently disappearing.
const { JobQueue } = require("./lib/jobs");
const jobQueue = new JobQueue({ dir: path.join(dataRoot, "jobs") }).load();
jobQueue.logger = line => safeLog(line);
jobQueue.handler("render", async job => {
  const result = await renderToFile(job.payload);
  return { tempDir: result.tempDir, outputPath: result.outputPath, size: result.size };
});
jobQueue.handler("project", async job => {
  if (runningProjects.has(job.projectId)) {
    throw Object.assign(new Error("प्रोजेक्ट पहले से चल रहा है।"), { statusCode: 409 });
  }
  runningProjects.set(job.projectId, { startedAt: Date.now() });
  try {
    await runProjectStage(job.projectId, job.stage);
  } finally {
    runningProjects.delete(job.projectId);
  }
  return { projectId: job.projectId, stage: job.stage };
});
jobQueue.start();

// One background job per project; a second request for the same project is
// rejected instead of silently racing the first one.
const runningProjects = new Map();

function geminiProviders() {
  const ai = getAIClient();
  const scriptModel = process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash";
  const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
  const ttsModel = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  return {
    text: {
      generate: async prompt => {
        const generated = await withTimeout(
          generateTextWithQuotaFallback(ai, prompt, scriptModel),
          geminiTimeoutMs(), "text " + scriptModel
        );
        return generated.response.text;
      },
    },
    image: {
      generate: async prompt => {
        const response = await withTimeout(withTemporaryRetries(() => ai.models.generateContent({
          model: imageModel,
          contents: prompt,
          config: { responseModalities: ["TEXT", "IMAGE"] },
        })), geminiTimeoutMs(), "image " + imageModel);
        const part = (response.candidates?.[0]?.content?.parts || [])
          .find(item => item.inlineData?.data && String(item.inlineData.mimeType || "").startsWith("image/"));
        if (!part) {
          throw Object.assign(new Error("Gemini ने image payload नहीं दिया।"), { statusCode: 502 });
        }
        return { mimeType: part.inlineData.mimeType, imageBase64: part.inlineData.data };
      },
    },
    voice: {
      generate: async (text, options = {}) => {
        const voiceName = options.voiceName || "Kore";
        const response = await withTimeout(withTemporaryRetries(() => ai.models.generateContent({
          model: ttsModel,
          contents: [{ parts: [{ text }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        })), geminiTimeoutMs(), "voice " + ttsModel);
        const part = (response.candidates?.[0]?.content?.parts || []).find(item => item.inlineData?.data);
        if (!part) {
          throw Object.assign(new Error("Gemini ने audio payload नहीं दिया।"), { statusCode: 502 });
        }
        return {
          mimeType: part.inlineData.mimeType || "audio/L16;rate=24000",
          audioBase64: part.inlineData.data,
          voiceName,
        };
      },
    },
  };
}

// Every project lookup goes through here so one user can never read, render or
// delete another user's project.
function ownedProjectById(req, res, id) {
  const project = projectStore.get(id);
  if (!project) {
    res.status(404).json({ error: "प्रोजेक्ट नहीं मिला।" });
    return null;
  }
  if (project.ownerId && project.ownerId !== req.user.id) {
    res.status(403).json({ error: "यह प्रोजेक्ट आपका नहीं है।", code: "FORBIDDEN" });
    return null;
  }
  return project;
}

function ownedProject(req, res) {
  const project = projectStore.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: "प्रोजेक्ट नहीं मिला।" });
    return null;
  }
  if (project.ownerId && project.ownerId !== req.user.id) {
    res.status(403).json({ error: "यह प्रोजेक्ट आपका नहीं है।", code: "FORBIDDEN" });
    return null;
  }
  return project;
}

function blocked(message) {
  return { blocked: true, error: message };
}

// Honest feature matrix: what is wired, what needs a key, what does not exist.
app.get("/api/capabilities", async (req, res) => {
  const ffmpegOk = await ffmpegTools.ffmpegAvailable();
  const hasKey = Boolean(readSecret("GEMINI_API_KEY"));
  const lipEngine = lipsyncEngine.resolveEngine();
  const rigged = characterLibrary.listFor(req.user.id).filter(c => c.rig && c.rig.animationReady);
  const features = {
    story: hasKey ? "available" : "blocked",
    sceneImages: hasKey ? "available" : "blocked",
    voice: hasKey ? "available" : "blocked",
    render: ffmpegOk ? "available" : "blocked",
    captions: ffmpegOk ? "available" : "blocked",
    music: ffmpegOk ? "available" : "blocked",
    // 2D puppet animation: real mouth sprites + real Rhubarb cues. Only the
    // characters that actually have a rig can animate, and only with an engine.
    characterAnimation: rigged.length ? "available" : "blocked",
    lipSync: lipEngine ? (rigged.length ? "available" : "blocked") : "blocked",
    youtubeUpload: youtubeConfigReady() ? "available" : "blocked",
  };
  const reasons = [];
  if (!hasKey) reasons.push("GEMINI_API_KEY सेट नहीं है — story, images और voice नहीं चलेंगे।");
  if (!ffmpegOk) reasons.push("FFmpeg binary नहीं मिला — rendering नहीं चलेगी।");
  if (!youtubeConfigReady()) reasons.push("YouTube OAuth configure नहीं है — upload नहीं चलेगा।");
  if (!lipEngine) {
    reasons.push("Lip-sync engine installed नहीं है (npm install rhubarb-lip-sync-wasm)।");
  } else if (!rigged.length) {
    reasons.push("किसी character के पास mouth sprites (rig) नहीं हैं — animation तभी चलेगी।");
  }
  return res.json({
    features,
    blockedReasons: reasons,
    models: Object.fromEntries(configuredModels().map(model => [model.role, model.id])),
    ffmpeg: { available: ffmpegOk, version: ffmpegOk ? await ffmpegTools.ffmpegVersion() : null },
    animationProvider: lipEngine ? lipsyncEngine.engineLabel() : "none",
    animationReadyCharacters: rigged.map(c => ({ id: c.id, name: c.name, shapes: c.rig.shapes })),
    animationMode: lipEngine && rigged.length
      ? "2D puppet: mouth sprites swapped on real Rhubarb cues (not full-body 3D animation)"
      : "none",
    limits: {
      maxDurationMinutes: 30,
      maxScenes: 150,
      renderResolution: "720p default, 1080p optional",
      renderMode: "Ken Burns camera motion + optional 2D mouth overlay on rigged characters",
    },
  });
});

// ---- Setup audit: what is configured, what is missing, and how to fix it ----
const { auditSetup, setupGuideFor } = require("./lib/setup");
const lipsyncEngine = require("./lib/lipsync");
const { MODEL_CHECKS, configuredModels, listModelIds } = require("./lib/models");
const fontsLib = require("./lib/fonts");

function setupRuntime() {
  return {
    env: process.env,
    // resolveFfmpegPath() always returns something (it falls back to "ffmpeg"),
    // so presence alone is not proof that a working binary exists.
    ffmpeg: { available: ffmpegTools.ffmpegAvailableSync(), version: null },
    fontFile: fontsLib.resolveFontFile(),
    youtubeReady: youtubeConfigReady(),
    lipSync: { available: Boolean(lipsyncEngine.resolveEngine()), source: lipsyncEngine.resolveEngine() ? lipsyncEngine.resolveEngine().source : "none" },
    dataDir: dataRoot,
  };
}

app.get("/api/setup", async (req, res) => {
  try {
    const runtime = setupRuntime();
    if (runtime.ffmpeg.available) runtime.ffmpeg.version = await ffmpegTools.ffmpegVersion();
    return res.json(auditSetup(runtime));
  } catch (error) {
    return res.status(500).json({ error: "Setup audit विफल: " + redactSecrets(error.message || error) });
  }
});

// One real check per item. With a key present this calls models.list() (free
// metadata, no tokens) so a bad key is reported as bad instead of discovered
// halfway through a render.
app.post("/api/setup/verify", async (req, res) => {
  const runtime = setupRuntime();
  const results = [];
  const push = (id, status, detail, extra) => results.push(Object.assign({ id, status, detail }, extra || {}));

  // ffmpegVersion() returns null (instead of throwing) when the binary cannot
  // run, so a null version must never be reported as "ok".
  try {
    const version = await ffmpegTools.ffmpegVersion();
    if (!version) push("FFMPEG", "blocked", "FFmpeg binary नहीं चला — FFMPEG_PATH दें या ffmpeg install करें", { reason: "unavailable" });
    else {
      runtime.ffmpeg.version = version;
      push("FFMPEG", "ok", "ffmpeg " + version);
    }
  } catch (error) {
    push("FFMPEG", "blocked", redactSecrets(error.message || "FFmpeg नहीं चला"), { reason: "unavailable" });
  }

  try {
    const font = fontsLib.resolveFontFile();
    const bytes = font ? fs.readFileSync(font) : null;
    push("DEVANAGARI_FONT", bytes && bytes.length > 100 * 1024 ? "ok" : "warn",
      bytes ? ("font " + (bytes.length / 1024).toFixed(0) + " KB") : "bundled font नहीं मिला");
  } catch (error) {
    push("DEVANAGARI_FONT", "warn", redactSecrets(error.message || "font पढ़ा नहीं गया"));
  }

  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const probe = path.join(dataRoot, ".write-probe-" + process.pid);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    push("DATA_DIR", "ok", "writable");
  } catch (error) {
    push("DATA_DIR", "blocked", redactSecrets(error.message || "data directory लिखने योग्य नहीं"), { reason: "unavailable" });
  }

  const engine = lipsyncEngine.resolveEngine();
  push("LIPSYNC_ENGINE", engine ? "ok" : "blocked", engine ? engine.label : "not installed (optional)",
    engine ? undefined : { reason: "not_configured" });

  push("YOUTUBE_OAUTH", youtubeConfigReady() ? "ok" : "blocked",
    youtubeConfigReady() ? "configured (secrets hidden)" : "not configured",
    youtubeConfigReady() ? undefined : { reason: "not_configured" });

  const key = readSecret("GEMINI_API_KEY");
  let modelIds = null;
  if (!key) {
    push("GEMINI_API_KEY", "blocked", "not set", { reason: "not_set" });
  } else {
    try {
      const ai = getAIClient();
      const listed = await Promise.race([
        ai.models.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
      ]);
      // One metadata call answers both questions: is the key valid, and which of
      // the configured model IDs can this key actually use?
      modelIds = await listModelIds(listed);
      push("GEMINI_API_KEY", "ok", "key accepted by Gemini API" + (modelIds.size ? " (" + modelIds.size + " models visible)" : ""));
    } catch (error) {
      // Distinguish "Google rejected this key" from "Google was unreachable".
      // The old code labelled both "rejected", which sends the user to rotate a
      // valid key when the real fault was DNS, TLS or the host's firewall.
      if (isNetworkError(error)) {
        push("GEMINI_API_KEY", "blocked",
          "Gemini API तक पहुँच नहीं बनी (key की जाँच नहीं हो सकी): " + networkErrorDetail(error),
          { reason: "network", retryable: true });
      } else {
        push("GEMINI_API_KEY", "blocked", redactSecrets(error.message || "Gemini ने key reject की"), { reason: "rejected" });
      }
    }
  }

  // Availability is claimed only for IDs actually present in models.list. An
  // absent ID is reported as missing — it is never presented as usable.
  const modelAvailability = [];
  for (const model of configuredModels()) {
    let status = "unknown";
    let detail = "models.list नहीं हो सका — availability unknown";
    if (modelIds) {
      const seen = modelIds.has(model.id);
      status = seen ? "ok" : (model.required ? "blocked" : "warn");
      detail = seen
        ? "इस key के लिए models.list में मिला"
        : (model.required
          ? "models.list में नहीं मिला — model ID या इस key की access जाँचें"
          : "models.list में नहीं मिला — यह fallback इस्तेमाल नहीं हो पाएगा (optional)");
    }
    modelAvailability.push({ role: model.role, id: model.id, required: model.required, status });
    push(model.checkId, status, detail, status === "blocked" ? { reason: "model_missing" } : undefined);
  }

  const audit = auditSetup(runtime);
  // Only the checks a render actually needs decide the verdict: YouTube and the
  // optional lip-sync engine must not fail an otherwise working setup.
  const REQUIRED = ["FFMPEG", "DEVANAGARI_FONT", "DATA_DIR", "GEMINI_API_KEY",
    "GEMINI_SCRIPT_MODEL", "GEMINI_IMAGE_MODEL", "GEMINI_TTS_MODEL"];
  const isRequired = id => REQUIRED.includes(id);
  const ok = results.filter(item => isRequired(item.id)).every(item => item.status === "ok");
  // "Set नहीं है" और "set है पर verify नहीं हुआ" अलग-अलग बातें हैं। पहले दोनों को
  // एक ही "missing" कहा जाता था, जिससे reject हुई key "गायब" दिखती थी।
  const blocked = results.filter(item => item.status === "blocked" && isRequired(item.id));
  const missing = blocked.filter(item => item.reason === "not_set").map(item => item.id);
  const failed = blocked.filter(item => item.reason !== "not_set").map(item => item.id);
  return res.json({
    verifiedAt: new Date().toISOString(),
    ok,
    missing,
    failed,
    // Shape only — the key itself never leaves the process.
    keyShape: keyShape(process.env.GEMINI_API_KEY),
    results,
    models: modelAvailability,
    setupGuide: audit.setupGuide,
    note: "Secrets कभी response में नहीं आते।",
  });
});

app.get("/api/setup/guide/:checkId", (req, res) => {
  const guide = setupGuideFor(String(req.params.checkId || "").toUpperCase());
  if (!guide) return res.status(404).json({ error: "इस check के लिए guide नहीं है।" });
  return res.json(Object.assign({ id: req.params.checkId }, guide));
});

// ---- Character library ----
app.get("/api/characters", (req, res) => {
  return res.json({ characters: characterLibrary.listFor(req.user.id) });
});

app.post("/api/characters", (req, res) => {
  try {
    const body = { ...(req.body || {}), ownerId: req.user.id };
    const existing = characterLibrary.listFor(req.user.id);
    const index = existing.findIndex(c => c.id === body.id);
    const saved = characterLibrary.upsert(body, index >= 0 ? index : existing.length);
    return res.json({ character: saved });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || "किरदार सेव नहीं हुआ।" });
  }
});

app.delete("/api/characters/:id", (req, res) => {
  const character = characterLibrary.get(req.params.id);
  if (!character || (character.ownerId && character.ownerId !== req.user.id)) {
    return res.status(404).json({ error: "किरदार नहीं मिला।" });
  }
  characterLibrary.remove(req.params.id);
  return res.json({ success: true, characters: characterLibrary.listFor(req.user.id) });
});

// ---- Animation rig: real mouth sprites on disk, nothing simulated ----
const { MOUTH_SHAPES } = require("./lib/characters");
const lipsync = require("./lib/lipsync");
const animator = require("./lib/animator");

function decodeSprite(value) {
  const raw = String(value || "");
  const match = raw.match(/^data:([^;]+);base64,(.*)$/s);
  const mime = match ? match[1].toLowerCase() : null;
  const body = match ? match[2] : raw;
  if (!body) return null;
  const bytes = Buffer.from(body, "base64");
  if (!bytes.length) return null;
  if (bytes.length > 2 * 1024 * 1024) return null;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) return null;
  if (mime && !/^image\/(png|jpeg)$/.test(mime)) return null;
  return { bytes, mime: png ? "image/png" : "image/jpeg" };
}

function ownedCharacter(req, res) {
  const character = characterLibrary.get(req.params.id);
  if (!character || (character.ownerId && character.ownerId !== req.user.id)) {
    res.status(404).json({ error: "किरदार नहीं मिला।" });
    return null;
  }
  return character;
}

app.get("/api/characters/:id", (req, res) => {
  const character = ownedCharacter(req, res);
  if (!character) return;
  const rig = character.rig || null;
  return res.json({
    character,
    animation: {
      ready: Boolean(rig && rig.animationReady),
      shapes: rig ? rig.shapes : [],
      anchor: rig ? rig.anchor : null,
      lipSyncEngine: lipsync.engineLabel(),
      message: rig && rig.animationReady
        ? "Animation rig तैयार है।"
        : "Mouth sprites अपलोड करें तभी lip-sync चलेगा।",
    },
  });
});

// Upload one or more mouth/expression sprites. Base64 bodies are validated by
// magic bytes and written as real files under data/characters/<id>/.
app.post("/api/characters/:id/rig", (req, res) => {
  const character = ownedCharacter(req, res);
  if (!character) return;
  const body = req.body || {};
  const existing = character.rig || {};
  const next = {
    mouth: Object.assign({}, existing.mouth || {}),
    expressions: Object.assign({}, existing.expressions || {}),
    anchor: Object.assign({}, existing.anchor || {}, body.anchor || {}),
    source: "manual",
  };

  let written = 0;
  const failures = [];
  for (const shape of MOUTH_SHAPES) {
    const value = body.mouth && body.mouth[shape];
    if (!value) continue;
    const sprite = decodeSprite(value);
    if (!sprite) { failures.push(shape); continue; }
    const file = characterLibrary.spritePath(character.id, "mouth", shape);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sprite.bytes);
    next.mouth[shape] = file;
    written += 1;
  }
  for (const name of ["neutral", "happy", "sad", "angry", "surprised"]) {
    const value = body.expressions && body.expressions[name];
    if (!value) continue;
    const sprite = decodeSprite(value);
    if (!sprite) { failures.push(name); continue; }
    const file = characterLibrary.spritePath(character.id, "expression", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sprite.bytes);
    next.expressions[name] = file;
    written += 1;
  }
  if (!written) {
    return res.status(400).json({
      error: "कोई सही image नहीं मिली। PNG/JPEG अपलोड करें।",
      invalid: failures,
    });
  }
  const updated = characterLibrary.setRig(character.id, next, req.user.id);
  return res.json({
    character: updated,
    written,
    invalid: failures,
    animationReady: Boolean(updated.rig && updated.rig.animationReady),
    shapes: updated.rig ? updated.rig.shapes : [],
  });
});

app.delete("/api/characters/:id/rig", (req, res) => {
  const character = ownedCharacter(req, res);
  if (!character) return;
  const updated = characterLibrary.removeRig(character.id, req.user.id);
  return res.json({ character: updated, success: true });
});

// Analyse narration and return the mouth-cue timeline (used by the dashboard
// preview and by the renderer). Blocked, with install steps, when no engine.
app.post("/api/characters/:id/lipsync", async (req, res) => {
  const character = ownedCharacter(req, res);
  if (!character) return;
  const audioBase64 = String((req.body || {}).audioBase64 || "");
  if (!audioBase64) return res.status(400).json({ error: "audioBase64 चाहिए।" });
  if (!lipsync.resolveEngine()) {
    return res.status(503).json(Object.assign(blocked(
      "Lip-sync engine installed नहीं है (npm install rhubarb-lip-sync-wasm या RHUBARB_PATH)।"
    ), { setup: { steps: [
      "npm install rhubarb-lip-sync-wasm",
      "या native binary का path RHUBARB_PATH में सेट करें",
    ] } }));
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "baba-lipsync-"));
  const audioPath = path.join(tempDir, "narration.audio");
  try {
    fs.writeFileSync(audioPath, Buffer.from(audioBase64, "base64"));
    const result = await lipsync.analyseAudio({
      audioPath,
      runFfmpeg: ffmpegTools.runFfmpeg,
      dialogText: String((req.body || {}).dialogText || "").slice(0, 4000),
    });
    return res.json({
      cues: result.cues,
      durationSeconds: result.durationSeconds,
      shapes: result.shapes,
      engine: result.engine,
      source: result.source,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Lip-sync विफल।" });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- Story generation (requires a real provider key) ----
app.post("/api/story", async (req, res) => {
  if (!readSecret("GEMINI_API_KEY")) {
    return res.status(503).json(blocked("GEMINI_API_KEY सेट नहीं है। Story generation BLOCKED है।"));
  }
  try {
    const { topic, language, style, durationMinutes, characterIds } = req.body || {};
    if (typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ error: "कहानी का विषय लिखें।" });
    }
    if (topic.trim().length > 300) {
      return res.status(400).json({ error: "विषय 300 अक्षरों से छोटा रखें।" });
    }
    const minutes = Math.min(30, Math.max(1, Number(durationMinutes) || 1));
    const sceneCount = storyEngine.planSceneCount(minutes);
    const all = characterLibrary.listFor(req.user.id);
    const selected = Array.isArray(characterIds) && characterIds.length
      ? all.filter(c => characterIds.includes(c.id))
      : all.slice(0, 4);
    const prompt = storyEngine.buildStoryPrompt({
      topic: topic.trim(),
      language: language === "English" ? "English" : "हिंदी",
      style: ["3d-cartoon", "cinematic", "realistic"].includes(style) ? style : "3d-cartoon",
      sceneCount,
      characters: selected,
      durationMinutes: minutes,
    });
    const providers = geminiProviders();
    const text = await providers.text.generate(prompt);
    const parsed = storyEngine.parseStory(text, {
      sceneCount,
      characters: selected,
      language: language === "English" ? "English" : "हिंदी",
      style: ["3d-cartoon", "cinematic", "realistic"].includes(style) ? style : "3d-cartoon",
    });
    return res.json({ story: parsed, sceneCount, provider: "gemini" });
  } catch (error) {
    return sendAPIError(res, error, "कहानी नहीं बन सकी।");
  }
});

// ---- Projects ----
app.get("/api/projects", (req, res) => {
  return res.json({ projects: projectStore.listFor(req.user.id) });
});

app.post("/api/projects", (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.topic !== "string" || !body.topic.trim()) {
      return res.status(400).json({ error: "प्रोजेक्ट का विषय लिखें।" });
    }
    const project = createProject({
      ownerId: req.user.id,
      topic: body.topic,
      language: body.language,
      style: body.style,
      aspect: body.aspect,
      quality: body.quality,
      durationMinutes: body.durationMinutes,
      sceneCount: Math.min(150, Math.max(3, Number(body.sceneCount) || storyEngine.planSceneCount(body.durationMinutes))),
    });
    projectStore.save(project);
    return res.status(201).json({ project });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || "प्रोजेक्ट नहीं बना।" });
  }
});

app.get("/api/projects/:id", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  return res.json({ project });
});

app.delete("/api/projects/:id", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  if (runningProjects.has(req.params.id)) {
    return res.status(409).json({ error: "प्रोजेक्ट अभी चल रहा है; पहले रुकवाएँ।" });
  }
  const removed = projectStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: "प्रोजेक्ट नहीं मिला।" });
  return res.json({ success: true });
});

function projectStageTask(stage) {
  return async current => { await runProjectStage(current.id, stage); };
}

function startProjectJob(id, task, options = {}) {
  if (runningProjects.has(id)) {
    return { started: false, status: 409, error: "इस प्रोजेक्ट का काम पहले से चल रहा है।" };
  }
  const project = projectStore.get(id);
  if (!project) return { started: false, status: 404, error: "प्रोजेक्ट नहीं मिला।" };
  runningProjects.set(id, { startedAt: Date.now() });
  // Track the stage on disk so a restart resumes the same work instead of
  // leaving the project stuck in "interrupted".
  const job = options.stage
    ? jobQueue.track({
      id: options.jobId, type: "project", projectId: id, stage: options.stage,
      ownerId: project.ownerId || null, maxAttempts: 2,
    })
    : null;
  setImmediate(async () => {
    try {
      await task(project);
      if (job) jobQueue.complete(job.id, { projectId: id, stage: options.stage });
    } catch (error) {
      safeLog("Project job failed", error);
      project.status = "failed";
      project.error = error.statusCode && error.statusCode >= 500 && error.statusCode < 600
        ? (error.message || "काम विफल रहा।")
        : (error.message || "काम विफल रहा।");
      project.progress = { ...(project.progress || {}), stage: "failed", message: project.error, updatedAt: new Date().toISOString() };
      projectStore.save(project);
      if (job) jobQueue.fail(job.id, error);
    } finally {
      runningProjects.delete(id);
    }
  });
  return { started: true, status: 202, project };
}

function progressSaver(current) {
  return event => {
    current.progress = { ...current.progress, ...event, updatedAt: new Date().toISOString() };
    projectStore.save(current);
  };
}

// A stage is a pure function of the project on disk: finished scenes are
// skipped and missing ones rebuilt, so the same task can be replayed after a
// restart (either by the queue worker or by an explicit resume).
async function runProjectStage(projectId, stage) {
  const project = projectStore.get(projectId);
  if (!project) throw Object.assign(new Error("प्रोजेक्ट नहीं मिला।"), { statusCode: 404 });
  if (!["story", "assets", "render", "automate"].includes(stage)) {
    throw Object.assign(new Error("अनजान project stage: " + stage), { statusCode: 400 });
  }
  if (project.status === "cancelled") return project;
  const characters = characterLibrary.listFor(project.ownerId);
  const saveProgress = progressSaver(project);
  if (stage === "story") {
    projectStore.setStatus(project, "story", "कहानी लिखी जा रही है…");
    await pipeline.generateStory(project, { provider: geminiProviders(), characters: characters.slice(0, 4) });
    projectStore.setStatus(project, "story", "कहानी तैयार (" + project.story.scenes.length + " दृश्य)");
    return project;
  }
  if (stage === "assets") {
    if (!project.story) throw Object.assign(new Error("पहले कहानी बनाएँ।"), { statusCode: 409 });
    projectStore.setStatus(project, "generating", "Images और आवाज़ बन रही हैं…");
    await pipeline.generateAssets(project, {
      provider: geminiProviders(), store: projectStore, runFfmpeg: ffmpegTools.runFfmpeg, onProgress: saveProgress,
    });
    projectStore.setStatus(project, "assets", "सभी scenes के assets तैयार");
    projectStore.save(project);
    return project;
  }
  if (stage === "render") {
    if (!project.story) throw Object.assign(new Error("पहले कहानी बनाएँ।"), { statusCode: 409 });
    projectStore.setStatus(project, "rendering", "MP4 render हो रहा है…");
    const result = await pipeline.render(project, {
      store: projectStore, runFfmpeg: ffmpegTools.runFfmpeg, captionFont: process.env.CAPTION_FONT,
      characters: characterLibrary.listFor(project.ownerId), onProgress: saveProgress,
    });
    project.status = "completed";
    project.error = null;
    project.progress = {
      stage: "completed", percent: 100,
      message: "MP4 तैयार (" + (result.size / 1024 / 1024).toFixed(1) + " MB, " + Math.round(result.duration) + " सेकंड)",
      updatedAt: new Date().toISOString(),
    };
    projectStore.save(project);
    return project;
  }
  // automate: story -> assets -> render, resuming at whatever step is missing.
  if (!project.story) {
    projectStore.setStatus(project, "story", "कहानी लिखी जा रही है…");
    await pipeline.generateStory(project, { provider: geminiProviders(), characters: characters.slice(0, 4) });
    projectStore.save(project);
  }
  if (project.status === "cancelled") {
    project.progress = { ...(project.progress || {}), stage: "cancelled", message: "कहानी के बाद रोका गया", updatedAt: new Date().toISOString() };
    return projectStore.save(project);
  }
  const missing = project.story.scenes.filter(scene => {
    const asset = project.assets.scenes[scene.index];
    return !asset || !asset.image || !asset.audio;
  });
  if (missing.length) {
    projectStore.setStatus(project, "generating", "दृश्य और आवाज़ बन रहे हैं…");
    await pipeline.generateAssets(project, {
      provider: geminiProviders(), store: projectStore, runFfmpeg: ffmpegTools.runFfmpeg, onProgress: saveProgress,
    });
  }
  if (project.status === "cancelled") {
    project.progress = { ...(project.progress || {}), stage: "cancelled", message: "assets के बाद रोका गया", updatedAt: new Date().toISOString() };
    return projectStore.save(project);
  }
  projectStore.setStatus(project, "rendering", "MP4 render हो रहा है…");
  const result = await pipeline.render(project, {
    store: projectStore, runFfmpeg: ffmpegTools.runFfmpeg, captionFont: process.env.CAPTION_FONT,
    characters: characterLibrary.listFor(project.ownerId), onProgress: saveProgress,
  });
  if (project.status === "cancelled") {
    project.progress = { ...(project.progress || {}), stage: "cancelled", message: "render से पहले रोका गया", updatedAt: new Date().toISOString() };
    return projectStore.save(project);
  }
  project.status = "completed";
  project.error = null;
  project.progress = {
    stage: "completed", percent: 100,
    message: "MP4 तैयार (" + (result.size / 1024 / 1024).toFixed(1) + " MB, " + Math.round(result.duration) + " सेकंड)",
    updatedAt: new Date().toISOString(),
  };
  projectStore.save(project);
  return project;
}

app.post("/api/projects/:id/story", async (req, res) => {
  const id = req.params.id;
  // Ownership first: a missing key must not reveal whether a project exists.
  const project = ownedProject(req, res);
  if (!project) return;
  if (!readSecret("GEMINI_API_KEY")) {
    return res.status(503).json(blocked("GEMINI_API_KEY सेट नहीं है। Story generation BLOCKED है।"));
  }
  if (runningProjects.has(id)) return res.status(409).json({ error: "प्रोजेक्ट पहले से चल रहा है।" });
  const started = startProjectJob(id, projectStageTask("story"), { stage: "story" });
  if (!started.started) return res.status(started.status).json({ error: started.error });
  return res.status(202).json({ project: projectStore.get(id) });
});

app.post("/api/projects/:id/assets", (req, res) => {
  const id = req.params.id;
  const project = ownedProject(req, res);
  if (!project) return;
  if (!readSecret("GEMINI_API_KEY")) {
    return res.status(503).json(blocked("GEMINI_API_KEY सेट नहीं है। Images और voice BLOCKED हैं।"));
  }
  if (!project.story) return res.status(409).json({ error: "पहले कहानी बनाएँ।" });
  const started = startProjectJob(id, projectStageTask("assets"), { stage: "assets" });
  if (!started.started) return res.status(started.status).json({ error: started.error });
  return res.status(202).json({ project: projectStore.get(id) });
});

app.post("/api/projects/:id/render", (req, res) => {
  const id = req.params.id;
  const project = ownedProject(req, res);
  if (!project) return;
  if (!project.story) return res.status(409).json({ error: "पहले कहानी बनाएँ।" });
  const started = startProjectJob(id, projectStageTask("render"), { stage: "render" });
  if (!started.started) return res.status(started.status).json({ error: started.error });
  return res.status(202).json({ project: projectStore.get(id) });
});

// One-click automation: story -> assets -> render, resumable at every step.
app.post("/api/projects/:id/automate", (req, res) => {
  const id = req.params.id;
  const project = ownedProject(req, res);
  if (!project) return;
  if (!readSecret("GEMINI_API_KEY")) {
    return res.status(503).json(blocked("GEMINI_API_KEY सेट नहीं है। Automatic pipeline BLOCKED है।"));
  }
  const started = startProjectJob(id, projectStageTask("automate"), { stage: "automate" });
  if (!started.started) return res.status(started.status).json({ error: started.error });
  return res.status(202).json({ project: projectStore.get(id) });
});

// Retry only the failed scene: existing images/audio for other scenes are kept.
app.post("/api/projects/:id/scenes/:index/retry", async (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  if (!readSecret("GEMINI_API_KEY")) {
    return res.status(503).json(blocked("GEMINI_API_KEY सेट नहीं है। Retry BLOCKED है।"));
  }
  if (!project.story) return res.status(409).json({ error: "पहले कहानी बनाएँ।" });
  const index = Number(req.params.index);
  const scene = project.story.scenes.find(item => Number(item.index) === index);
  if (!scene) return res.status(404).json({ error: "दृश्य नहीं मिला।" });
  if (runningProjects.has(project.id)) return res.status(409).json({ error: "प्रोजेक्ट पहले से चल रहा है।" });

  const asset = project.assets.scenes[index] || {};
  if (asset.image && asset.image.path) fs.rmSync(asset.image.path, { force: true });
  if (asset.audio && asset.audio.path) fs.rmSync(asset.audio.path, { force: true });
  delete project.assets.scenes[index];
  projectStore.save(project);

  try {
    await pipeline.generateAssets(project, {
      provider: geminiProviders(),
      store: projectStore,
      runFfmpeg: ffmpegTools.runFfmpeg,
      onlyScenes: [index],
    });
    project.status = project.render ? "completed" : "assets";
    projectStore.save(project);
    return res.json({ project, retried: index });
  } catch (error) {
    project.status = "failed";
    project.error = error.message || "दृश्य दोबारा नहीं बन सका।";
    projectStore.save(project);
    return sendAPIError(res, error, "दृश्य दोबारा नहीं बन सका।");
  }
});

app.get("/api/projects/:id/video", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  if (!project.render || !project.render.videoPath || !fs.existsSync(project.render.videoPath)) {
    return res.status(409).json({ error: "MP4 अभी तैयार नहीं है।" });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", "inline");
  return res.sendFile(path.resolve(project.render.videoPath));
});

app.get("/api/projects/:id/scenes/:index/image", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  const asset = project.assets.scenes[Number(req.params.index)];
  if (!asset || !asset.image || !fs.existsSync(asset.image.path)) {
    return res.status(404).json({ error: "इस दृश्य की image अभी नहीं है।" });
  }
  res.setHeader("Content-Type", asset.image.mime || "image/png");
  return res.sendFile(path.resolve(asset.image.path));
});

app.get("/api/projects/:id/download", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  if (!project.render || !project.render.videoPath || !fs.existsSync(project.render.videoPath)) {
    return res.status(409).json({ error: "MP4 अभी तैयार नहीं है।" });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", 'attachment; filename="BABA-AI-' + project.id + '.mp4"');
  return res.sendFile(path.resolve(project.render.videoPath));
});

app.get("/api/projects/:id/captions", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  if (!project.timeline || !project.story) return res.status(409).json({ error: "captions अभी तैयार नहीं हैं।" });
  const cues = require("./lib/captions").buildSegments(
    require("./lib/captions").segmentsFromTimeline(project.timeline, project.story.scenes)
  );
  const srt = require("./lib/captions").buildSrt(cues);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="BABA-AI-' + project.id + '.srt"');
  return res.send(srt);
});

app.post("/api/projects/:id/cancel", (req, res) => {
  const owned = ownedProject(req, res);
  if (!owned) return;
  if (!runningProjects.has(req.params.id)) {
    return res.status(409).json({ error: "यह प्रोजेक्ट अभी नहीं चल रहा।" });
  }
  // The current step finishes, then the job stops before the next stage.
  const project = projectStore.get(req.params.id);
  if (project) {
    project.status = "cancelled";
    project.progress = { ...(project.progress || {}), stage: "cancelled", message: "उपयोगकर्ता ने रोका", updatedAt: new Date().toISOString() };
    projectStore.save(project);
  }
  return res.json({ success: true });
});


// ---- SEO package for a finished project (title, description, tags) ----
app.get("/api/projects/:id/seo", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  if (!project.seo) return res.status(404).json({ error: "अभी SEO तैयार नहीं है।" });
  return res.json({ seo: project.seo });
});

app.post("/api/projects/:id/seo", async (req, res) => {
  if (!readSecret("GEMINI_API_KEY")) {
    return res.status(503).json(blocked("GEMINI_API_KEY सेट नहीं है। SEO BLOCKED है।"));
  }
  const project = ownedProject(req, res);
  if (!project) return;
  if (!project.story) return res.status(409).json({ error: "पहले कहानी बनाएँ।" });
  try {
    const scenes = project.story.scenes.slice(0, 12).map(s => s.title + ": " + s.narration).join("\n");
    const prompt = [
      "You are a YouTube SEO expert for a Hindi kids' cartoon channel.",
      "Story title: " + project.story.title,
      "Language: " + (project.language === "English" ? "English" : "Hindi"),
      "Story beats:",
      scenes,
      "",
      "Return ONLY valid JSON (no markdown) with this exact schema:",
      '{"title":"string max 100 chars","description":"string max 5000 chars",' +
        '"tags":["string"],"hashtags":["#string"],"thumbnailText":"string max 40 chars"}',
      "Rules: no misleading claims, no fake engagement bait, no guaranteed results.",
    ].join("\n");
    const text = await geminiProviders().text.generate(prompt);
    const cleaned = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const seo = {
      title: String(parsed.title || project.story.title).slice(0, 100),
      description: String(parsed.description || "").slice(0, 5000),
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 30).map(t => String(t).slice(0, 60)) : [],
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 20).map(t => String(t).slice(0, 60)) : [],
      thumbnailText: String(parsed.thumbnailText || "").slice(0, 40),
      generatedAt: new Date().toISOString(),
    };
    project.seo = seo;
    projectStore.save(project);
    return res.json({ seo });
  } catch (error) {
    return sendAPIError(res, error, "SEO तैयार नहीं हुआ।");
  }
});

// ---- Thumbnail from the first scene ----
app.get("/api/projects/:id/thumbnail", (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  if (!project.thumbnail || !fs.existsSync(project.thumbnail.path)) {
    return res.status(404).json({ error: "अभी thumbnail तैयार नहीं है।" });
  }
  res.setHeader("Content-Type", "image/jpeg");
  return res.sendFile(path.resolve(project.thumbnail.path));
});

app.post("/api/projects/:id/thumbnail", async (req, res) => {
  const project = ownedProject(req, res);
  if (!project) return;
  // Scene assets are stored 0-based (pipeline writes assets.scenes[scene.index]),
  // so scene "1" in the UI is index 0. Reading [1] used to 409 here even though
  // the first scene's image existed, and skipped scene 1 entirely.
  const scenes = (project.assets && project.assets.scenes) || [];
  const asset = scenes[0] || scenes[1];
  if (!asset || !asset.image || !fs.existsSync(asset.image.path)) {
    return res.status(409).json({ error: "thumbnail के लिए पहले दृश्य 1 की image चाहिए।" });
  }
  const outPath = path.join(projectStore.dirFor(project.id), "thumbnail.jpg");
  const base = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720";
  const fontFile = require("./lib/fonts").resolveFontFile();
  const title = String((project.seo && project.seo.thumbnailText) || (project.story && project.story.title) || "")
    .replace(/[:'"\\\n\r{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  let mode = "image-only";
  let filter = base;
  if (fontFile && fs.existsSync(fontFile) && title) {
    filter = base + ",drawtext=fontfile='" + fontFile + "':text='" + title +
      "':fontcolor=white:fontsize=64:borderw=5:bordercolor=black:x=(w-text_w)/2:y=h-text_h-70";
    mode = "image+title";
  }
  try {
    await ffmpegTools.runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y", "-i", asset.image.path,
      "-vf", filter, "-frames:v", "1", "-q:v", "3", outPath,
    ]);
    project.thumbnail = { path: outPath, mode, fontFile: Boolean(fontFile) };
    projectStore.save(project);
    return res.json({ thumbnail: project.thumbnail });
  } catch (error) {
    // A missing font must not lose the thumbnail: fall back to the plain frame.
    try {
      await ffmpegTools.runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-y", "-i", asset.image.path,
        "-vf", base, "-frames:v", "1", "-q:v", "3", outPath,
      ]);
      project.thumbnail = { path: outPath, mode: "image-only", fontFile: false };
      projectStore.save(project);
      return res.json({ thumbnail: project.thumbnail, warning: "Font उपलब्ध नहीं था; title text छोड़ा गया।" });
    } catch (fallbackError) {
      return sendAPIError(res, fallbackError, "Thumbnail नहीं बनी।");
    }
  }
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
    const ffmpegBin = ffmpegTools.resolveFfmpegPath();
    const ffmpegVer = ffmpegTools.ffmpegVersionSync();
    console.log("BABA AI Server running on port " + PORT);
    // Never a secret: just which binary renders, and whether it runs at all.
    console.log("FFmpeg: " + (ffmpegVer ? ffmpegVer + " (" + ffmpegBin + ")" : "NOT AVAILABLE (" + ffmpegBin + ")"));
    if (!readSecret("GEMINI_API_KEY")) console.log("GEMINI_API_KEY: not set - generation is blocked");
  });
}

// Restart recovery runs once per process: jobs that were mid-flight when the
// previous process died are requeued, and the worker resumes them from the
// assets already saved on disk.
const bootRecovery = jobQueue.recoverOnBoot();
if (bootRecovery.requeued.length || bootRecovery.failed.length) {
  console.log("Restart recovery: " + bootRecovery.requeued.length + " job(s) requeued, " +
    bootRecovery.failed.length + " failed");
}

module.exports = { app, getStatus, normalizeYoutubeTags, validateScheduleAt, buildVideoStatus, validateAnalyticsRange, shapeAnalyticsReport, isNetworkError, networkErrorDetail, isQuotaError, extractRetryHint, quotaInfo, withTemporaryRetries, generateTextWithQuotaFallback, getPcmDurationSeconds, setAIClientFactoryForTests, resetAIClientFactory };
