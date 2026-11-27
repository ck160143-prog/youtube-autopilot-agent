# BABA AI — FINAL LIVE SYSTEM TEST रिपोर्ट

Branch: `arena/9e73f06f-youtube-autopilot-agent` · HEAD `06427ae` + 53 uncommitted changes
**कोई commit / push / PR / merge / deploy नहीं किया।**
तारीख: 2026-11-24 · हर नतीजा इसी sandbox में असल में चलाकर लिया गया।

---

## 0. सबसे पहले — एक ज़रूरी सच

आपने लिखा कि Render Environment में keys डाल दी हैं। **वे keys इस sandbox में नहीं आतीं।**

मैंने असल में जाँचा:

| जाँच | नतीजा |
|---|---|
| इस sandbox के env vars (`GEMINI_API_KEY`, `YOUTUBE_*`, `APP_SESSION_SECRET`, `APP_ACCESS_KEY`, `APP_REGISTRATION_KEY`) | सभी **ABSENT** |
| `.env` फ़ाइल | मौजूद नहीं |
| `generativelanguage.googleapis.com` | DNS resolve ✅ → TCP connect ✅ → **TLS handshake पर SSL_ERROR_SYSCALL** ❌ (exit 35) |
| `www.googleapis.com`, `oauth2.googleapis.com` | HTTP 000 |
| `youtube-autopilot-agent-1.onrender.com` | HTTP 000 |

यानी मैं आपकी असली key से Google को call **नहीं** कर सकता। इसीलिए Phase 3 का provider हिस्सा local fake से चलाया और बाकी सब (FFmpeg, captions, sync, thumbnail, download, security) **असली** रखा। जो भी नीचे "WORKING" है वह असली test से है; जो credentials पर अटका है वह साफ़ BLOCKED लिखा है।

---

## 1. PHASE 1 — Configuration Verify (असली `/api/setup` और `/api/setup/verify` से)

```
/api/setup → ok=false
  [OK     ] FFMPEG            available 9.0.2-17-g2a571b6068-20260930
  [OK     ] DEVANAGARI_FONT   bundled font present (212 KB)
  [OK     ] DATA_DIR          writable
  [OK     ] LIPSYNC_ENGINE    available via wasm (Rhubarb)
  [BLOCKED] GEMINI_API_KEY    not set
  [BLOCKED] YOUTUBE_OAUTH     not configured — upload disabled
  [WARN   ] REGISTRATION_KEY  not set — only the first account can be created
```

`/api/setup/verify` असल में Google को call करता है — इस बात का सबूत:

```
POST /api/setup/verify (dummy key) → 31ms
  [blocked] GEMINI_API_KEY — "fetch failed" ... reason=rejected
  keyShape: {present:true, length:39, hadQuotes:false, looksLikeAIStudio:true}
  response में key का कोई अंश नहीं → secret visible? NO
```

`keyShape` सिर्फ shape बताता है (present/length/quotes) — value कभी नहीं। ✅

---

## 2. PHASE 2 — Security Test: **20/20 PASS**

असली सर्वर, असली 2 users, असली ids:

| Test | नतीजा |
|---|---|
| CSRF: बिना token POST | ✅ 403 |
| CSRF: गलत token | ✅ 403 |
| Session: valid cookie | ✅ 200 |
| Session: forged cookie | ✅ 401 |
| Logout + CSRF | ✅ 200 |
| Logout के बाद पुराना cookie | ✅ 401 (session मरा) |
| दोबारा login (recovery) | ✅ 200, projects फिर दिखे |
| दूसरे user का project GET | ✅ 403 |
| दूसरे user का project DELETE | ✅ 403 |
| दूसरे user का automate | ✅ 403 |
| Path traversal `..%2f..%2fetc%2fpasswd` | ✅ 400 |
| Path traversal `%2e%2e%2fserver.js` | ✅ 400 |
| Upload बिना confirmation header | ✅ **409 CONFIRM_REQUIRED** |
| Upload rate limit | ✅ 5 के बाद 429 |
| API responses में secret pattern | ✅ कोई नहीं |

**Static/private file leak scan — 19 paths, 0 leak:**

