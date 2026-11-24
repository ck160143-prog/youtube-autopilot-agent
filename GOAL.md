# BABA AI — Goal and Status

**Goal:** the user writes a Hindi topic and picks a duration; the agent writes
the story, keeps one consistent cast, draws every scene, speaks every line,
edits the video and prepares it for YouTube — with no fake success anywhere.

---

## Status by requirement

### 1. Topic → finished video
✅ Working. `POST /api/projects` + `/automate` runs story → assets → render as one
resumable job. Progress is persisted per stage.

### 2. 1 to 30 minutes
✅ Working. Scene count and timeline scale with the request (10 scenes for 1 min,
150 for 30). A 2-minute 9:16 video (20 scenes) was rendered for real: 120.05 s,
5.19 MB, in 64.5 s on one CPU. A 30-minute timeline resolves to exactly 1800 s.
⚠️ A full 30-minute render has not been executed end-to-end in this environment
(it would take ~15–20 min of encoding here); the engine supports it via chunking.

### 3. Story, script, dialogue, scenes
✅ Working. JSON-only contract, validated and repaired server-side; a malformed
response fails loudly instead of rendering an empty story.

### 4. Consistent 3D cartoon characters
✅ Working at the prompt level. A character bible (face, outfit, colours) is
repeated in every image prompt, because image models have no memory.
⚠️ Consistency is *requested*, not guaranteed by the image model.

### 5. Character consistency with free AI tools
✅ Real Gemini image generation. ⛔ No local Stable Diffusion/ComfyUI integration
yet — documented as a manual import path.

### 6. Per-character Hindi voice and dialogue
✅ Working. Each character carries a voice name; the narrator line is spoken with
the speaker's voice.

### 7. Lip-sync and real character animation
🟡 **Partially working — 2D puppet lip-sync (experimental).** Real, not simulated:
- **Engine**: Rhubarb Lip Sync (MIT) — native binary (`RHUBARB_PATH`) या WASM build
  (`rhubarb-lip-sync-wasm`, MIT)। CPU-only, कोई GPU नहीं।
- **Rig**: character के mouth sprites (A–H, X) असली files के रूप में disk पर;
  magic-byte validated; `POST /api/characters/:id/rig`।
- **Render**: `lib/animator.js` cue times पर sprite overlay लगाता है (FFmpeg),
  `lib/pipeline.js` हर scene के narration से cues निकालता है (cache के साथ)।
- **Evidence**: 2D overlay pixel-level test — cue A पर red sprite, cue B पर white,
  mouth box के बाहर pixels dark; और full e2e render में 3/3 scenes mouth-animated।

⛔ **अभी भी not implemented**: full-body 3D animation, walking/running/expressions
का असली motion — उसके लिए motion-video provider चाहिए।

⚠️ **Hindi accuracy unverified** — Rhubarb का recognizer English phoneme model है;
sandbox में real Hindi speech sample नहीं था। इसलिए इसे "experimental" कहा गया है,
"verified Hindi lip-sync" नहीं।

Researched options (Phase 3/4):

| Option | License | Needs | Verdict |
| --- | --- | --- | --- |
| Rhubarb Lip Sync 1.14 | **MIT** | CPU only | **integrated** (cue timeline) |
| Wav2Lip / Easy-Wav2Lip | non-commercial only | NVIDIA GPU + CUDA | rejected |
| SadTalker, MuseTalk | open weights | GPU | rejected (no GPU here) |
| LatentSync 1.6 | open weights | ~18 GB GPU memory | rejected |

### 8. Camera movement, walking, running, expressions, transitions
✅ Camera movement (Ken Burns in/out, pan) and fade transitions are real FFmpeg.
⛔ Walking/running/expressions are not animated — they can only be *depicted* in
a still image. Not claimed otherwise.

### 9. Hindi subtitles
✅ Working. SRT download + ASS burn-in, with a soft-subtitle fallback. Phase 3
ships **Noto Sans Devanagari** (SIL OFL 1.1) inside the package at
`fonts/NotoSansDevanagari-Regular.ttf`, so captions render as real Devanagari
glyphs on hosts with no system fonts. A pixel-level test proves it: with the
bundled font the caption band contains real glyph pixels, without it libass
draws empty boxes (□).

### 10. Music and sound effects
✅ Working. Both are synthesised by FFmpeg (sine/noise sources), so they are
license-clean; music is ducked under narration. A user-supplied licensed track
can replace the bed.

### 11. 9:16 and 16:9
✅ Working, plus 1:1. Verified with a real 9:16 render.

### 12. Thumbnail, title, description, tags, SEO
✅ Working. SEO JSON is generated per project; the thumbnail is a real JPEG from
scene 1. Title text on the thumbnail requires `CAPTION_FONT_FILE`.

