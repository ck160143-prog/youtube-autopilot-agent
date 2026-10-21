
require("dotenv").config();

const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static("dist"));

function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY सेट नहीं है।");
    error.code = "NO_API_KEY";
    throw error;
  }

  return new GoogleGenAI({ apiKey });
}

function sendAPIError(res, error, fallbackMessage) {
  console.error(fallbackMessage, error);

  if (error.code === "NO_API_KEY") {
    return res.status(500).json({
      error: "Render Environment में GEMINI_API_KEY सेट करें।",
    });
  }

  return res.status(500).json({
    error: fallbackMessage,
  });
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

    const ai = getAIClient();

    const response = await ai.models.generateContent({
      model:
        process.env.GEMINI_TTS_MODEL ||
        "gemini-2.5-flash-preview-tts",
      contents: [
        {
          parts: [
            {
              text:
                "नैचुरल और स्पष्ट हिंदी में यह टेक्स्ट बोलें: " +
                text,
            },
          ],
        },
      ],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Kore",
            },
          },
        },
      },
    });

    const parts =
      response.candidates?.[0]?.content?.parts || [];

    const audioPart = parts.find(
      (part) => part.inlineData?.data
    );

    if (!audioPart) {
      console.error(
        "TTS response did not contain audio data."
      );

      return res.status(502).json({
        error: "Gemini से ऑडियो नहीं मिला। Render Logs जाँचें।",
      });
    }

    return res.json({
      success: true,
      mimeType: audioPart.inlineData.mimeType || "audio/L16",
      audioBase64: audioPart.inlineData.data,
    });
  } catch (error) {
    return sendAPIError(
      res,
      error,
      "आवाज़ नहीं बन सकी। Render Logs में AI Voice Error देखें।"
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
  try {
    const script = req.body?.script;
    if (typeof script !== "string" || !script.trim()) {
      return res.status(400).json({ error: "पहले AI Script Studio में स्क्रिप्ट तैयार करें।" });
    }
    if (script.length > 30000) {
      return res.status(413).json({ error: "स्क्रिप्ट बहुत लंबी है। पहले छोटा भाग चुनें (30,000 अक्षरों तक)।" });
    }

    const ai = getAIClient();
    const planResponse = await ai.models.generateContent({
      model: process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash",
      contents: `इस वीडियो स्क्रिप्ट से 3 मुख्य दृश्य चुनें और हर दृश्य के लिए एक विस्तृत image prompt लिखें।
सभी दृश्य एक ही visual style में हों: cinematic, polished, YouTube-friendly, 16:9 landscape, कोई लिखावट/टेक्स्ट/वॉटरमार्क नहीं।
स्क्रिप्ट:
${script.slice(0, 18000)}

केवल वैध JSON लौटाएँ, इस schema में:
{"scenes":[{"title":"दृश्य का छोटा शीर्षक","prompt":"English image prompt"}]}
3 से अधिक दृश्य न दें।`,
      config: { responseMimeType: "application/json" }
    });

    let planText = planResponse.text || "";
    planText = planText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let plan;
    try { plan = JSON.parse(planText); }
    catch (_) { return res.status(502).json({ error: "AI से दृश्य योजना सही JSON में नहीं मिली। दोबारा प्रयास करें।" }); }

    const scenes = Array.isArray(plan.scenes) ? plan.scenes.slice(0, 3) : [];
    if (!scenes.length) return res.status(502).json({ error: "स्क्रिप्ट से कोई दृश्य नहीं निकला।" });

    const images = [];
    const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (!scene || typeof scene.prompt !== "string" || !scene.prompt.trim()) continue;

      const imageResponse = await ai.models.generateContent({
        model: imageModel,
        contents: scene.prompt,
        config: { responseModalities: ["IMAGE"] }
      });
      const parts = imageResponse.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(part => part.inlineData?.data && (part.inlineData.mimeType || "").startsWith("image/"));
      if (!imagePart) {
        console.error("Gemini image response missing image payload for scene", i + 1);
        return res.status(502).json({ error: `दृश्य ${i + 1} की तस्वीर नहीं मिली। Render Logs और Gemini मॉडल/क्वोटा जाँचें।` });
      }
      images.push({
        title: String(scene.title || `दृश्य ${i + 1}`).slice(0, 120),
        mimeType: imagePart.inlineData.mimeType || "image/png",
        imageBase64: imagePart.inlineData.data
      });
    }

    if (!images.length) return res.status(502).json({ error: "कोई तस्वीर जनरेट नहीं हुई।" });
    return res.json({ success: true, images, model: imageModel });
  } catch (error) {
    console.error("Gemini scene image generation failed:", error);
    const message = String(error?.message || "");
    if (error.code === "NO_API_KEY") {
      return res.status(500).json({ error: "Render Environment में GEMINI_API_KEY सेट करें।" });
    }
    if (/quota|billing|payment|rate.?limit/i.test(message)) {
      return res.status(429).json({ error: "Gemini API की quota/billing सीमा आई है। AI Studio में usage और billing जाँचें।" });
    }
    return res.status(502).json({ error: "तस्वीरें नहीं बन सकीं। Render Logs में Gemini Image Error देखें; मॉडल उपलब्धता/क्वोटा जाँचें।" });
  }
});

// 6. सर्वर शुरू करना

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("BABA AI Server running on port " + PORT);
});