```
/server.js 404   /lib/auth.js 404   /package.json 404   /.env 404
/data/auth.json 404   /.git/config 404   /.git/HEAD 404
/node_modules/... 404   /../etc/passwd 404   /render.yaml 404
/api/%2e%2e%2fserver.js → 401 (auth से पहले रुका)
STATIC/FILE LEAKS: 0
```

---

## 3. PHASE 3 — असली End-to-End Test (ताज महल के रहस्य, 1 मिनट, 16:9, 720p)

Provider local था (network blocked), **बाकी पूरा pipeline असली**:

```
[0.1s]  1. story      HTTP 200  title="ताज महल के रहस्य"  scenes=4
[0.1s]  2. project    aspect=16:9 quality=720p scenes=4
[0.1s]  3. automate   HTTP 202
[0.8s]     rendering 0%   — scene 1/4
[5.1s]     rendering 20%  — scene 2/4
[9.3s]     rendering 60%  — scene 4/4
[13.5s]    rendering 88%  — audio mix
[17.7s]    completed 100% — MP4 तैयार (2.57 MB, 60 सेकंड)
[17.7s]  4. FINAL status = completed
[17.7s]  5. MP4  captions=burned
[17.7s]  6. SEO POST 200 → title, description, 4 tags, hashtags, thumbnailText (अलग probe से verified)
[17.8s]  7. thumbnail 200 mode=image+title → 32.3 KB असली JPEG
[17.8s]  8. download 200 → 2.57 MB, type=video/mp4
```

---

## 4. PHASE 4 — Video Quality (असली ffprobe/ffmpeg माप)

```
Duration : 00:01:00.04
Video    : h264 1280x720, 24 fps, yuv420p
Audio    : aac 44100 Hz stereo, mean -33.4 dB / max -20.1 dB (silence नहीं)
Decode   : पूरी फ़ाइल decode exit 0, कोई error नहीं
Frames   : 6 samples → YAVG 100.6 / 100.6 / 179.2 / 106.7 / 153.9 / 153.9 (कोई blank frame नहीं)
Captions : frame 3s और 30s पर YMIN 23–26 / YMAX 235 → असली pixels
Thumbnail: 1280x720, देवनागरी शीर्षक साफ़ पढ़ा गया (स्क्रीनशॉट देखा)
Music/SFX: audio-mix test 3/3 — bed और SFX असली dB से मापे गए
```

**ईमानदार सीमा:** मैंने आँखों से captions, thumbnail और frames verify किए। Audio को सिर्फ dB से मापा — "आवाज़ कैसी लगती है" यह असली Hindi TTS के बिना नहीं कह सकता।

---

## 5. PHASE 5 — YouTube Preflight (असली)

```
/api/youtube/status → {"configured":false,"connected":false}

preflight (असली MP4 size + metadata):
  [FAIL] OAUTH_CONFIG      YOUTUBE_* env vars या APP_SESSION_SECRET गायब
  [FAIL] CHANNEL_CONNECTED पहले चैनल Connect करें
  [OK  ] VIDEO_FILE       2.6 MB
  [OK  ] VIDEO_SIZE_LIMIT 90 MB के अंदर
  [OK  ] VIDEO_MIME       video/mp4
  [OK  ] TAGS             3 tags, 29/500 अक्षर
  [OK  ] CATEGORY         categoryId: 22
  [OK  ] TITLE            38/100
  [OK  ] DESCRIPTION      85/5000
  [OK  ] PRIVACY          private
  wouldUpload = false   ← कोई upload नहीं हुआ

upload बिना confirm      → 409 CONFIRM_REQUIRED
upload confirm के साथ    → 503 (OAuth missing) — Google तक कोई request नहीं गई
```

OAuth: **BLOCKED** — credentials इस env में नहीं। कोई वीडियो public नहीं किया, कोई upload नहीं हुआ।

---

## 6. PHASE 6 — इस round में मिले और ठीक हुए 4 bugs

