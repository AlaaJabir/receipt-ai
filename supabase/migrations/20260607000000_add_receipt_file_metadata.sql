alter table public.receipts
  add column if not exists file_name text,
  add column if not exists file_type text;

notify pgrst, 'reload schema';
