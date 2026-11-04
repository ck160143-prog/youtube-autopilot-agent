-- Roll back only the Phase 6 growth tables introduced by 003.
drop table if exists public.baba_promotions;
drop table if exists public.baba_monetization_inputs;
drop table if exists public.baba_channel_metrics;