### Bug 1 — Network failure को "API key rejected" बताया जा रहा था 🔴
असली proof: dummy key डालकर verify चलाया → `reason=rejected`, detail `"fetch failed"`.
इसका मतलब user बेकार में अपनी सही key बदलता। Fix: `isNetworkError()` + `networkErrorDetail()`;
अब `reason: "network"` और detail `ENOTFOUND/EAI_AGAIN` जैसा actionable code।
Google असल में key reject करे (HTTP 400/403) तो वही `rejected` रहता है — दोनों के test हैं।

### Bug 2 — Gemini error पर कच्चा provider message client तक जा सकता था 🟠
500 पर `redactSecrets(error.message)` भेजा जा रहा था (request का हिस्सा लीक हो सकता था)। अब generic message, details सिर्फ `safeLog` में।

### Bug 3 — Captions 720p पर mobile में बहुत छोटे 🔴 (feature था ही नहीं)
`fontSize = 4.5% × height` = 720p पर **32px** → 400px चौड़ी phone स्क्रीन पर ~10px।
असली सबूत: ASS फ़ाइल `Style: Caption,Noto Sans Devanagari,32,...` और screenshot में पढ़ना मुश्किल।
Fix: `max(28px, 6.4% × height)` → 720p पर 46px, 1080p पर 69px। दोबारा render करके आँखों से verify किया — अब साफ़।

### Bug 4 — SEO tags और categoryId YouTube को कभी भेजे ही नहीं जाते 🔴
असली code पढ़कर पकड़ा: upload body में सिर्फ `{title, description}` था।
- `categoryId` **YouTube के insert में अनिवार्य** है → असली upload fail हो जाता।
- SEO panel में बने tags बेकार पड़े रहते → video खोज में नहीं आता।
Fix: `normalizeYoutubeTags()` (≤30 tags, हर tag ≤60 अक्षर, कुल ≤500), default `categoryId` 22 (People & Blogs, env `DEFAULT_YOUTUBE_CATEGORY_ID` से बदल सकते हैं), preflight में `TAGS` और `CATEGORY` checks जोड़े।

**हर fix के साथ:** पहले failing test दिखाया, फिर fix, फिर pass। उदाहरण (captions):
```
पुराना code → not ok 7 "font 32px at 720p is below 6% of height"  # fail 1
नया code    → ok 7, ok 8                                          # fail 0
```

---

## 7. PHASE 7 — Final Report

### ✅ WORKING (असली test से)
| Feature | सबूत |
|---|---|
| Story → scenes → images → voice → sync → captions → music/SFX → MP4 | 17.7s में पूरा, `completed` |
| MP4 render (FFmpeg) | 60.04s, 1280×720, h264+aac, decode exit 0 |
| Hindi captions burned | frame में pixels + screenshot में पढ़ा गया |
| Thumbnail (देवनागरी शीर्षक सहित) | 1280×720 JPEG, 32.3 KB |
| SEO (title/description/tags/hashtags/thumbnailText) | असली endpoint से 4 tags लौटे |
| Download | 2.57 MB, `video/mp4`, render से बाइट-बराबर |
| Security (CSRF, session, ownership, traversal, rate limit, confirm gate) | 20/20 + 0 file leak |
| Save / resume / retry | project जॉब + `failed` status साफ़ संदेश के साथ |
| Preflight | 8 checks, `wouldUpload:false` |

### ❌ FAILED
कोई नहीं — full suite में **0 fail**।

### ⛔ BLOCKED
| क्या | क्यों |
|---|---|
| असली Gemini story/images/voice | key इस sandbox में नहीं; Google तक TLS blocked (exit 35) |
| असली Hindi TTS की pronunciation | असली key के बिना सत्यापित नहीं |
| YouTube OAuth connect / channel verify | `YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI` + `APP_SESSION_SECRET` नहीं |
| असली upload | उपरोक्त + आपकी अनुमति (जान-बूझकर) |
| Production का live test | `youtube-autopilot-agent-1.onrender.com` HTTP 000 (sandbox से पहुँच नहीं) |
| Scheduling / Analytics | कोड ही नहीं (plan PHASE-4-REPORT.md §6 में) |

