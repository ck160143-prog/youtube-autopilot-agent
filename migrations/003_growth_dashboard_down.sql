-- Refuse destructive rollback while growth, monetization or promotion records exist.
do $$
begin
  if exists (select 1 from public.baba_channel_metrics limit 1)
     or exists (select 1 from public.baba_monetization_inputs limit 1)
     or exists (select 1 from public.baba_promotions limit 1) then
    raise exception 'Phase 6 growth tables contain user data; export/archive it before rollback';
  end if;
end $$;
drop table if exists public.baba_promotions;
drop table if exists public.baba_monetization_inputs;
drop table if exists public.baba_channel_metrics;
