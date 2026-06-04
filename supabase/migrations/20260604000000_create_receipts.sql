create extension if not exists pgcrypto;

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  merchant text,
  transaction_ref text,
  date text,
  category text,
  total numeric,
  currency text default 'MAD',
  ht numeric,
  tva numeric,
  insight text,
  status text default 'Pending Approval',
  file_name text,
  file_type text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.receipts enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_receipts_updated_at on public.receipts;
create trigger set_receipts_updated_at
before update on public.receipts
for each row
execute function public.set_updated_at();

drop policy if exists "Service role can select receipts" on public.receipts;
create policy "Service role can select receipts"
on public.receipts
for select
using (auth.role() = 'service_role');

drop policy if exists "Service role can insert receipts" on public.receipts;
create policy "Service role can insert receipts"
on public.receipts
for insert
with check (auth.role() = 'service_role');

drop policy if exists "Service role can update receipts" on public.receipts;
create policy "Service role can update receipts"
on public.receipts
for update
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "Service role can delete receipts" on public.receipts;
create policy "Service role can delete receipts"
on public.receipts
for delete
using (auth.role() = 'service_role');

create index if not exists receipts_created_at_idx on public.receipts (created_at desc);
create index if not exists receipts_category_idx on public.receipts (category);
create index if not exists receipts_status_idx on public.receipts (status);
create index if not exists receipts_date_idx on public.receipts (date);
