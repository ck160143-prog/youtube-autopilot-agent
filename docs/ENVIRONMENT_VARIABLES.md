# Environment Variables

Never put real secret values in GitHub, issue comments, screenshots, or chat. Configure secrets in Render Dashboard → service → Environment. The checked-in `.env.example` contains placeholders only.

| Variable | Purpose | Required when |
|---|---|---|
| `NODE_ENV` | Production behavior | Render deployment |
| `GEMINI_API_KEY` | Gemini API authentication | AI script/SEO/image/voice features |
| `GEMINI_SCRIPT_MODEL` | Script model selection | Optional override |
| `GEMINI_IMAGE_MODEL` | Image model selection | Optional override |
| `GEMINI_TTS_MODEL` | Text-to-speech model selection | Optional override |
| `YOUTUBE_CLIENT_ID` | Google OAuth client ID | YouTube connection/upload |
| `YOUTUBE_CLIENT_SECRET` | Google OAuth client secret | YouTube connection/upload |
| `YOUTUBE_REDIRECT_URI` | Exact OAuth callback URL | YouTube connection/upload |
| `APP_SESSION_SECRET` | Encrypts OAuth session data | YouTube OAuth session |

## Setup checklist
1. Use Render Environment settings, not source code.
2. Generate `APP_SESSION_SECRET` using Node.js: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Set `YOUTUBE_REDIRECT_URI` to the exact public callback URL and add the identical URL in Google Cloud OAuth settings.
4. Save/redeploy and inspect health status without printing secrets.
5. If a secret was committed or shared, rotate it at the provider and update Render.

No CRM database or payment-gateway environment variables are declared as part of this initial foundation. Add them only after the selected architecture/provider is implemented and documented.
