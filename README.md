# BABA AI — YouTube Agent

Hindi-first web app for Gemini script/SEO generation, scene images and Hindi TTS, plus real Google OAuth channel connection and YouTube video upload.

## Current implemented features

- Gemini script and SEO endpoints.
- Scene image generation (up to 3 images per request; Gemini quota/billing may apply), with Wikimedia Commons fallback on Gemini quota errors when suitable images are found and attribution details returned.
- Hindi TTS endpoint (provider quota/billing may apply).
- Google OAuth 2.0 connect/status/disconnect.
- YouTube Data API v3 resumable upload for an already-rendered MP4/MOV/WebM, up to 90 MB per request. Upload defaults to **Private**; user must explicitly choose another privacy level.
- Frontend form for video file, title, description and privacy.

## 3D cartoon mode

- The frontend defaults to **3D cartoon comedy** and also offers cinematic and realistic visual styles.
- The selected style is passed to script generation and scene-image prompts. 3D prompts request consistent Indian cartoon characters, recurring outfits/hairstyles, expressive faces, and vertical 9:16 composition.
- The current MP4 pipeline still combines scene stills and Hindi narration into a short narrated video/slideshow. It is **not** a full 3D character-animation or lip-sync engine. Character motion and dialogue-to-mouth synchronization are not guaranteed.
- 3D image generation depends on the configured Gemini image model and its available quota/billing. In 3D-cartoon mode the app will not silently replace unavailable cartoon art with real Wikimedia photos; it will report the quota problem instead.

## Important limits (not falsely advertised as complete)

The repository includes an end-to-end narrated slideshow MP4 renderer using FFmpeg, with up to 3 scene images and Hindi TTS. The hosted renderer is currently limited to 180 seconds (3 minutes) per MP4, and the automatic flow makes a short excerpt from longer scripts. It is not a full 5–30 minute movie renderer. The app also includes a browser Canvas thumbnail, checkpoint/export tools, Commons image fallback on Gemini image quota errors, and real YouTube upload for a rendered video. This feature branch adds a durable per-job queue and encrypted per-job OAuth session, but it is not a hardened multi-tenant token service and does not include an automatic daily scheduler. The OAuth session is encrypted in a browser cookie; clearing browser cookies or losing the session requires reconnecting. Render's request-size/time limits can also affect large uploads. Do not upload files containing private or copyrighted material unless you have rights.

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


## Durable automation foundation (feature branch)

The `feature/baba-ai-durable-automation` branch adds a PostgreSQL-backed persistence module for job metadata, per-step attempt counters, step results/errors, event history and provider quota cooldowns. It requires `DATABASE_URL`; the database schema is initialized lazily when the automation status/jobs API is first used. The app continues to start without this optional database, and the existing YouTube OAuth endpoints/cookie token handling are not changed by this feature.

**This is not yet the completed automation worker.** The new API can create durable job drafts and show persisted history, but it does not yet execute the entire pipeline in a server-side worker. Existing `/api/render` status and output still depend on process memory and temporary files. Persistent object storage, safe upload-resume/idempotency at the YouTube boundary, durable worker scheduling/recovery, captions integration, and a complete mobile control dashboard remain unfinished. Do not deploy this branch as a claim of end-to-end durable automation.

### PostgreSQL setup (only after review)

Add `DATABASE_URL` to the intended Render service's Environment, using a managed PostgreSQL database. Keep the connection string secret. `DATABASE_SSL` defaults to SSL enabled; use `disable` only for a trusted local database. `AUTOMATION_DB_POOL_MAX` defaults to 3. This branch does not create a database or alter Render settings.


## Phase 2 durable worker (feature branch; integration testing required)

The feature branch now contains a PostgreSQL queue worker, per-step state/event persistence, restart recovery, Supabase Storage REST adapter, a Hindi mobile job dashboard, and explicit private-upload authorization. The worker only starts when both `DATABASE_URL` and the Supabase Storage credentials are configured. It stores generated assets under `jobs/{job-id}/...` and creates short-lived signed preview URLs.

### Required environment on the intended Render service

- `DATABASE_URL`: PostgreSQL connection string. Keep it in Render Environment, never GitHub.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: **secret** server-side service role key; never expose it in the browser or logs.
- `SUPABASE_STORAGE_BUCKET`: private bucket name; defaults to `baba-ai-assets`.
- Existing `GEMINI_API_KEY`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`, and `APP_SESSION_SECRET` remain required for their respective features. OAuth redirect URI must not be changed for this branch.
- Optional `AUTOMATION_POLL_MS` (default 2500) and `AUTOMATION_INTERNAL_BASE_URL` (default localhost + Render PORT).

On first API use, PostgreSQL tables are created/migrated automatically. Create the private Supabase Storage bucket in the Supabase dashboard before enabling the worker. Database job metadata includes an encrypted OAuth session for that specific job; it is encrypted with the existing `APP_SESSION_SECRET` and the API does not return the ciphertext.

### Mobile job flow

1. Connect the existing YouTube channel.
2. In the Durable Automation card, enter a topic or leave it blank for AI topic selection, then tap Start Job.
3. Watch Job History and per-step attempt/error details. Pause/Resume and Retry Failed Step act on the stored job.
4. After preview is ready, inspect it and tap **Upload Private** to explicitly authorize the upload. Public upload is not enabled in this worker.
5. Check the YouTube video ID/result in Job History.

### Known limits

- The hosted renderer still creates a narrated still-image MP4 preview (maximum 180 seconds); it is **not** real 3D character animation and does not provide dialogue lip-sync. No Blender/Godot/Unreal or lip-sync engine has been integrated in this branch. Genuine 3D animation needs a separately provisioned renderer and character/rig/viseme assets, which this Render service does not currently provide.
- Captions are generated as an approximate-timing SRT sidecar; they are not burned into the MP4 and are not uploaded to YouTube as a caption track.
- The thumbnail step uses the first generated scene image as a thumbnail candidate; it does not yet create a text-composited thumbnail design.
- The automatic narration is capped at a short excerpt because the hosted renderer is limited to 180 seconds. Full 5–30 minute film production is not implemented.
- Upload progress is persisted at chunk boundaries. If a saved YouTube resumable session expires, the worker refuses to silently start a new session to avoid an accidental duplicate. Check YouTube Studio before deciding how to recover that job.
- A successful code build/test does not prove real Google/Gemini/PostgreSQL/Supabase end-to-end operation. Those integrations must be tested with the user's configured services before calling the system production-ready.
