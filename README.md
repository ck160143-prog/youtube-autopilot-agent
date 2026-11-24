# BABA AI — YouTube Automation Agent

Hindi-first, free-first YouTube automation: a topic becomes a structured story, a
consistent cast, per-scene images and Hindi voice, and a real FFmpeg MP4 — with
captions, music and transition sound effects.

The pipeline is **provider-injected**: the same code runs against real Gemini or
against a deterministic fake in tests. Nothing reports success unless a file was
actually produced.

---

## What actually works

| Feature | Status | Notes |
| --- | --- | --- |
| Topic → structured Hindi story | ✅ real | Needs `GEMINI_API_KEY` |
| Scene planning 10 / 20 / 50 / … 150 | ✅ real | 1 min → 10 scenes, 2 → 20, 5 → 50, 30 → 150 |
| Character library (face, outfit, colours, voice) | ✅ real | Persisted in `data/characters.json` |
| Character consistency in every prompt | ✅ real | Character bible repeated in each image prompt |
| Scene images | ✅ real | Needs `GEMINI_API_KEY`; magic-byte validated |
| Per-character Hindi voice | ✅ real | Needs `GEMINI_API_KEY`; male/female presets |
| Camera motion (Ken Burns / pan) | ✅ real | Per scene, via FFmpeg `zoompan` |
| Fade transitions | ✅ real | Dip-to-black per scene |
| Hindi captions | ✅ real | SRT + ASS burn-in, soft-subtitle fallback |
| Background music | ✅ real | Synthesised by FFmpeg — no third-party track |
| Sound effects | ✅ real | One whoosh per scene boundary, synthesised |
| Music ducking under narration | ✅ real | `sidechaincompress` |
| 16:9, 9:16, 1:1 | ✅ real | 720p default, 1080p optional |
| 1–30 minute videos | ✅ real | Chunked render, resume, bounded memory |
| Resume / retry a single scene | ✅ real | Completed clips are reused, not re-encoded |
| SEO package (title, description, tags) | ✅ real | Needs `GEMINI_API_KEY` |
| Thumbnail | ✅ real | Frame from scene 1; title text needs `CAPTION_FONT_FILE` |
| YouTube upload (private/unlisted/public) | ✅ real | Needs OAuth; Hindi metadata supported |
| Multi-user accounts (owner/member) | ✅ real | scrypt hashes, server-side sessions in `data/` |
| Project + character ownership | ✅ real | Another user gets 403, never a leak |
| CSRF protection | ✅ real | Per-session token or same-origin proof on every write |
| Rate limiting | ✅ real | Per-group windows (AI 20, render 10, upload 5, auth 10, general 120) |
| Persistent job queue | ✅ real | `data/jobs/`, survives restart, resumes interrupted work |
| Restart recovery | ✅ real | Mid-flight project → `interrupted`; job re-queued and resumed |
| Bundled Devanagari font | ✅ real | `fonts/NotoSansDevanagari-Regular.ttf` (OFL), no system font needed |
| Setup audit + fix guide | ✅ real | `/api/setup`, `/api/setup/verify`, in-dashboard steps; no secret ever returned |
| Animation-ready characters (rig) | ✅ real | Upload mouth sprites A–H/X; validated by magic bytes, stored on disk |
| Lip-sync analysis (Rhubarb) | ✅ real | MIT engine, CPU-only; audio → mouth-cue timeline |
| 2D mouth animation on rigged characters | ✅ experimental | Sprites swapped on real cues; only when a rig + engine exist |
| YouTube upload preflight | ✅ real | Validates OAuth/file/metadata, never uploads |
| Android / small-screen dashboard | ✅ real | Sticky shortcuts, 46 px targets, 16 px inputs, safe-area |
| **Full-body 3D character animation** | ⛔ **not implemented** | Needs a motion provider/GPU model; the dashboard says so |

The MP4 is a **narrated slideshow with camera motion**, not 3D character
animation. Walking, running, expressions and lip-sync are not implemented; the
dashboard reports them as `BLOCKED` instead of implying they exist.

---

## Quick start

Requirements: Node.js 20+, a real FFmpeg binary.

