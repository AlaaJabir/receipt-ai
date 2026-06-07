create extension if not exists pgcrypto;

alter table public.receipts
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists merchant text,
  add column if not exists category text,
  add column if not exists status text default 'Pending Approval',
  add column if not exists receipt_date date,
  add column if not exists original_currency text,
  add column if not exists original_total numeric,
  add column if not exists original_ht numeric,
  add column if not exists original_tva numeric,
  add column if not exists display_currency text,
  add column if not exists converted_total numeric,
  add column if not exists converted_ht numeric,
  add column if not exists converted_tva numeric,
  add column if not exists exchange_rate numeric,
  add column if not exists exchange_rate_date date,
  add column if not exists exchange_rate_source text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.receipts
set
  id = coalesce(id, gen_random_uuid()),
  status = coalesce(status, 'Pending Approval'),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now());

create unique index if not exists receipts_id_unique_idx on public.receipts (id);
create index if not exists receipts_user_id_idx on public.receipts (user_id);
create index if not exists receipts_receipt_date_idx on public.receipts (receipt_date desc);

notify pgrst, 'reload schema';
