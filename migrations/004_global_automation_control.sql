-- Global automation controls. Defaults to running to preserve existing worker behavior.
create table if not exists public.baba_automation_control (
  id smallint primary key check (id = 1),
  state text not null default 'running' check (state in ('running','paused','stopped')),
  permanently_stopped boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.baba_automation_control(id,state) values (1,'running')
on conflict (id) do nothing;

alter table if exists public.baba_automation_jobs
  add column if not exists global_pause boolean not null default false;
