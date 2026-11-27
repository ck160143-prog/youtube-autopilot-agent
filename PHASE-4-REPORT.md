# BABA AI — Phase 4 Final Report

Branch: `arena/9e73f06f-youtube-autopilot-agent` · base `06427ae` · **कोई commit / push / PR / merge / deploy नहीं**
Report date: 2026-11-24 · सारे नतीजे इसी sandbox में असली चलाकर लिए गए हैं।

---

## 1. Test report (असली)

```
npm test  →  # tests 198   # pass 197   # fail 0   # skipped 1
```

| समूह | परिणाम |
|---|---|
| security (csrf, ratelimit, ownership, auth, youtube-preflight, recovery, jobs) | ✅ PASS |
| path-safety (नया) | ✅ 3/3 |
| character-ids (नया) | ✅ 4/4 |
| media-validation | ✅ 6/6 |
| seo-auth (thumbnail regression सहित) | ✅ 7/7 |
| e2e-pipeline (असली FFmpeg + Rhubarb) | ✅ 2/2 |
| render-30min (opt-in) | ⏭️ SKIPPED — इस env में नहीं चलाया (`RUN_LONG_RENDER=1` चाहिए) |

---

## 2. इस round में मिले और ठीक हुए 2 असली bugs

### Bug 1 — Hindi नाम वाले characters एक-दूसरे को मिटा रहे थे (data loss)

`makeId()` देवनागरी नाम से सारे non-ASCII हटा देता था → हर नाम का id `"character"` बन जाता था → `upsert` पुराने को overwrite कर देता था।

असली reproduction (fix से पहले):
```
रामू -> id=character
सीता -> id=character
मोहन -> id=character
LIST COUNT: 1   NAMES: मोहन     ← दो characters खो गए
```
Fix के बाद:
```
रामू -> char-41hm77   सीता -> char-szluv9   मोहन -> char-g8ezdt
LIST COUNT: 3   RESULT: OK unique ids
```
- `lib/characters.js` — Devanagari के लिए random id, Latin के लिए readable slug (`Ramu Ji` → `ramu-ji`), और collision पर `-2` suffix (owner के अंदर ही)।
- Test: `test/character-ids.test.js` (4)

### Bug 2 — Thumbnail route गलत scene index पढ़ती थी

Route `assets.scenes[1]` पढ़ती थी, पर pipeline **0-based** लिखती है (`assets.scenes[scene.index]`)। इसलिए 1-scene project या जिनमें बाद के scenes fail हुए, वहाँ image होने पर भी 409 मिलता था।

असली reproduction (fix से पहले, pipeline जैसा ही 0-based layout):
```
THUMBNAIL POST: 409 {"error":"thumbnail के लिए पहले दृश्य 1 की image चाहिए।"}
```
Fix के बाद:
```
THUMBNAIL POST: 200  → thumbnail.jpg  1280x720 mjpeg, 2.8 Mb/s (असली JPEG)
```
- `server.js` — `scenes[0]` (fallback `scenes[1]` legacy data के लिए)।
- पुराना test `scenes[1]` seed करता था इसलिए bug कभी पकड़ में नहीं आया — अब 0-based का test भी है।

### Bonus hardening — `dirFor()` path traversal
`fileFor()` id validate करता था, `dirFor()` नहीं। अब दोनों एक ही regex (`^[A-Za-z0-9_-]{1,80}$`) — `lib/projects.js`, test: `test/path-safety.test.js` (3)।

---

## 3. असली MP4 (इस env में दोबारा बनाया, कोई API खर्च नहीं)

`render-test/BABA-AI-proof.mp4` — fake Gemini provider (network नहीं), बाकी सब असली:
story → 3 scenes → image validation → audio normalise → Rhubarb cues → FFmpeg render → captions burn → download.

```
Duration: 00:01:00.04
Video: h264 1280x720, 24 fps
Audio: aac 44100 Hz stereo
decode full-file exit=0
audio mean -35.2 dB / max -19.4 dB (silence नहीं)
frame@5s → YMIN 26 / YMAX 235 (असली pixels, flat नहीं)
render.lipSync: {"scenes":0,"cues":0}   ← इस project में रigged character नहीं था (ईमानदार)
captions: burned  hasVideo=true hasAudio=true
```
रigged character वाला असली lip-sync path `test/e2e-pipeline.test.js` में PASS होता है (`render.lipSync.scenes >= 1`, `cues > 0`, `.lipsync.json` cache मौजूद) — तब भी fake provider, network नहीं।

---

## 4. Route + security audit (लाइव सर्वर से निकाला, अंदाज़े से नहीं)

