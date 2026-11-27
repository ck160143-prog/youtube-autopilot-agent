# Render deployment checklist (deploy नहीं किया गया)

> `render.yaml` और कोड पढ़कर बनाया गया; असली Render account तक पहुँच नहीं है,
> इसलिए जहाँ "dashboard पर देखें" लिखा है वहाँ सत्यापन आपको करना है।

## 1. Service shape

| मद | मान | जाँच |
|---|---|---|
| नाम | `youtube-autopilot-agent-1` | Blueprint sync इसी नाम से मौजूदा service अपनाता है; नाम बदला तो **दूसरी service** बन जाएगी |
| Plan | free | 512 MB RAM, ephemeral disk |
| Branch | `main` | PR preview अलग होते हैं; production main से |
| Build | `npm ci --omit=dev && npm run build` | PR #30 में बदला; `jsdom` production पर नहीं जाएगा |
| Start | `npm start` (`node server.js`) | ✅ |
| Health | `/api/health` | auth-free, हमेशा 200 (liveness) — readiness `ready:false` से अलग बताई जाती है |

## 2. ज़रूरी environment variables

| Variable | क्यों | न हो तो |
|---|---|---|
| `GEMINI_API_KEY` | कहानी/तस्वीर/आवाज़ | `ready:false`, सब generation BLOCKED |
| `YOUTUBE_CLIENT_ID` | OAuth | connect/upload/analytics बंद |
| `YOUTUBE_CLIENT_SECRET` | OAuth | वही |
| `YOUTUBE_REDIRECT_URI` | OAuth callback | वही (Google Console में **यही** URL होना चाहिए) |
| `APP_SESSION_SECRET` (≥32 अक्षर) | OAuth token cookie AES-GCM | connect बंद |
| `APP_REGISTRATION_KEY` | पहले account के बाद नए account | दूसरा user नहीं बनेगा |

वैकल्पिक: `GEMINI_*_MODEL`, `GOOGLE_TIMEOUT_MS` (default 20000), `UPLOAD_TIMEOUT_MS` (default 900000), `FFMPEG_PRESET`, `DATA_DIR`, `DEFAULT_YOUTUBE_CATEGORY_ID`.

## 3. OAuth callback

1. Google Cloud Console → OAuth Web Client.
2. Authorized redirect URI **बिल्कुल**: `https://<service>.onrender.com/api/youtube/callback`
3. उसी value को Render में `YOUTUBE_REDIRECT_URI` बनाएँ (एक अक्षर का फ़र्क भी fail करेगा)।
4. Scope शामिल: `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly` — तीनों एक ही consent में माँगे जाते हैं।

## 4. Storage — सबसे बड़ा जोखिम

- free plan का filesystem **ephemeral** है: हर deploy/restart पर `data/` (users, sessions, projects, renders) **मिट जाता है**।
- **मापा गया:** 1-मिनट का एक प्रोजेक्ट **7.5 MB** (render 6.9 MB + scenes 0.6 MB)। 10 वीडियो ≈ 75 MB।
- विकल्प: (a) Render Disk attach + `DATA_DIR=/var/data` (paid), (b) storage को S3/Postgres पर ले जाना (कोड बदलाव चाहिए)।
- **इसके बिना production उपयोग नहीं करना चाहिए।**

## 5. RAM और render सीमा

- 512 MB पर `MAX_RENDER_JOBS = 2`; तीसरा request 429।
- mock 1-मिनट render: **18 सेकंड**। असली 10 images + TTS के साथ ज़्यादा।
- 30-मिनट render का असली test opt-in है (`RUN_LONG_RENDER=1`) — free plan पर OOM का जोखिम; पहले 1-मिनट से शुरू करें।

## 6. Google API quota (₹0 लक्ष्य)

| सीमा | असर |
|---|---|
| Gemini free tier (text/image/TTS) | समाप्त होने पर 429; ऐप साफ़ संदेश देता है, retry loop नहीं |
| YouTube Data API 10,000 units/day | upload ~1600 units प्रति video → ~6 upload/day |
| Analytics reports.query | अलग quota; 24–72 घंटे data lag (नया चैनल खाली दिखेगा — यह त्रुटि नहीं) |

## 7. सुरक्षा — deploy के समय जाँचें

| मद | अपेक्षा |
|---|---|
| Cookie | `HttpOnly; SameSite=Lax`, `NODE_ENV=production` से `Secure` |
| CSRF | cross-site origin reject |
| `/api/setup` | बिना auth 401 (जाँचा गया) |
| Secrets | सिर्फ़ Render Environment में; repo/log में नहीं |
| Rate limit | in-memory — single instance पर ही सही |
| `data/sessions.json` | live session ids plaintext — disk access वाले को मिल सकते हैं |

## 8. खर्च

- Render free: **$0**, पर हर 15 मिनट inactivity पर sleep (पहला request धीमा) और disk ephemeral।
- Gemini free tier: **$0** जब तक quota के अंदर।
- YouTube API: **$0** (कोटा-आधारित)।
- **कोई paid plan, disk या billing enable नहीं करना है** जब तक आप कहें।

## 9. Deploy के बाद पहले 10 मिनट

1. `GET /api/health` → 200, `blocked` में कुछ नहीं।
2. `GET /` → dashboard खुले।
3. पहला account बनाएँ (`APP_REGISTRATION_KEY` के साथ)।
4. **Verify setup** → model status।
5. YouTube connect → channel नाम सही दिखे।
6. `GET /api/youtube/insights` → नए चैनल पर "डेटा कम है" (त्रुटि नहीं)।
7. एक 1-मिनट वीडियो **private** बनाएँ (upload नहीं)।
8. Logs में कोई secret/stack न दिखे।
