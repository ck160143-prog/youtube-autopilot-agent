-- Revert only the manual scheduling column/index added by 002.
drop index if exists public.baba_automation_jobs_due;
alter table if exists public.baba_automation_jobs
  drop column if exists scheduled_at;
