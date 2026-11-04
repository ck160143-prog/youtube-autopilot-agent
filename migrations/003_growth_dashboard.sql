-- Phase 6 growth, monetization inputs and promotion ledger.
-- Creates only new Phase 6-owned tables; does not modify existing job/token records.
create table if not exists public.baba_channel_metrics (
  channel_id text not null,
  snapshot_date date not null,
  subscribers bigint,
  total_views bigint not null default 0,
  video_count bigint not null default 0,
  estimated_minutes_watched numeric(18,2),
  subscribers_gained bigint,
  source text not null default 'youtube_data_api',
  captured_at timestamptz not null default now(),
  primary key(channel_id,snapshot_date)
);
create index if not exists baba_channel_metrics_date_idx
  on public.baba_channel_metrics(channel_id,snapshot_date desc);

create table if not exists public.baba_monetization_inputs (
  channel_id text primary key,
  public_watch_hours numeric(14,2),
  shorts_views_90d bigint,
  notes text,
  updated_at timestamptz not null default now(),
  check (public_watch_hours is null or public_watch_hours >= 0),
  check (shorts_views_90d is null or shorts_views_90d >= 0)
);

create table if not exists public.baba_promotions (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  name text not null,
  promotion_type text not null check (promotion_type in ('sponsorship','affiliate')),
  url text,
  amount numeric(14,2) not null default 0 check (amount >= 0),
  currency char(3) not null default 'INR',
  status text not null default 'planned' check (status in ('planned','active','completed','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists baba_promotions_channel_created_idx
  on public.baba_promotions(channel_id,created_at desc);
