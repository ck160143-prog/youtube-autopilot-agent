# BABA AI Automated Video Pipeline Upgrade

## Current verified baseline

The existing app already has script/SEO generation, scene-image generation, Hindi TTS, FFmpeg rendering, checkpoint helpers, OAuth connection, and a YouTube upload endpoint. The current renderer accepts only 1–3 still images and produces a narrated slideshow of up to 180 seconds. The app does not yet provide a durable server-side job queue or scheduled publishing workflow. Do not describe the current slideshow as real 3D animation.

## Target user workflow

The user enters a topic and chooses output formats:
- Vertical Shorts (9:16, usually 30–60 seconds)
- Long-form video (16:9, about 5 minutes)
- Both, generated from one original story

Pipeline:
1. Generate a complete original script.
2. Generate SEO (title, description, tags, hashtags, thumbnail concept).
3. Split script into timed scenes with character, dialogue, action, camera framing, and visual prompt.
4. Generate Hindi dialogue audio; allow a different configured voice per character.
5. Generate scene images and, only when a real video provider is configured, moving video clips.
6. Edit and synchronize actual media, narration, captions, and permitted music/SFX.
7. Validate output file and media duration.
8. Prepare upload metadata and let the user choose a future publish time.
9. Upload privately and schedule publication only when OAuth/API supports it and the user explicitly confirms.

## Important implementation constraints

- Inspect and preserve existing routes before edits.
- Never label still-image slideshows as real video or 3D animation.
- Keep provider credentials server-side only.
- Respect API quota and cost limits; no infinite retries.
- Keep successful assets and retry only failed scenes.
- Persist jobs/checkpoints on the server if a durable queue/database is added; browser localStorage alone is not a durable server queue.
- Scheduled publishing requires a real YouTube OAuth session and YouTube Data API permissions. Validate that the selected publish time is in the future and use the API's supported private-video scheduling behavior; return the actual video ID/status.
- Do not auto-publish publicly without explicit user choice. Default to private.
- Clearly label provider/hardware/cost requirements. Do not promise unlimited free video generation.
- Add tests for invalid schedule times, disconnected OAuth, quota failures, upload errors, and successful private upload/scheduling.
- Do not mark a stage complete until the real output exists and has been validated.

## Suggested incremental implementation

### Phase 1: UX and truthful statuses
- Add output-format selection (Shorts, long-form, both).
- Add an optional scheduled publish date/time and timezone label (Asia/Kolkata default for this user-facing app).
- Persist selected preferences with the project checkpoint.
- Correct UI text so image slideshow and true AI video are clearly distinguished.
- Do not show scheduling as available unless backend support is active.

### Phase 2: Upload scheduling
- Extend the upload request with an optional ISO 8601 publish time.
- Validate it server-side and use the supported YouTube API status fields.
- Return video ID, URL, privacy, and scheduled publish time.
- Keep Private as the default and report errors without falsely claiming a schedule was saved.

### Phase 3: Scene-based production
- Store per-scene prompts, assets, durations, dialogue, and status.
- Integrate a real video-generation provider behind a provider adapter.
- Keep the existing slideshow renderer as a clearly named fallback.
- Add resumable jobs and scene-level retry handling.

### Phase 4: Verification
- Run npm test and build.
- Test a short project end-to-end using real configured credentials/providers.
- Verify final MP4 metadata and upload/schedule status.
- Report any steps requiring Render environment variables or external provider credentials.

## Acceptance criteria

- Topic input starts the configured workflow in order.
- Script and SEO are available for editing before upload.
- Each generated scene visibly maps to the relevant dialogue.
- Real video, slideshow, and lip-sync statuses are distinct.
- Scheduling time is validated and the actual API result is shown.
- No public upload occurs without explicit user selection.
- Failed steps retain successful work and explain the specific failure.
