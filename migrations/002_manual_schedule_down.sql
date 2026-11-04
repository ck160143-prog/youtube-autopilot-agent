-- Safe rollback: remove the lookup index but retain scheduled_at values.
-- The column is intentionally preserved so a rollback cannot erase user-selected schedules.
drop index if exists public.baba_automation_jobs_due;
