alter table public.receipts
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
  add column if not exists exchange_rate_source text;

update public.receipts
set
  receipt_date = coalesce(receipt_date, case when date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then date::date end),
  original_currency = coalesce(original_currency, currency),
  original_total = coalesce(original_total, total),
  original_ht = coalesce(original_ht, ht),
  original_tva = coalesce(original_tva, tva)
where
  original_currency is null
  or original_total is null
  or original_ht is null
  or original_tva is null;

notify pgrst, 'reload schema';
