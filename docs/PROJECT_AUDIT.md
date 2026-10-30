# BABA AI Repository Audit

Audit date: 2026-10-30
Repository: `ck160143-prog/youtube-autopilot-agent`
Default branch inspected: `main`

## Scope and evidence
Reviewed the repository root, `README.md`, `package.json`, `server.js`, `index.html`, `render.yaml`, `.env.example`, and `server.test.js`. This is a source inspection only; no production service, Render environment, Google Cloud project, database, or live customer/payment flow was accessed.

## Existing implementation found
- Node.js/Express server, build script, static frontend, and `npm test`.
- Gemini-backed script/SEO, voice and image workflows are described in the README and implemented in the existing server/frontend.
- Google OAuth channel connect/status/disconnect and YouTube Data API upload for an already-rendered video.
- FFmpeg-backed narrated slideshow renderer with documented hosted render duration limit around 180 seconds.
- Image quota handling stops retries on 429; browser-side text-slide fallback is described as text slides, not AI artwork.
- Health endpoint and tests for PCM duration, health response, malformed JSON, invalid render input, missing render job, unknown API route, and inline JS syntax.
- Render Blueprint uses Node, `npm run build`, `npm start`, and `/api/health`.

## Important limitations
- The README explicitly states this is a personal/single-browser app, not a hardened multi-tenant SaaS.
- No durable multi-user CRM database, tenant-isolated customer records, approval queue, persistent automation scheduler, or verified payment/settlement ledger was found in the reviewed top-level implementation.
- OAuth session is encrypted in a browser cookie; clearing cookies or losing the session requires reconnecting.
- Hosted render/upload limits and provider quotas can prevent some operations.
- A source-level inspection does not prove current Render deployment health or external provider configuration.

## Security and operational risks to address before public SaaS use
1. Do not expose the current app as an unrestricted public upload or OAuth service.
2. Do not store customer records in process memory or browser-only storage as the source of truth.
3. Implement authentication, server-side authorization and tenant isolation before adding customer data.
4. Treat payment callbacks as untrusted until signatures and provider state are verified; distinguish payment from settlement.
5. Use CSRF protection where cookie-authenticated state-changing routes require it, and apply rate limits to costly endpoints.
6. Keep all secrets in Render Environment or local untracked `.env`; rotate any exposed credentials.
7. Do not rely on an in-process timer for critical scheduled work on sleeping/ephemeral hosting.
8. Keep production deployment and destructive migrations behind explicit owner approval.

## Recommended sequence
See `IMPLEMENTATION_PLAN.md`. First preserve the current YouTube product and introduce the business OS as a separate, tested module rather than replacing the working app wholesale.
