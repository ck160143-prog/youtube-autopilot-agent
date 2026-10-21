# BABA AI — YouTube Automation Agent

BABA AI एक AI-संचालित YouTube स्क्रिप्ट और SEO जनरेटर है। यह Gemini AI का उपयोग करके
वीडियो स्क्रिप्ट, YouTube SEO (शीर्षक, विवरण, कीवर्ड्स, हैशटैग्स, थंबनेल टेक्स्ट) तैयार करता है।

BABA AI is an AI-powered YouTube script and SEO generator. It uses Google's Gemini AI
to produce video scripts and YouTube SEO content (titles, descriptions, keywords,
hashtags, thumbnail text) in Hindi or English.

## Features

- **AI Script Generation** — Generate full YouTube video scripts with chapters,
  narration, visual directions, and transitions.
- **YouTube SEO** — AI-generated titles, descriptions, keywords, hashtags, and
  thumbnail text suggestions.
- **Multi-language** — Supports Hindi and English output.
- **Project Save** — Save and restore your work in the browser via localStorage.
- **Script & SEO Export** — Copy or download scripts and SEO as text files.

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JavaScript (single-page app)
- **Backend:** Node.js + Express
- **AI:** Google Gemini (`@google/genai`)

## Prerequisites

- Node.js 18 or higher
- A Google Gemini API key — get one free at
  https://aistudio.google.com/apikey

## Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/<your-username>/youtube-autopilot-agent.git
   cd youtube-autopilot-agent
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure your API key**

   Copy the example env file and add your real key:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` and set:

   ```
   GEMINI_API_KEY=your_real_gemini_api_key_here
   ```

4. **Build the frontend**

   ```bash
   npm run build
   ```

5. **Start the server**

   ```bash
   npm start
   ```

   The app runs at `http://localhost:3000`.

## Environment Variables

| Variable            | Required | Description                          |
|---------------------|----------|--------------------------------------|
| `GEMINI_API_KEY`    | Yes      | Google Gemini API key for AI features|
| `PORT`              | No       | Server port (default: 3000)          |
| `GEMINI_IMAGE_MODEL` | No       | Image model (default: `gemini-3.1-flash-image`); verify project access/quota in AI Studio |

See [`.env.example`](.env.example) for optional future integrations
(YouTube upload, TTS, image generation).

## Deployment (Netlify)

This project includes a `netlify.toml` for deployment. The build command is
`node build.js` and the publish directory is `dist`.

> **Note:** The AI endpoints (`/api/script`, `/api/seo`) require a Node.js
> server. On Netlify, use Netlify Functions or deploy the Express server
> separately. The static frontend works on any static host, but AI features
> need the server running.

## Project Structure

```
├── index.html        # Frontend single-page app
├── server.js         # Express server with Gemini AI endpoints
├── build.js          # Build script (copies index.html to dist/)
├── package.json      # Dependencies and scripts
├── netlify.toml      # Netlify deployment config
├── .env.example      # Example environment variables (safe to commit)
└── .gitignore        # Ignores .env, node_modules, dist, etc.
```

## Security

- **Never commit `.env`** — it contains your API keys. The `.gitignore`
  excludes it automatically.
- Only `.env.example` (with placeholder values) is included in the repository.
- API keys are used server-side only; the frontend never sees them.

## License

This project is for personal/educational use.
