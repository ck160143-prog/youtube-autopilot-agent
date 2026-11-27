# BABA AI — असली प्रगति (Phase 1–14)

Branch `arena/9e73f06f-youtube-autopilot-agent` · HEAD `84f9bc3` · PR #29 (OPEN, CI green)
**कुछ merge/deploy नहीं किया। कोई public upload नहीं। कोई खर्च नहीं।**

---

## इस session में असल में जो बना (2 नए features, 229 tests)

### 1. Scheduled publishing (roadmap Phase 9 / goal #17) — पूरा

पहले **कुछ भी नहीं था** (`grep publishAt` → 0 hits)। अब है।

YouTube में scheduler endpoint होता ही नहीं — सिर्फ `status.publishAt` है, और वह **सिर्फ `private` के साथ** चलता है। बीता समय error नहीं देता, **तुरंत publish** कर देता है। इसलिए नियम ऐप में लागू किए:

| नियम | कहाँ लागू | सबूत |
|---|---|---|
| बीता/बहुत नज़दीक का समय reject (5 मिनट lead) | `validateScheduleAt()` | test: past और +2min दोनों reject |
| `public`/`unlisted` + schedule → जबरन `private` | `buildVideoStatus()` | 3 privacy × test, सब `privateStatus: private` |
| गलत format reject (Invalid Date नहीं) | वही | `"kal subah"` → `reason: invalid` |
| Upload से **पहले** 400, bytes जाने से पहले | `/api/youtube/upload` | `code: INVALID_PUBLISH_AT` |
| Preflight में SCHEDULE check | `/api/youtube/upload/preflight` | `✓ निर्धारित: … (private रहेगा)` |
| UI में optional field (दोनों upload paths) | `index.html` | 3 jsdom tests |

**असली payload जो Google को जाता है (helper से सत्यापित):**
```
public   + future → {"privacyStatus":"private","publishAt":"2026-12-05T14:30:00.000Z"}
unlisted + future → {"privacyStatus":"private","publishAt":"2026-12-05T14:30:00.000Z"}
public, no sched  → {"privacyStatus":"public"}                    ← पुराना व्यवहार वैसा ही
```

### 2. Channel analytics (roadmap Phase 11 / goal #18) — पूरा

पहले **कुछ भी नहीं था**। अब `GET /api/youtube/analytics` (read-only, owner-only, कुछ store नहीं).

जो sharp edges खुद संभाले (Google पर नहीं छोड़े):
- `endDate` आज या आगे → **400**, क्योंकि data 24–72 घंटे देर से आता है (वरना "0 views" झूठा लगता)
- उलटी/गलत/366+ दिन की range → अलग-अलग कारण
- `averageViewDuration` को **average** किया, sum नहीं (sum करने पर 2× झूठा आता)
- खाली report = valid जवाब: UI कहता है "कोई डेटा नहीं — यह त्रुटि नहीं है"
- पुरानी connection जिसमें analytics scope नहीं → **409 ANALYTICS_SCOPE_MISSING**, upload चलता रहता है
- बिना connection कोई Google call नहीं

**असली request जो Google को गई (stub से capture):**
```
ids=channel==MINE&startDate=2026-10-29&endDate=2026-11-26
&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained,likes
&dimensions=day&sort=day
→ totals {"views":200,"estimatedMinutesWatched":78,"averageViewDuration":24,"subscribersGained":4,"likes":18}
```
(24 = (25+22)/2 — सही average; 47 नहीं)

### 3. रास्ते में मिला और ठीक हुआ bug
पहला analytics version `readYoutubeSession()` बुला रहा था जो **मौजूद ही नहीं** (असली helper `decryptSession` है) → route `ReferenceError` से crash करता। Route test ने पकड़ा, ठीक किया, अब 409 `CHANNEL_NOT_CONNECTED`।

साथ में: OAuth callback अब **granted scopes** सहेजता है — वरना "इस connection में analytics की अनुमति नहीं" कभी पता ही नहीं चलता।

---

## Test status (असली)

```
npm test  →  229 tests, 228 pass, 0 fail, 1 skipped
GitHub CI →  PASS (1m5s, sha 84f9bc3)
build     →  OK (297.7 KB)
```

| नई test files | tests |
|---|---|
| `test/youtube-schedule.test.js` | 7 |
| `test/ui-schedule.test.js` | 3 |
| `test/youtube-analytics.test.js` | 8 |
| `test/ui-analytics.test.js` | 3 |

skip = opt-in 30-मिनट render (`RUN_LONG_RENDER=1`) — आज नहीं चलाया, pass नहीं कह रहा।

**कोई कमज़ोर assertion नहीं**, `assert.ok(true)` / `todo` / silent-catch कुछ नहीं।

---

## Roadmap की सच्ची स्थिति (13 में से)

