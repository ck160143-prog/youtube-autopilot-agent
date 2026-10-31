# BABA AI Free-First Automated Comedy Pipeline

## User requirements

- User should enter only a topic; the agent should run each configured stage in order until the video is ready for scheduled YouTube publishing.
- Target cadence: 2–3 videos per day, with a configurable daily cap of 3. This is a target, not a guarantee; generation time, API quotas, storage, and YouTube quotas can limit output.
- Free-only: do not call paid providers or enable billing-dependent services by default. Prefer local/open-source tools and free-tier APIs where their terms permit the intended use. Stop and explain if a required stage has no available free option.
- Style reference: use the uploaded creator video only for high-level traits such as energetic comedy pacing, expressive reactions, fast cuts, and camera variety. Create original characters, scripts, scenes, voices, and music; do not clone the creator's exact characters, identity, footage, or soundtrack.
- Desired look: fully animated 3D cartoon comedy. Do not call still images with pan/zoom a 3D animation or a real generated video.

## Verified current baseline

The existing app includes script/SEO generation, scene-image generation, Hindi TTS, FFmpeg rendering, browser checkpoint helpers, OAuth connection, and a YouTube upload endpoint. The current renderer accepts only 1–3 still images and creates a narrated slideshow of up to approximately 180 seconds. No durable server-side job queue or verified scheduled-publishing workflow was established by the current review.

## Topic-only workflow

1. Accept a topic and use saved defaults for language (Hindi), output formats, characters, and publishing preferences.
2. Generate a complete original comedy script with a strong hook, setup, escalating joke, reactions, and payoff.
3. Generate SEO title, description, tags, hashtags, and thumbnail text.
4. Convert the script into timed scenes with dialogue, character actions, camera framing, facial expressions, and visual prompts.
5. Generate Hindi voices. Assign configured voices per character when supported.
6. Generate visuals. Prefer genuinely free/open-source 3D animation or free-tier media tools. Only claim fully animated 3D if the produced assets actually contain character motion. If no free 3D/video provider is configured, stop at that stage with a clear explanation instead of silently substituting a slideshow.
7. Synchronize dialogue, lip movement (only when a compatible tool is configured), scene changes, captions, permitted sound effects, and music.
8. Render and validate MP4; verify duration, resolution, codec, audio stream, and file size.
9. Generate Shorts (9:16, usually 30–60 seconds) and long-form (16:9, about 5 minutes) from the story where resources allow.
10. Prepare upload metadata, then upload privately and schedule publication only after successful OAuth and user-authorized settings. Report the actual video ID, privacy, and publish time. Never claim upload/scheduling succeeded based on a button click alone.

## Daily automation and hand-off

- Implement a sequential state machine: script -> SEO -> scene plan -> voice -> visuals/video -> edit -> validate -> upload/schedule.
- A stage may start only after the previous stage returns a validated artifact and status.
- Keep a configurable daily cap of 3 completed upload jobs; do not start a fourth job that day. Provide clear daily counters and reset based on Asia/Kolkata date.
- Respect YouTube API quota and provider limits. A cap is not a promise that 3 videos can always be generated.
- Save state after every stage; resume after restart; retry only failed stages with bounded retries.
- Use durable server-side storage/queue for unattended jobs. Browser localStorage alone is not reliable for server-side automation.
- Keep provider credentials on the server. Never expose secrets in frontend code or logs.
- Keep uploads Private by default; scheduling/public visibility must follow the real YouTube API requirements and explicit user settings.

## Free-only guardrails

- No paid API or paid model calls without explicit opt-in.
- Do not claim a provider is unlimited or free unless its current plan and terms support that usage.
- Local Blender rendering can be free software but requires suitable compute and is not automatically fast on a low-resource Render instance or phone.
- Open-source local TTS/animation tools may require a separate computer or GPU; document actual hardware requirements.
- If a stage cannot run for free in the configured environment, preserve completed work and show exactly which stage is blocked, why, and what free local alternative is possible.
- Avoid downloading/reusing copyrighted creator videos, characters, voices, or music as production assets.

## Incremental implementation

### Phase 1: truthful UI and preferences
- Add saved topic-only defaults and format selection (Shorts, long-form, both).
- Add a daily counter/cap of 3, using a server-persisted record if the service is to run unattended.
- Clearly distinguish still-image slideshow, moving AI video, and actual 3D animation.
- Show stage-by-stage status and preserve successful assets.
- Do not show scheduling as enabled until backend support is implemented.

### Phase 2: reliable pipeline
- Add a durable job queue/state store, idempotency, bounded retries, and resume support.
- Pass each stage's real output to the next stage.
- Add per-scene status, prompt, media path, duration, and dialogue metadata.
- Keep the existing slideshow renderer as a clearly labeled fallback only.

### Phase 3: scheduling and upload
- Validate a future publish time and timezone on the server.
- Use supported YouTube Data API privacy/scheduling fields only after OAuth is connected.
- Return the actual video ID, privacy, URL, and publish time.
- Handle quota errors and disconnected OAuth without false success messages.

### Phase 4: real 3D feasibility and testing
- Inspect what free animation/video tools can actually run in the deployment environment.
- Integrate a free local 3D pipeline only if the hardware can support it; otherwise document a realistic external/local setup rather than promising impossible Render performance.
- Test invalid schedules, OAuth failures, quota exhaustion, interrupted jobs, output validation, and successful private scheduling.
- Run `npm test` and `npm run build`; test with real configured providers before claiming completion.

## Acceptance criteria

- Topic-only input starts the configured workflow with saved defaults.
- Every stage hands validated outputs to the next stage.
- A daily cap of 3 is enforced and visible.
- No paid provider is called by default.
- Slideshow, video clips, true 3D animation, and lip-sync are truthfully distinguished.
- Shorts and long-form outputs are supported where the configured free pipeline can produce them.
- Upload/scheduling status comes from the real API result.
- No public upload occurs without explicit authorization.
- Failed stages retain successful work and explain the blocker.
