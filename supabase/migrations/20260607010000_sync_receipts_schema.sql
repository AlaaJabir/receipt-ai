alter table public.receipts
  add column if not exists merchant text,
  add column if not exists transaction_ref text,
  add column if not exists date text,
  add column if not exists category text,
  add column if not exists total numeric,
  add column if not exists currency text default 'MAD',
  add column if not exists ht numeric,
  add column if not exists tva numeric,
  add column if not exists insight text,
  add column if not exists status text default 'Pending Approval',
  add column if not exists file_name text,
  add column if not exists file_type text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

notify pgrst, 'reload schema';