**49 routes** (Express stack से पढ़े गए)। हर route को बिना login hit किया:

```
TOTAL ROUTES: 50 (49 /api + GET /)
PROTECTED ROUTES NOT BLOCKING ANON: 0        ← एकमात्र public GET / = login page
```
Public जान-बूझकर: `/api/health`, `/api/auth/status`, `/api/auth/login`, `/api/auth/register`, `/api/youtube/callback`।

**Cross-user isolation — असली 2 users, असली ids:**
```
A project: 201  A character: 200
GET  /api/projects/<A>             -> 403
GET  /api/projects/<A>/thumbnail   -> 403
GET  /api/render/status/x1         -> 404
DELETE /api/projects/<A>           -> 403
POST /api/projects/<A>/automate    -> 403
POST /api/projects/<A>/render      -> 403
CROSS-USER LEAKS: 0
A project survives C delete attempt: 200
```

**Secret redaction — असली परीक्षण (`lib/setup.js`):**
```
ok  "api key invalid: AIzaFAKE…"        -> "api key invalid: *** (400)"
ok  "client_secret=FAKE-yt-secret…"     -> "client_secret=***"
ok  "token: ya29.a0Af…"                 -> "token=***"
SECRET LEAKS: 0
```
`safeLog()` सिर्फ `{status, code}` लॉग करता है — body/key नहीं। Error middleware generic 500 देता है।

**और verified:** session cookie `HttpOnly; SameSite=Lax; Secure` (prod) · CSRF सभी POST पर · rate-limit `/api` पर + upload पर 5 · path traversal blocked · render backlog cap 429 · upload `x-confirm-upload: yes` के बिना 409.

---

## 5. Feature status — ईमानदार

| # | माँगा गया | स्थिति | सबूत / कारण |
|---|---|---|---|
| 2 | Topic → Hindi story → scenes → images → voice | 🟡 CODE WORKING / ⛔ LIVE BLOCKED | पूरा pipeline है, e2e PASS (fake provider)। असली Gemini के लिए `GEMINI_API_KEY` चाहिए |
| 3 | Automatic scene-to-audio sync | 🟢 WORKING | `lib/timeline.js` + `timeline.test.js`; render की duration narration length से बनी |
| 4 | MP4, subtitles, music, SFX, thumbnail | 🟢 WORKING | असली MP4 ऊपर; captions burned; music 1.2 / SFX 1.8; thumbnail 1280×720 (fix के बाद) |
| 5 | SEO title/description/keywords/hashtags | 🟢 WORKING | `/api/projects/:id/seo` GET+POST, `seo-auth.test.js` |
| 6 | Save / resume / failure recovery | 🟢 WORKING | project JSON persist, automate retry, `recovery.test.js`, `jobs.test.js` |
| 7 | Upload से पहले confirmation | 🟢 WORKING | `x-confirm-upload: yes` के बिना **409 CONFIRM_REQUIRED** (लाइव सत्यापित) |
| 8 | Scheduling | 🔴 NOT IMPLEMENTED | कोई endpoint/कोड नहीं। plan नीचे |
| 8 | Analytics | 🔴 NOT IMPLEMENTED | कोई endpoint/scope नहीं। plan नीचे |
| 8 | असली character animation / lip-sync | 🟡 PARTIAL (सच में सीमित) | 2D mouth-sprite swap on Rhubarb cues — **पूरा 3D/body animation नहीं**। `/api/capabilities` खुद यही कहता है। रigged character न हो तो कुछ नहीं |

**Capabilities अभी (लाइव):** story/sceneImages/voice `blocked` (key नहीं), render/captions/music `available`, characterAnimation/lipSync/youtubeUpload `blocked`।

---

## 6. Scheduling + Analytics — सुरक्षित implementation plan (कोड अभी नहीं लिखा)

### Scheduling (YouTube की तरफ़ hold)
- कोई अलग API नहीं: `videos.insert` के `status` में `publishAt` (RFC 3339 UTC) + `privacyStatus: "private"`।
- **कठोर नियम:** `publishAt` सिर्फ़ `private` के साथ चलता है; public/unlisted के साथ `invalidPublishAt` (400)। जो वीडियो एक बार public हो गया, उसे दोबारा schedule नहीं किया जा सकता। बीता हुआ समय = तुरंत publish (error नहीं)।
- UI: date+time (IST) → UTC में बदलकर server भेजे; server पिछला समय reject करे (`400`, 5 मिनट का buffer)।
- सुरक्षा: वही `x-confirm-upload: yes`, वही owner check, privacy हमेशा `private` fix, नया test: public+publishAt → 400 (Google call से **पहले**), past time → 400, और एक unit test जो सिर्फ़ payload shape जाँचे (कोई network नहीं)।
- खर्च: 0 ₹ (quota units, पैसा नहीं)।