```bash
npm ci                 # lockfile is authoritative
cp .env.example .env   # fill in GEMINI_API_KEY (and YouTube OAuth if uploading)
npm run build          # copies index.html into dist/
npm start              # http://localhost:3000
```

If `ffmpeg-static` could not download its binary (restricted network), point the
app at any FFmpeg:

```bash
FFMPEG_PATH=/usr/bin/ffmpeg npm start
```

A Noto Sans Devanagari font ships in `fonts/` (SIL OFL 1.1), so burned Hindi
captions and thumbnails render on hosts with no system fonts — including slim
containers. `CAPTION_FONT_FILE` still overrides it if you want another font.

### Setup guide (key न होने पर)

डैशबोर्ड खुलते ही **Setup जाँच** कार्ड दिखता है: क्या configure है, क्या गायब है, और
हर गायब चीज़ के exact steps। **Verify setup** असली जाँच चलाता है — FFmpeg, font, data
directory, और अगर key है तो एक free `models.list` call से key accept होती है या नहीं।
Key न होने पर कोई नकली success नहीं: हर AI route `503 {blocked: true, setup: {steps}}`
देता है।

```bash
curl -s -b cookies.txt -H "x-csrf-token: $TOKEN" -X POST http://localhost:3000/api/setup/verify
```

`GET /api/setup/guide/<CHECK_ID>` सिर्फ एक check के steps देता है।

### Lip-sync (optional, CPU-only)

```bash
npm install rhubarb-lip-sync-wasm     # MIT, ~41 MB, WASM build
# या native binary (ज़्यादा तेज़):
RHUBARB_PATH=/usr/local/bin/rhubarb
```

फिर किरदार के **mouth sprites** अपलोड करें (dashboard में 🎭 Animation rig, या
`POST /api/characters/:id/rig`)। जिन scenes में वही किरदार बोलता है, render के समय
उसका मुँह असली cue timeline पर swap होता है। Sprites या engine न हों तो कुछ भी
animate नहीं होता — slideshow ईमानदारी से slideshow रहती है।

⚠️ **Hindi पर accuracy verify नहीं हुई.** Rhubarb का phoneme recognizer English
model पर चलता है; इस sandbox में कोई real Hindi speech sample नहीं था। Engine काम
करता है (audio → cues), पर Hindi मुँह-आकृतियों की सटीकता को अभी experimental ही
समझना चाहिए।

### Accounts (multi-user)

The dashboard opens with a sign-in gate. The **first** account becomes the
owner and adopts every project/character created before authentication existed.
After that, a new account needs the registration key:

```bash
APP_REGISTRATION_KEY="team-secret" npm start
```

- Passwords: scrypt (`N=16384, r=8, p=1`), never stored or logged in plain text.
- Sessions: server-side in `data/sessions.json`, 7-day TTL, revocable, cookie is
  `HttpOnly; SameSite=Lax` (`Secure` when `NODE_ENV=production`).
- Every write needs the session's CSRF token (`x-csrf-token`) or a same-origin
  `Origin`/`Sec-Fetch-Site` proof.
- Every project and character is owned; another account gets `403` (or `404`
  where existence would leak).
- `/api/health` and `/api/auth/status` stay public.

`APP_ACCESS_KEY` still works as an *additional* gate for personal deployments
(every `/api/*` call needs `x-access-key` or the `baba_access_key` cookie).

---

## How a video is made

```
topic + duration + style + aspect
  → story (N scenes: narration, dialogue, image prompt)
  → per scene: image (Gemini) + voice (Gemini, per-character voice)
  → timeline (real audio durations, scaled to the requested runtime)
  → per scene clip (Ken Burns, fade, AAC audio, silence-padded narration)
  → chunk concat → music bed + SFX (sidechain ducked)
  → ASS caption burn-in (fallback: soft subtitle track)
  → MP4 + SRT
```

Projects are stored in `data/projects/<id>.json` plus an asset directory. A
crash or a cancelled run resumes from the last completed clip.

### Duration and scene count

