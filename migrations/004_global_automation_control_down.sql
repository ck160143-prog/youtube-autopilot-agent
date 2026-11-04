alter table if exists public.baba_automation_jobs drop column if exists global_pause;
-- Removes only the global Phase 6 control objects.
drop table if exists public.baba_automation_control;
