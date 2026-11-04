-- Refuse rollback if the global control state or paused-job markers contain live state.
do $$
begin
  if exists (select 1 from public.baba_automation_jobs where global_pause = true) then
    raise exception 'Jobs are paused by global control; resume/reconcile them before rollback';
  end if;
  if exists (select 1 from public.baba_automation_control where permanently_stopped = true or state <> 'running') then
    raise exception 'Global automation control is not in its default running state; reconcile before rollback';
  end if;
end $$;
alter table if exists public.baba_automation_jobs drop column if exists global_pause;
drop table if exists public.baba_automation_control;
