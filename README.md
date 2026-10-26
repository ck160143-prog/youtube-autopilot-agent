# BABA AI — YouTube Agent

Hindi-first web app for Gemini script/SEO generation, scene images and Hindi TTS, plus real Google OAuth channel connection and YouTube video upload.

## Current implemented features

- Gemini script and SEO endpoints.
- Scene image generation (up to 3 images per request; Gemini quota/billing may apply).
- Hindi TTS endpoint (provider quota/billing may apply).
- Google OAuth 2.0 connect/status/disconnect.
- YouTube Data API v3 resumable upload for an already-rendered MP4/MOV/WebM, up to 90 MB per request. Upload defaults to **Private**; user must explicitly choose another privacy level.
- Frontend form for video file, title, description and privacy.

## Important limits (not falsely advertised as complete)

This repository does **not** yet include an end-to-end video renderer/FFmpeg pipeline, durable multi-user token database, persistent upload queue, or automatic daily scheduler. Generate/download voice and scene assets, render a final video using your editor/FFmpeg, then upload the rendered file from the app. The OAuth session is encrypted in a browser cookie; clearing browser cookies or losing the session requires reconnecting. Render's request-size/time limits can also affect large uploads. Do not upload files containing private or copyrighted material unless you have rights.

## Run locally

Requirements: Node.js 18+.

```bash
npm install
cp .env.example .env
# Edit .env and set GEMINI_API_KEY plus YouTube OAuth values (if uploading)
npm run build
npm start
```

Open http://localhost:3000.

## Configure real YouTube OAuth

1. Open Google Cloud Console and create/select a project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. Add your Google account as a test user while the app is in Testing.
4. Create **OAuth Client ID → Web application**.
5. Add the exact authorized redirect URI:
   - Local: `http://localhost:3000/api/youtube/callback`
   - Render: `https://YOUR-RENDER-SERVICE.onrender.com/api/youtube/callback`
6. Add these to the Render service's **Environment** settings (not GitHub files):
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `YOUTUBE_REDIRECT_URI` (must exactly match the Google URI)
   - `APP_SESSION_SECRET` (random string, at least 32 characters)
   - `GEMINI_API_KEY` (for Gemini features)
7. Save/redeploy Render. Visit your app, tap **YouTube चैनल Connect करें**, approve the Google permissions, then check status.
8. In the app's video section, select a final rendered video, enter title/description, leave privacy **Private** for a test, and upload. Verify it in YouTube Studio before making it public.

Never paste OAuth secrets, Gemini keys, access tokens, or refresh tokens into GitHub, chat, or frontend code. Rotate any key that was accidentally exposed.

## Environment variables

See `.env.example`. No real credentials belong in that file.

## Deployment

Render should run the Node server with `npm start`. The static frontend is served from `dist` (build with `npm run build`). For production uploads, consider a persistent/object-storage based job pipeline and chunked transfer; this current hosted upload endpoint has a 90 MB body limit.

## Security notes

- OAuth state is checked on callback.
- OAuth token session data is encrypted with AES-256-GCM using `APP_SESSION_SECRET`, stored in an HttpOnly, SameSite=Lax cookie (Secure in production).
- YouTube upload uses the authenticated user's OAuth token and requests confirmation through the app form; default visibility is private.
- This is a personal/single-browser implementation, not a hardened public multi-tenant service. Restrict access to your deployment; do not share the connected app URL as an open upload service.


## Gemini image quota recovery

- Image generation stops immediately on HTTP 429 / `RESOURCE_EXHAUSTED`; it does not try another image model after a quota response.
- The API returns a provider retry/reset hint when Google includes one. If Google does not provide a reset time, the app says so instead of inventing one.
- Successful scene images remain available in the current browser tab if a later scene fails. The UI offers a retry action for failed scene prompts only; a retry can still fail until the provider quota resets.
- MP4 generation can continue using successful images already present in the tab. If no generated image is available, the browser creates clearly labeled script-text PNG slides and combines those with narration; these are not represented as AI-generated artwork.
- For local image generation, users can run a compatible local Stable Diffusion / ComfyUI setup on their own computer and download/import the resulting PNG/JPEG images. The hosted Render service does not silently claim to run a local model or provide unlimited image generation.
- Workflow checkpoints preserve topic, script, SEO, and stage status in the same browser. Download scene images, voice audio, and MP4 files separately for durable backups; browser storage is not a permanent asset store.

## Tests

Run `npm test` (Node.js 18+). Tests cover quota classification, retry hints, no retries on 429, and bounded retries for temporary 5xx errors.