| Phase | स्थिति | सबूत / कारण |
|---|---|---|
| 1 Git/PR/security baseline | 🟢 | PR #29, 27 files, CI green, 0 secrets, 0 deletion |
| 2 API config + Gemini provider | 🟡 | code पूरा; **असली key अनसत्यापित** (sandbox में Google तक TLS block) |
| 3 Topic → research → script | 🟢 **नया** | research → project में सेव → script के prompt में inject; असली route चलाया (201 + 10 scenes) |
| 4 Storyboard + scenes | 🟢 | 4 scenes + images + character bible, असली render में सत्यापित |
| 5 Voice/TTS | 🟡 | pipeline असली; असली Hindi TTS अनसत्यापित (key नहीं) |
| 6 Render/FFmpeg/captions | 🟢 | 60s MP4, 1280×720, h264+AAC, decode exit 0 |
| 7 Thumbnail/SEO/quality | 🟢 | thumbnail 1280×720 देवनागरी, SEO 4 tags, blank/corrupt detection |
| 8 OAuth + upload | 🟡 | code पूरा + confirm gate; **channel connect अनसत्यापित** (creds नहीं) |
| 9 Scheduling | 🟢 **नया** | ऊपर — private-only rule + 10 tests |
| 10 Dashboard/queue/retry/logs | 🟢 | MAX_RENDER_JOBS, boot requeue, recovery tests |
| 11 Analytics + सुधार सुझाव | 🟢 **नया** | analytics 11 tests + insights 9 tests + 4 UI tests; कोई अनुमान नहीं |
| 12 Lip-sync / 3D | 🟡 | 2D mouth-sprite (rigged character पर), **full-body 3D नहीं** |
| 13 End-to-end | 🟢 | e2e pipeline test + असली MP4 |
| 14 Production deploy | ⛔ | **आपकी अनुमति नहीं** — merge/deploy नहीं किया |

---

## Phase I — इस pass में जो जुड़ा (commit `27aa353`, CI ✅)

| क्या | सबूत |
|---|---|
| Research brief केवल भरोसेमंद domains से | `wikipedia.org.evil.com` reject; spam blog reject; filtered source → `sourceUrls: []` |
| Brief project में सेव + script में inject | असली route: POST 201, 2/2 तथ्य स्रोत-सहित; story prompt में `VERIFIED RESEARCH BRIEF` + `शाहजहाँ` मिला |
| बिना key → BLOCKED, आधा brief सेव नहीं | 503 `blocked:true`; खराब JSON → 502 और GET 404 (कुछ सेव नहीं) |
| Insights असली आंकड़ों से | 14 दिन × 200 व्यू = 2800 totals, 5 observations, 4 suggestions |
| डेटा कम → कोई सलाह नहीं | <50 व्यू → `enoughData:false`, `suggestions: []`, "कोई अनुमान नहीं" |
| CTR/retention गढ़े नहीं जाते | `notAvailable` में कारण; panel के missing-section में कोई `%` नहीं |
| UI असली server से | jsdom + live HTTP: रिसर्च panel में 2 links (`rel=noopener`), insights 409 पर साफ़ error, खाली panel |
| Regression | 255 tests: **254 pass / 0 fail / 1 skip**; build 62 files 306.2 KB |

असली Google कभी नहीं छुआ — यही इस phase की सबसे बड़ी बाकी कमी है (नीचे)।

---

## जो बाकी है (ईमानदरी से)

1. **असली credentials से एक भी बार चलाना (BLOCKED)** — इस environment में
   `GEMINI_API_KEY`, `YOUTUBE_CLIENT_ID/SECRET`, `APP_SESSION_SECRET` तीनों
   **सेट नहीं** हैं। इसलिए research/insights/upload कभी असली Google तक नहीं गए।
2. **Research में असली वेब सर्च नहीं** — एक text call से तथ्य आते हैं और सिर्फ
   allowlist domains के लिंक रखे जाते हैं। मॉडल का दिया तथ्य बिना स्रोत का हो तो
   "बिना स्रोत" दिखता है, पर उसे खुद fetch करके सत्यापित नहीं किया जाता।
3. **Insights में CTR/retention नहीं** — API वे मेट्रिक्स नहीं देता; UI साफ़ लिखती है।
4. **3D / full-body animation** — अभी 2D mouth-sprite।
---

## आपसे जो चाहिए

- **Merge की अनुमति** (PR #29 — CI green, 27 files, 0 deletion, 0 secret)। नहीं दें तो मैं और features इसी branch पर जोड़ता रहूँगा।
- Deploy के बाद: `/api/health` → **Verify setup** → YouTube connect (channel **ID** से) → एक **private** test upload.
- Analytics के लिए उसी connect से नई अनुमति माँगी जाएगी (scope जुड़ गया) — upload पहले की तरह चलता रहेगा।