| Requested | Scenes | Timeline |
| --- | --- | --- |
| 1 min | 10 | 60 s |
| 2 min | 20 | 120 s |
| 5 min | 50 | 300 s |
| 10 min | 75 | 600 s |
| 30 min | 150 | 1800 s |

Scene durations come from the measured narration audio; when audio is missing
the engine falls back to a word-count estimate (≈130 words/min for Hindi). Each
scene is clamped to 2.5–22 s so no frame lingers.

### Rendering limits

- `720p` default (`1280×720`, `720×1280`, `720×720`); `1080p` optional.
- `FFMPEG_PRESET` (`ultrafast` … `veryslow`) trades size for speed.
- One render at a time per process; clips and chunks are reused on retry.
- Rendered files live under `data/projects/<id>/render/`.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness (public) |
| GET | `/api/auth/status` | Session + registration state (public) |
| POST | `/api/auth/register` | First account = owner; later ones need the key |
| POST | `/api/auth/login` | Session cookie + CSRF token |
| POST | `/api/auth/logout` | Revoke the session |
| GET | `/api/auth/me` | Current user + CSRF token |
| GET | `/api/setup` | Configuration audit + fix guide (no secrets) |
| POST | `/api/setup/verify` | Real checks; **one** free `models.list` call verifies the key *and* every configured model ID |
| GET | `/api/setup/guide/:checkId` | Steps for one missing piece |
| GET | `/api/capabilities` | Honest feature matrix + blocked reasons |
| GET/POST | `/api/characters` | Character library |
| DELETE | `/api/characters/:id` | Remove a character |
| GET | `/api/characters/:id` | Character + animation readiness |
| POST | `/api/characters/:id/rig` | Upload mouth/expression sprites (base64 PNG/JPEG) |
| DELETE | `/api/characters/:id/rig` | Remove the rig and its files |
| POST | `/api/characters/:id/lipsync` | Analyse audio → mouth-cue timeline |
| POST | `/api/story` | Topic → story JSON (key required) |
| GET/POST | `/api/projects` | List / create a project |
| GET | `/api/projects/:id` | Full project state + progress |
| DELETE | `/api/projects/:id` | Delete project and assets |
| POST | `/api/projects/:id/story` | Generate the story |
| POST | `/api/projects/:id/assets` | Generate images + voice |
| POST | `/api/projects/:id/render` | Render the MP4 |
| POST | `/api/projects/:id/automate` | Story → assets → render in one job |
| POST | `/api/projects/:id/scenes/:index/retry` | Re-do one scene only |
| POST | `/api/projects/:id/cancel` | Stop after the current step |
| GET | `/api/projects/:id/video` | Inline MP4 preview |
| GET | `/api/projects/:id/download` | MP4 download |
| GET | `/api/projects/:id/captions` | Hindi `.srt` |
| POST/GET | `/api/projects/:id/seo` | SEO package |
| POST/GET | `/api/projects/:id/thumbnail` | Thumbnail JPEG |
| POST | `/api/youtube/upload/preflight` | Validate everything, **never uploads** |
| POST | `/api/youtube/upload` | Resumable upload (OAuth + `x-confirm-upload: yes`) |

Long operations return `202` with the project; poll `GET /api/projects/:id`.
Every job is also recorded in the persistent queue (`data/jobs/`), so a restart
resumes it instead of losing the work.
A route that needs a missing credential returns `503` with `"blocked": true`,
never a fake success.

