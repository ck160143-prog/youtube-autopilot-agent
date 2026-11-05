# BABA AI Phase 6 — Creator Growth & Monetization Feature Scope

This document converts the user's six reference images into implementation requirements for the existing BABA AI YouTube Automation System. It is an additive scope for PR #22; it does not authorize a separate demo app, production deployment, production database migration, PR merge, or public YouTube publishing.

## Product goal

BABA AI should act as a Hindi-first YouTube channel operations assistant: research topics, create rights-aware faceless content, prepare and schedule videos, measure real channel performance, recommend improvements, and track monetization opportunities. Automation must remain observable, restart-safe, permission-aware, and honest about unavailable providers or incomplete work.

## 1. Channel onboarding and channel profile

- Show the authenticated channel identity and connection state; preserve the existing GajabGuru OAuth connection and encrypted session.
- Collect channel language, country, timezone, target audience, content categories, preferred formats, brand voice, visual style, upload defaults, and daily publishing limit.
- Provide setup progress and validate required configuration without displaying secrets.
- Do not claim a channel is connected based only on a local UI flag; use the authenticated YouTube API identity.

## 2. Niche and topic research

- Combine current YouTube search/trend signals, recent public-video metadata, channel history, and optional Google Trends/provider data when configured.
- Show evidence separately from AI-generated qualitative estimates: query, retrieval time, sample size, published dates, views, and source links where available.
- Score candidate niches on audience fit, content repeatability, competition signals, production cost, and monetization suitability. Never present an estimated score as verified RPM, revenue, or guaranteed demand.
- Allow the agent to choose the next topic automatically from approved channel preferences, while retaining a manual override and a record of why the topic was selected.
- Avoid duplicate/recently covered topics and respect blocked topics and rights/safety constraints.

## 3. Faceless content formats and production

- Support Shorts and long-form workflows as separate output profiles, including aspect ratio, pacing, hook, CTA, caption layout, thumbnail treatment, and metadata.
- Preserve the existing Hindi script, voice, image, caption, thumbnail, FFmpeg and upload pipeline.
- Add duration profiles of 5, 10, 15 and 30 minutes only when the renderer can actually produce and validate the requested duration. Until then, mark unsupported full-length rendering as unavailable; never pad a short preview and call it a full video.
- Distinguish still-image narrated video, motion graphics, 3D character animation, and lip-sync. Do not claim genuine 3D animation or dialogue lip-sync unless a real renderer/animation provider is integrated and tested.
- Retain successful scene assets and retry only failed stages/scenes. Enforce provider quota cooldowns and avoid repeated 429 calls.
- Generate a thumbnail candidate and SEO title/description/tags/hashtags; allow user review before upload.

## 4. Smart publishing calendar

- Recommend posting times from the channel's own audience/activity and historical performance data when available. If not available, label suggested times as initial hypotheses and learn from subsequent analytics.
- Use the channel's configured IANA timezone for calendar display, date boundaries, daily caps, daylight-saving transitions, and scheduled uploads.
- Enforce a maximum of three video jobs per channel per local calendar day transactionally, with idempotency and duplicate-job protection.
- Support immediate queueing and future scheduled jobs; worker claims only due jobs and recovers safely after restarts.
- Keep upload visibility explicit: Private, Unlisted, or Public. Private is the default for test uploads. Public publishing requires a separate explicit user authorization; never infer consent from a schedule.
- Do not automatically publish to TikTok, Facebook, or Instagram as part of this YouTube-only scope. Treat cross-platform publishing as a later optional integration requiring separate provider OAuth, platform-specific media/rights checks, and user approval.

## 5. Growth dashboard and 0-to-1,000 journey

- Display real YouTube channel totals and date-ranged views, watch time/minutes, subscriber gains/losses, video count, and available retention/CTR metrics.
- Clearly label source, reporting period, refresh time, unavailable metrics, and API permission requirements. Never fabricate or extrapolate missing analytics as actual results.
- Provide a 0-to-1,000 subscriber progress view as a goal tracker, not a promise or guaranteed timeline.
- Recommend experiments based on actual performance: hook, title/thumbnail, topic cluster, length, format, retention drop-off, and upload cadence.
- Provide a content calendar and a weekly review that selects the next experiment; keep historical snapshots so changes can be compared.

## 6. Monetization and income tracking

- Track YouTube Partner Program eligibility against current official YouTube rules and the relevant country/program tier. Show each requirement, observed value, source, and last-checked date. Do not hardcode infographic thresholds as universal/current.
- Distinguish eligibility progress from approval, monetized playback, and actual revenue. Revenue data must come from an authorized YouTube/AdSense source or be explicitly marked as manually entered.
- Track sponsorship and affiliate opportunities, brand/contact, status, deliverables, links, agreed amount, received amount, currency, and payment date.
- Provide optional tracking for memberships, Super Thanks, merchandise, and digital products, but do not imply these features are enabled or available to a channel unless YouTube/account eligibility and the relevant product integration confirm it.
- Keep forecasts and niche earning estimates visibly separate from received income. Never guarantee views, subscribers, monetization approval, or earnings.

## 7. Controls, auditability and safety

- Preserve Start, Pause, Resume, Retry Failed Step, and irreversible Permanent Stop semantics.
- Show job stages, timestamps, retries, provider errors, artifact links, upload visibility, and final YouTube video ID only when returned by the real API.
- Keep PostgreSQL queue state durable and restart recoverable; keep generated media in private Supabase storage.
- Never expose OAuth tokens, API keys, database URLs, or Supabase service keys in frontend bundles, logs, exports, or user-facing error messages.
- Keep approval gates for migrations, Render production changes, PR merge, and public uploads.

## 8. Acceptance criteria

- Existing working routes, GajabGuru identity/session, and PR #21 functionality remain intact.
- Tests cover channel profile/timezone validation, local-day scheduling boundaries, three-per-local-day concurrency, DST boundary behavior, idempotency, smart-time fallback labels, analytics source/period labels, monetization rule versioning, and promotion ledger persistence.
- End-to-end tests use test credentials and a dedicated test channel/database/storage bucket; no live public video is published.
- Every feature is reported as implemented only after code, tests, and real provider evidence support the claim.
- CI runner allocation must be diagnosed independently; empty job steps are not treated as test execution.

## Implementation order

1. Reconcile existing code and migrations with this scope; do not duplicate features already implemented.
2. Fix channel timezone and local-day scheduling semantics with tests.
3. Complete and verify the duration-aware renderer and media-format profiles.
4. Improve evidence-based topic/niche selection and analytics-driven posting recommendations.
5. Complete the growth/monetization dashboard and audit trail.
6. Run local checks and safe test-environment integrations; then request user approval for any production-only action.

