-- Add manual scheduling to existing durable automation jobs.
-- Safe to apply repeatedly; no existing job data is deleted.
alter table if exists public.baba_automation_jobs
  add column if not exists scheduled_at timestamptz;
update public.baba_automation_jobs
  set scheduled_at = created_at
  where scheduled_at is null;
create index if not exists baba_automation_jobs_due
  on public.baba_automation_jobs(status, scheduled_at, created_at);
