-- Store the channel timezone used for the local-calendar daily upload cap.
-- Existing jobs retain UTC semantics until a channel timezone is explicitly supplied.
ALTER TABLE public.baba_automation_jobs
  ADD COLUMN IF NOT EXISTS channel_timezone TEXT NOT NULL DEFAULT 'UTC';

CREATE INDEX IF NOT EXISTS baba_automation_jobs_channel_schedule
  ON public.baba_automation_jobs(owner_channel_id, channel_timezone, scheduled_at)
  WHERE status <> 'cancelled';