### 13. Preview and download
✅ Working. Inline `/video`, attachment `/download`, `/captions`.

### 14. Approval before YouTube upload
✅ Working. The dashboard requires an explicit checkbox before upload, and the
default privacy is `private`.

### 15. Keys, authentication, rate limits, file validation
✅ Keys stay server-side. ✅ File signature validation. ✅ Optional `APP_ACCESS_KEY`
gate. ✅ **Multi-user auth** (scrypt, server-side sessions, owner/member roles).
✅ **CSRF** on every state-changing route. ✅ **Rate limiting** per route group.
✅ **Per-user ownership** of projects and characters.
✅ **Setup audit + fix guide** (`/api/setup`, `/api/setup/verify`) — key न होने पर
exact steps, और कोई नकली success नहीं। ✅ **Secret redaction** हर error response में।
✅ **Provider timeouts** (`GEMINI_TIMEOUT_MS`) ताकि एक अटकी call पूरा queue न रोके।

### 16. Free tools first
✅ Node, Express, FFmpeg, SQLite-free JSON storage, Gemini (key required), no paid
rendering or hosting service. No paid API is called without configuration.

---

## Verified test results

```
# tests 158
# pass 157
# fail 0
# skipped 1   <- the opt-in 30-minute soak test (run separately, it passed)
```

Phase 4 additions: setup 11, lipsync 6, rig 10, animator 4, YouTube preflight 5,
mobile UI 6, full pipeline e2e 2 (rigged + unrigged).

Phase 3 additions: 9 auth tests, 8 CSRF tests, 7 rate-limit tests, 5 ownership
tests, 8 job-queue tests, 4 restart-recovery tests (including a child process
that resumes an interrupted job and produces a real MP4), 4 font tests (real
FFmpeg pixel check) and 1 browser-level sign-in test (jsdom).

Real render verification (FFmpeg 9.0.2, `FFMPEG_PRESET=ultrafast`, 2 vCPU /
3.9 GB sandbox):

| Check | Result |
| --- | --- |
| 3-scene 16:9 render | MP4, video+audio, 6.05 s, captions burned |
| 20-scene 9:16 render | MP4, 120.05 s, 5.19 MB, 19 SFX, music bed |
| Resume | Existing clips reused, mtimes unchanged |
| 30-min timeline | 150 scenes, total 1800 s |
| 30-min full render | `30:00.35`, 1280×720, h264 + AAC stereo, 38.3 MB, 13 min 39 s wall clock |
| Captions in the 30-min file | Devanagari text visible in an extracted frame at 00:05:00 |
| Thumbnail | Real JPEG (FFD8 header) |
| Missing API key | `503 {"blocked": true}` — no fake success |
| Sign-in gate (browser) | Logged out → gate; register → gate hides; CSRF sent; sign out → API 401 |
| Restart recovery | Processing job re-queued at boot → real MP4 produced |
| 30-minute render (real) | 150 scenes, 1800 s, 1280×720 h264 + AAC, 38.3 MB, 15 chunks, captions burned, 819 s wall clock |
| Lip-sync engine (real) | 2 s narration → 4 mouth cues (X/B/G), Rhubarb WASM, 3.1 s |
| Mouth overlay (real pixels) | cue A = red sprite, cue B = white, outside box dark |
| Full pipeline e2e | rigged character → 3/3 scenes mouth-animated; no rig → 0 (no fake animation) |
| Setup verify (real) | missing key → blocked + steps; valid key → one `models.list` call |

---

## Remaining work

1. **Full-body 3D animation** — still not implemented (see §7). 2D mouth puppet
   works; walking/running/expressions के लिए motion provider चाहिए।
2. **Hindi lip-sync accuracy** — real Hindi speech samples पर verify करना बाकी है।
3. **Local image generation** (Stable Diffusion / ComfyUI) for a keyless path.
4. **Durable storage** — assets live on local disk; object storage is needed for
   a multi-instance deployment.
5. **Email/password reset, 2FA** — accounts are username+password only.
6. **Per-user rate limits stored outside memory** — the limiter is per process,
   so multiple instances each get their own budget.

---

## What needs a key

| Feature | Without `GEMINI_API_KEY` |
| --- | --- |
| Story generation | `503 blocked` |
| Scene images | `503 blocked` |
| Voice | `503 blocked` |
| SEO | `503 blocked` |
| Render existing assets | ✅ works |
| Captions / SRT | ✅ works |
| Music / SFX | ✅ works (synthesised) |
| Character library | ✅ works |

YouTube upload additionally needs `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`,
`YOUTUBE_REDIRECT_URI` and `APP_SESSION_SECRET`.