### Analytics (read-only)
- `YouTube Analytics API v2` → `GET /v2/reports?ids=channel==MINE&startDate&endDate&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained&dimensions=day`
- **दोनों scopes ज़रूरी:** `yt-analytics.readonly` **और** `youtube.readonly` (अकेला analytics scope अब काम नहीं करता)।
- यह scope जोड़ने पर **user को दोबारा consent** देना पड़ेगा → अलग "Analytics जोड़ें" बटन, मौजूदा upload connection तोड़े बिना।
- Data 24–72 घंटे देर से आता है — dashboard पर यही लिखा जाए, "live" नहीं।
- सुरक्षा: owner-only, कोई write नहीं, response में सिर्फ़ aggregate numbers, token सिर्फ़ server-side session में।
- Scope बढ़ाने के लिए Google verification की ज़रूरत पड़ सकती है — यह **आपकी अनुमति** के बिना नहीं करूँगा।

---

## 7. Render deployment checklist (आपके लिए, step-by-step)

पहले मौजूदा service `youtube-autopilot-agent-1` **ही** इस्तेमाल होगी — नई service नहीं।

1. **अनुमति** — deploy मेरी तरफ़ से नहीं होगा; आप Render dashboard में करेंगे।
2. **Environment Variables** (Render → Service → Environment):
   - `GEMINI_API_KEY` = आपकी key (quotes के बिना) — **अनिवार्य**, इसके बिना story/images/voice blocked रहेंगे
   - `APP_SESSION_SECRET` = लंबा random (~48 अक्षर)
   - `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI` = `https://youtube-autopilot-agent-1.onrender.com/api/youtube/callback`
   - `APP_REGISTRATION_KEY` = तभी जब दूसरा account बनाना हो (पहला account owner बनता है, key के बिना)
   - वैकल्पिक: `FFMPEG_PRESET=ultrafast` (free 512 MB instance पर तेज़)
3. **जाँच** — deploy के बाद `https://…/api/health` → `{"status":"ok","ready":true,"blocked":[]}` चाहिए। `ready:false` का मतलब `blocked` array में बताई चीज़ गायब है (key कभी response में नहीं आती)।
4. **Setup page** — login करके `GET /api/setup` / Setup panel देखें: हर check का `status` `ok` होना चाहिए।
5. **YouTube** — Google Cloud Console → YouTube Data API v3 enable → OAuth consent screen में Test User `chhotukumarnonia2066@gmail.com` → `…/api/youtube/connect` → channel **ID** से verify (सिर्फ़ Gmail पते से नहीं)।
6. **पहला असली test** — 1 मिनट का project → Premiere → preflight → **private** upload (`x-confirm-upload`).
7. **सीमाएँ जो पहले से जान लें:**
   - Free instance का filesystem **ephemeral** है — redeploy पर projects/renders मिट जाएँगे। स्थायी डेटा के लिए Render Disk (`DATA_DIR`) या Postgres चाहिए (यह अलग अनुमति का काम है)।
   - Background render ~512 MB RAM में सीमित है; `MAX_RENDER_JOBS = 2` से backlog 429 होता है।
   - 30 मिनट का render इस sandbox में 638s लिया था — free instance पर इससे धीमा होगा।
8. **Rollback** — Render → Deploys → पिछला successful deploy "Redeploy"। कोई DB migration इस plan में नहीं है, इसलिए rollback सुरक्षित है।

---

## 8. जो मैंने नहीं किया (जान-बूझकर)

- commit / push / PR / merge / deploy — आपकी अनुमति नहीं थी
- scheduling व analytics का कोड — plan पहले, आपकी हाँ के बाद
- OAuth scopes या Google Console की कोई सेटिंग बदलना
- कोई paid API call, कोई असली YouTube upload
- render-test/ के 300 MB+ artifacts — sandbox reset में चले गए थे, सिर्फ़ 1 मिनट का proof MP4 दोबारा बनाया (2.0 MB)

---

## 9. बदली हुई फ़ाइलें (इस round में)

```
lib/characters.js            makeId() + upsert() id collision fix
lib/projects.js              dirFor() path-traversal validation
server.js                    thumbnail scene index 0
test/character-ids.test.js   NEW (4)
test/path-safety.test.js     NEW (3)
test/seo-auth.test.js        +1 thumbnail 0-based regression
```

अगला कदम आपका: **commit करूँ?** या पहले scheduling/analytics का कोड लिखूँ?
