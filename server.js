require("dotenv").config();

const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static("dist"));

const MODEL_NAME = "gemini-3.8-flash";

// Gemini API Client
function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY सेट नहीं है।");
    error.code = "NO_API_KEY";
    throw error;
  }

  return new GoogleGenAI({ apiKey });
}

// Gemini API पर दोबारा कोशिश करने वाला फ़ंक्शन
async function generateAIText(ai, prompt) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
      });

      const result = response.text;

      if (!result || !result.trim()) {
        throw new Error("AI ने खाली उत्तर दिया।");
      }

      return result;
    } catch (error) {
      const message = String(
        error.message || error
      );

      const status =
        error.status ||
        error.code ||
        error.error?.code;

      const temporaryError =
        Number(status) === 503 ||
        Number(status) === 429 ||
        /high demand|temporarily unavailable|service unavailable|resource exhausted/i.test(
          message
        );

      console.error(
        `Gemini Attempt ${attempt}/${maxAttempts} failed:`,
        message
      );

      // स्थायी त्रुटि होने पर बार-बार कोशिश न करें।
      if (!temporaryError) {
        throw error;
      }

      // आखिरी कोशिश भी असफल हो गई।
      if (attempt === maxAttempts) {
        throw error;
      }

      // 2 सेकंड, फिर 4 सेकंड प्रतीक्षा करें।
      const waitTime = 2000 * Math.pow(2, attempt - 1);

      console.log(
        `Gemini busy. Retrying after ${waitTime / 1000} seconds...`
      );

      await new Promise((resolve) =>
        setTimeout(resolve, waitTime)
      );
    }
  }

  throw new Error("Gemini से उत्तर नहीं मिला।");
}

// सामान्य Error Response
function sendError(res, error, feature) {
  console.error(`${feature} Error:`, error);

  if (error.code === "NO_API_KEY") {
    return res.status(500).json({
      error:
        "GEMINI_API_KEY सेट नहीं है। Render के Environment में API Key जाँचें।",
    });
  }