---

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | for AI | Story, images, voice, SEO |
| `GEMINI_SCRIPT_MODEL` | no | Text model (default `gemini-3.8-flash`) |
| `GEMINI_SCRIPT_FALLBACK_MODEL` | no | One-shot fallback on 404/429 (default `gemini-3.5-flash-lite`, **not verified** — check with *Verify setup*) |
| `GEMINI_IMAGE_MODEL` | no | Image model (default `gemini-3.1-flash-image`) |
| `GEMINI_TTS_MODEL` | no | TTS model (default `gemini-2.5-flash-preview-tts`) |
| `YOUTUBE_CLIENT_ID` / `_SECRET` / `REDIRECT_URI` | for upload | OAuth app |
| `APP_SESSION_SECRET` | for upload | ≥32 chars, encrypts the OAuth cookie |
| `APP_ACCESS_KEY` | no | Optional extra API gate |
| `APP_REGISTRATION_KEY` | no | Required to sign up after the first account |
| `API_RATE_LIMIT_MULTIPLIER` | no | Scales every rate limit (e.g. `0.5` halves them) |
| `GEMINI_TIMEOUT_MS` | no | Per-call Gemini timeout (default 90000, max 600000) |
| `RHUBARB_PATH` | no | Native Rhubarb binary (WASM build is the fallback) |
| `FFMPEG_PATH` | no | Explicit FFmpeg binary |
| `FFMPEG_PRESET` | no | x264 preset (default `veryfast`) |
| `CAPTION_FONT_FILE` | no | Devanagari TTF for burned captions/thumbnail |
| `DATA_DIR` | no | Where projects/characters are stored (default `./data`) |

Keys live only in the environment. Nothing is written to the frontend.

---

## Tests

```bash
FFMPEG_PATH=/path/to/ffmpeg npm test
```

158 tests (157 pass, 1 intentionally skipped), including browser-level
sign-in/CSRF and mobile-layout tests (jsdom). The renderer and
end-to-end tests run a **real** FFmpeg and assert on the produced MP4
(container, streams, duration, size). They skip — with an explicit reason —
when no FFmpeg binary is available; they never fake a pass.

The full 30-minute render (150 scenes, real 720p) is opt-in because it takes
many minutes:

```bash
RUN_LONG_RENDER=1 FFMPEG_PATH=/path/to/ffmpeg node --test test/render-30min.test.js
```

---

## Verify your Gemini key and models (free)

One `models.list` call is metadata only — it generates nothing and costs no
quota. It is the only supported way to prove a model ID works for your key.

```bash
GEMINI_API_KEY=... node scripts/verify-models.js
```

Prints one line per configured model (`✅` available, `❌` required but missing,
`⚠️` optional fallback missing) and exits non-zero when a required ID is absent.
The key is never printed — not its value, not its length. In the dashboard the
same check is **Verify setup** (`POST /api/setup/verify`), which uses the same
single request to validate the key and every configured model ID.

`GEMINI_SCRIPT_FALLBACK_MODEL` is optional and its default is **not verified**:
leave it unset unless this command reports it available.

---

## Deployment

`render.yaml` runs the Node server (`npm start`). `netlify.toml` only publishes
the static `dist/`, so a Netlify deploy has no API — use it for the frontend
alone or remove it.

Free-tier caveats: 512 MB RAM, ephemeral disk, sleep after inactivity. A 30
minute render will not finish on a free instance; the chunked renderer resumes,
so re-running the same project continues from the last chunk.

---

## Security notes

- Image payloads are validated by **magic bytes**, not declared MIME.
- Audio is normalised to WAV before it reaches FFmpeg.
- OAuth state is checked on callback; tokens are AES-256-GCM encrypted in an
  HttpOnly, SameSite=Lax cookie.
- YouTube metadata travels as base64 JSON so Hindi titles work (HTTP headers
  cannot carry non-Latin-1 text).
- Public uploads require an explicit confirmation step in the dashboard.
- Optional `APP_ACCESS_KEY` gate for public deployments.
- Multi-user accounts with scrypt hashes and revocable server-side sessions.
- Per-session CSRF tokens on every state-changing route.
- Sliding-window rate limits per route group, keyed by user (or IP when signed
  out); `/api/health` and `/api/auth/status` are exempt.
- Project/character ownership enforced server-side on every route.
- Every AI response is passed through `redactSecrets()` before it reaches a client.
- Provider calls have a hard timeout so a hung request cannot block the job queue.
- YouTube upload requires `x-confirm-upload: yes` and the dashboard asks again;
  preflight never touches Google's upload endpoints.
- The dashboard's one-click automation stops at the MP4. **It never uploads to
  YouTube**; upload is a separate button that asks for confirmation, and the
  server still requires `x-confirm-upload: yes`.
- **Not implemented**: full-body 3D character animation (see `GOAL.md`).
