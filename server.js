require("dotenv").config();
const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static("dist"));

function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("GEMINI_API_KEY सेट नहीं है।");
    err.code = "NO_API_KEY";
    throw err;
  }
  return new GoogleGenAI({ apiKey });
}

app.get("/api/health", (req, res) => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  res.json({
    status: "ok",
    geminiKeyConfigured: hasKey,
    message: hasKey
      ? "सर्वर चल रहा है और Gemini API Key कॉन्फ़िगर है।"
      : "सर्वर चल रहहा है लेकिन Gemini API Key कॉन्फ़िगर नहीं है। .env फ़ाइल में GEMINI_API_KEY सेट करें।",
  });
});

app.post("/api/script", async (req, res) => {
  try {
    const { topic, duration, language } = req.body;

    if (!topic || !topic.trim()) {
      return res.status(400).json({
        error: "कृपया वीडियो का विषय लिखें।",
      });
    }

    const ai = getAIClient();

    const prompt = `आप एक अनुभवी ${language || "हिंदी"} YouTube स्क्रिप्ट लेखक हैं।

विषय: ${topic}
भाषा: ${language || "हिंदी"}
वीडियो अवधि: ${duration || 30} मिनट

निर्देश:
1. एक बहुत ही आकर्षक शुरुआत लिखें जो दर्शकों को पहले 30 सेकंड में ही बांध दे।
2. वीडियो की विस्तृत रूपरेखा दें — कम से कम 6 अध्याय बनाएँ।
3. हर अध्याय के लिए:
   - अध्याय का शीर्षक
   - नैरेशन (नैचुरल बोलचाल की भाषा में)
   - दृश्य निर्देश (कैमरा क्या दिखाएगा — [दृश्य: ...] के रूप में)
   - ट्रांज़िशन (अगले दृश्य पर जाने का तरीका)
4. पूरी स्क्रिप्ट प्राकृतिक बोलचाल की भाषा में लिखें।
5. तथ्यों को लेकर कोई झूठा दावा न करें।
6. जरूरत पड़ने पर तथ्य-जाँच के संकेत दें।
7. अंत में रोचक निष्कर्ष और दर्शकों से लाइक व सब्स्क्राइब करने का अनुरोध दें।
8. ${duration || 30} मिनट के लिए उपयुक्त मात्रा में सामग्री दें।`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
    });

    const scriptText = response.text;

    if (!scriptText || !scriptText.trim()) {
      return res.status(500).json({
        error: "AI ने खाली उत्तर दिया। कृपया पुनः प्रयास करें।",
      });
    }

    res.json({ script: scriptText });
  } catch (error) {
    console.error("AI Script Error:", error);

    if (error.code === "NO_API_KEY") {
      return res.status(500).json({
        error:
          "GEMINI_API_KEY सेट नहीं है। कृपया .env फ़ाइल में अपनी API Key सेट करें।",
      });
    }

    res.status(500).json({
      error: "स्क्रिप्ट नहीं बन सकी। API Key, मॉडल और सर्वर सेटअप जाँचें।",
    });
  }
});

app.post("/api/seo", async (req, res) => {
  try {
    const { topic, language } = req.body;

    if (!topic || !topic.trim()) {
      return res.status(400).json({
        error: "कृपया वीडियो का विषय लिखें।",
      });
    }

    const ai = getAIClient();

    const prompt = `आप एक विशेषज्ञ YouTube SEO विशेषज्ञ हैं।

विषय: ${topic}
भाषा: ${language || "हिंदी"}

निम्नलिखित जानकारी तैयार करें:

1. वीडियो शीर्षक (3 विकल्प — आकर्षक और SEO-अनुकूल, 60 अक्षरों के भीतर)
2. वीडियो विवरण (एक विस्तृत विवरण — कम से कम 200 शब्द, जिसमें वीडियो का सार, महत्वपूर्ण बिंदु, और संबंधित लिंक के लिए जगह शामिल हो)
3. कीवर्ड्स (15-20 प्रासंगिक कीवर्ड्स, कॉमा से अलग)
4. हैशटैग्स (10-15 प्रासंगिक हैशटैग्स)
5. थंबनेल टेक्स्ट सुझाव (3 विकल्प — बड़े और आकर्षक टेक्स्ट जो थंबनेल पर अच्छे दिखें)
6. टैग्स (YouTube टैग्स के रूप में, कॉमा से अलग)

सब कुछ ${language || "हिंदी"} में लिखें (कीवर्ड्स और हैशटैग्स अंग्रेजी में भी हो सकते हैं)।`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
    });

    const seoText = response.text;

    if (!seoText || !seoText.trim()) {
      return res.status(500).json({
        error: "AI ने खाली उत्तर दिया। कृपया पुनः प्रयास करें।",
      });
    }

    res.json({ seo: seoText });
  } catch (error) {
    console.error("AI SEO Error:", error);

    if (error.code === "NO_API_KEY") {
      return res.status(500).json({
        error:
          "GEMINI_API_KEY सेट नहीं है। कृपया .env फ़ाइल में अपनी API Key सेट करें।",
      });
    }

    res.status(500).json({
      error: "SEO जानकारी नहीं बन सकी। API Key और सर्वर सेटअप जाँचें।",
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("BABA AI Server running on port " + PORT);
});