### 🐞 Fixed bugs (इस round)
1. Network failure को "key rejected" बताना 🔴
2. Provider का कच्चा message client तक जाना 🟠
3. 720p captions mobile पर अपठनीय 🔴
4. YouTube को tags/categoryId न भेजना 🔴
(पिछले round: 3 और — character id data loss, thumbnail 0-based index, `dirFor` traversal)

### 🐞 Remaining bugs
कोई ज्ञात bug नहीं। **ज्ञात सीमाएँ** (bug नहीं, feature gap):
- lip-sync सिर्फ 2D mouth-sprite swap (रigged character हो तभी; इस project में नहीं था, इसलिए `lipSync.scenes=0`)
- scheduling/analytics नहीं
- Render free instance का filesystem ephemeral — redeploy पर projects मिटेंगे

### 🔌 API configuration status
| Variable | इस sandbox में | आपके Render में (मान लिया, verify नहीं कर सका) |
|---|---|---|
| GEMINI_API_KEY | ❌ absent | आपने डाली है |
| YOUTUBE_CLIENT_ID / SECRET / REDIRECT_URI | ❌ absent | डाली है |
| APP_SESSION_SECRET | ❌ absent | डाली है |
| APP_ACCESS_KEY / APP_REGISTRATION_KEY | ❌ absent | आपकी जानकारी |
| FFMPEG / FONT / DATA_DIR / LIPSYNC | ✅ OK | ✅ |

### 🤖 Gemini real request result
**नहीं हो सका।** TLS handshake blocked: `OpenSSL SSL_connect: SSL_ERROR_SYSCALL` (exit 35)।
झूठा success नहीं लिखूँगा — key की वैधता **अनसत्यापित** है।

### 🔗 YouTube OAuth result
`configured:false, connected:false`। Route सही तरीके से 503 + साफ़ हिंदी संदेश देता है। कोई upload नहीं।

### 🎬 Video render result
`render-test/BABA-AI-taj-mahal-1min.mp4` — **60.04s, 1280×720, h264+AAC, 2.57 MB**, decode exit 0, captions पढ़ने योग्य।
`render-test/BABA-AI-taj-thumbnail.jpg` — 1280×720, देवनागरी शीर्षक।

### 🧪 Security results
20/20 PASS · static/file leak 0/19 · secret redaction 0 leak

### 📊 Tests
```
npm test → 207 tests, 206 pass, 0 fail, 1 skipped
```
skip = opt-in 30-मिनट render (`RUN_LONG_RENDER=1`), इस env में नहीं चलाया।

### 🚀 Production deployment status
**LIVE पर आज का कोई भी fix नहीं है।**
```
prod deployment : id 8054109790, sha e2fa433e (main), state=success, 2026-11-25 09:57 UTC
मेरी branch     : 06427ae + 53 uncommitted changes (कोई push नहीं)
```
यानी production पर वही code चल रहा है जो कल merge हुआ था — **आज के 4 bug fixes उसमें नहीं हैं।**

---

## 8. बदली हुई फ़ाइलें (इस round)

```
server.js                        network-error classification + tags/categoryId
lib/captions.js                  720p caption font 4.5% → 6.4%
test/network-error.test.js  NEW  5 tests
test/captions.test.js       +2   font size regression
test/youtube-preflight.test.js +2 tags/category
render-test/BABA-AI-taj-mahal-1min.mp4 + thumbnail   (gitignored)
```

---

## 9. आपको अब क्या करना है

1. **Render में deploy** — commit + PR + merge के बाद ही fixes live होंगे। आपकी अनुमति चाहिए।
2. **असली Gemini test** — Render पर deploy के बाद dashboard → **Verify setup** दबाएँ और जो status lines दिखें वही भेजें (key कभी नहीं भेजें)।
3. **YouTube connect** — `…/api/youtube/connect` → Test User `chhotukumarnonia2066@gmail.com` → channel **ID** verify करें (Gmail पते से नहीं)।
4. पहला असली upload **private** में, और तब भी `x-confirm-upload: yes` के साथ।

**क्या मैं अब commit करूँ?** (आपकी अनुमति के बिना commit/PR/merge/deploy नहीं करूँगा।)
