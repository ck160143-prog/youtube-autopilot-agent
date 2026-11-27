# Pre-merge audit — सच्चाई के साथ

**तारीख:** 27 नवंबर 2026 · **Branch:** `arena/9e73f06f-youtube-autopilot-agent`
**आधार:** `origin/main` = merge commit `ad04bad` (PR #29)

---

## 1. वर्तमान Git स्थिति

| | |
|---|---|
| Local HEAD | `ad04bad` (= `origin/main`) |
| Working tree | 8 files modified (सिर्फ़ मेरे fixes), 2 पुरानी report files untracked |
| Uncommitted changes | **हाँ — 8 files, +130/−24** (commit नहीं किया, आपकी अनुमति का इंतज़ार) |
| खोई हुई file/commit | **कोई नहीं** — हर file `origin/main` से hash-दर-hash मेल खाती है |

> शुरू में local HEAD गलत commit `06427ae` पर अटका था और `origin/main` clone में नहीं था।
> मैंने **कोई file delete/overwrite नहीं की**; पहले hash-compare से साबित किया कि worktree
> `origin/main` जैसा ही है, फिर सिर्फ़ git pointer `git reset --mixed origin/main` से सही किया
> (कोई commit नहीं गया, कोई commit नहीं बना, force-push नहीं)।

## 2. PR #29 की स्थिति

| | |
|---|---|
| स्थिति | **CLOSED + MERGED** — आपने 2026-11-27 14:09 UTC पर merge किया |
| Merge commit | `ad04bad` (merge, fast-forward नहीं) |
| Head commit | `2cb67fec…` (branch का आखिरी commit, history में मौजूद) |
| Branch | GitHub से delete हो चुकी (`arena/…` अब remote पर नहीं) |
| नया PR | **नहीं बनाया** (निर्देशानुसार duplicate नहीं) |

**इसका मतलब:** "pre-merge audit" अब तकनीकी रूप से **post-merge audit** है। मेरे fixes
`main` के ऊपर uncommitted हैं — इन्हें लाने के लिए एक नई branch/PR चाहिए होगी, और वह
आपकी अनुमति के बाद ही।

## 3. Audit के नतीजे (36 files)

### ✅ जो ठीक मिला (जाँच करके, दावे से नहीं)

| क्षेत्र | क्या जाँचा |
|---|---|
| Session security | scrypt password hash (timing-safe), 32-byte random session id, `HttpOnly; SameSite=Lax`, production में `Secure`, 24h TTL |
| CSRF | cross-site `Origin` reject + per-session token + `Sec-Fetch-Site`; GET exempt |
| OAuth token storage | AES-256-GCM encrypted cookie, 12-byte IV, auth tag verify, secret ≥32 chars ज़रूरी |
| Ownership | हर project route पर `ownerId` जाँच → 403 `FORBIDDEN`, 404 से existence leak नहीं |
| Secrets | `safeLog` redaction, `/api/setup` 401 (auth के बिना), zip में कोई `.env`/key नहीं |
| Input validation | `publishAt` (RFC 3339 + 5-मिनट lead), categoryId/tags, analytics range, project topic |
| Research sources | domain allowlist + suffix match (`wikipedia.org.evil.com` reject), de-dup, cap |
| XSS | client rendering `textContent`/`escapeHtml`; `innerHTML` सिर्फ़ static strings |
| Dependencies | `npm audit` → **0 vulnerabilities** (4 deps, 1 devDep) |
| Concurrency | `MAX_RENDER_JOBS = 2` → तीसरा render 429 |
| Queue/recovery | boot पर `recoverInterrupted()`, stage-दर-stage resume |

### 🐞 जो असली bug मिले (4) और एक production सुधार (1)

| # | गंभीरता | समस्या | कैसे पकड़ा |
|---|---|---|---|
| **B1** | **उच्च** | `enoughData:false` होने पर भी सुझाव निकलते थे — 21 व्यूज़ पर "series बनाएँ" | 14-दिन का 21-व्यू dataset चलाया |
| **B2** | **उच्च** | Google के 7 network calls में कोई deadline नहीं — hang होने पर request हमेशा अटकती | `grep fetch(` vs `AbortSignal` |
| **B3** | मध्यम | `AbortSignal.timeout` error `isNetworkError` में नहीं पकड़ा जाता → झूठा "502 server error" | timeout error का shape बनाकर |
| **B4** | मध्यम | research के तथ्य prompt में verbatim → नईलाइन + `SYSTEM:` से नकली instruction line | injection payload से |
| **B5** | निम्न | `npm ci` production पर `jsdom` (dev-only) भी install करता | `package.json` + `render.yaml` |

## 4. बदली गई files (8)

| File | बदलाव |
|---|---|
| `lib/insights.js` | एक `sufficientViews` gate + return पर hard guard |
| `lib/research.js` | `clipOneLine()` (single-line, bullet-safe) + prompt में "data, not instructions" |
| `server.js` | `googleFetch()` deadline helper (7 calls) + timeout classification |
| `render.yaml` | `npm ci --omit=dev` |
| `.env.example` | `GOOGLE_TIMEOUT_MS` documented |
| `test/insights.test.js` | +2 tests (thin data पर 0 सुझाव; असली trend पर सुझाव) |
| `test/research.test.js` | +1 test (prompt forgery रुकती है) |
| `test/network-error.test.js` | +1 test (timeout = unreachable) |

## 5. Tests — असली परिणाम

| | पहले | बाद |
|---|---|---|
| Suite | 255 tests · 254 pass · 1 skip | **259 tests · 258 pass · 0 fail · 1 skip** |
| नए regression tests | — | 4 (सभी पुराने कोड पर **fail** होकर साबित हुए) |
| Build | OK 62 files 306.2 KB | **OK 62 files 307.3 KB** |
| `npm audit` | 0 | **0** |
| e2e pipeline (असली FFmpeg) | 2/2 pass | **2/2 pass** |
| 60-सेकंड वीडियो | — | **बना, decode साफ़, download बाइट-बराबर** |

**पहली बार suite लाल थी (25 files fail)** — कारण code नहीं, `node_modules` गायब था।
`npm ci --ignore-scripts` करना पड़ा और `ffmpeg-static` का binary download TLS-verify
fail होने से नहीं आया; असली FFmpeg `imageio-ffmpeg` (venv) से दिया गया। यह साफ़ लिखा
जा रहा है ताकि "सब हरा था" का झूठा दावा न हो।

## 6. Build और startup

- `npm run build` → `dist/index.html` + zip, **62 files, 307.3 KB**; zip में `lib/research.js`, `lib/insights.js` शामिल; कोई secret नहीं।
- असली server start → `GET /api/health` **200** `{status:"ok", ready:false, blocked:["GEMINI_API_KEY"]}` (ईमानदार)।
- `GET /` **200** (160 KB dashboard), `GET /api/setup` **401** auth के बिना।
- Production-jaisa install (`npm ci --omit=dev`) से server चलकर health 200 देता है ✅ (B5 सत्यापित)।

## 7. Security — बाकी जोखिम (छिपाए नहीं)

1. **Render free plan का disk ephemeral है** → users/sessions/projects हर deploy पर मिट जाते हैं। `DATA_DIR` Disk के बिना production data टिकाऊ नहीं। *(Blocker)*
2. **in-memory rate limiter** single instance पर ही काम करता है; scale-out पर नहीं।
3. **`/api/setup`** में infra details हैं — अभी 401 से सुरक्षित, पर auth लागू रहे यह ध्यान रखना ज़रूरी।
4. **Session file में sessions plaintext JSON** हैं (सेक्रेट token नहीं, पर live session ids) — disk access वाले को मिल सकते हैं।
5. **`APP_REGISTRATION_KEY`** के बिना पहले account के बाद नए account नहीं बन सकते (सुरक्षित default, पर setup में याद रखें)।

## 8. असली vs mock — साफ़ ब्यौरा

| असली (network/OS) | Mock |
|---|---|
| FFmpeg render, decode, MP4 streams, duration, SRT, download bytes | Gemini text/image/TTS (deterministic fake) |
| HTTP server, sessions, CSRF, ownership, rate limit | YouTube OAuth/upload/analytics (कोई credential नहीं) |
| File system persistence, zip build | — |

## 9. Deployment blockers (Render)

| # | Blocker | असर |
|---|---|---|
| 1 | `GEMINI_API_KEY` सेट नहीं | कहानी/तस्वीर/आवाज़ बंद (`ready:false`) |
| 2 | `YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI` नहीं | connect/upload/analytics बंद |
| 3 | `APP_SESSION_SECRET` (≥32) नहीं | OAuth cookie encryption बंद |
| 4 | `APP_REGISTRATION_KEY` नहीं | दूसरा account नहीं बन सकेगा |
| 5 | Disk नहीं (free plan) | deploy पर data मिटेगा |
| 6 | 512 MB RAM | लंबे/30-मिनट render पर OOM जोखिम; 1-मिनट वाला 18s में चला |

## 10. अगला सुझाया काम

1. **पहले** इन 8 files को एक नई branch + PR पर ले जाना (आपकी अनुमति से) — कोड `main` से आगे नहीं बढ़ रहा जब तक commit न हो।
2. Render पर असली `GEMINI_API_KEY` + OAuth के साथ **एक private 1-मिनट test** — यही एकमात्र तरीका है असली AI/OAuth को verify करने का।
3. Disk attach या storage को बाहर (S3/Postgres) ले जाना — वरना हर deploy पर सारा काम मिटेगा।
