-- BipraPay acts as its own processor: it never stores or transmits a raw PAN/CVV
-- beyond the single tokenisation call. This is the vault — only token, brand,
-- last4, bin and a one-way fingerprint are ever persisted. Only the
-- vault-tokenize edge function (service role) writes here.
create table public.payment_methods (
  id text primary key default ('tok_' || replace(gen_random_uuid()::text, '-', '')),
  merchant_id text references public.merchants(id),
  brand text not null,
  last4 text not null,
  bin text not null,
  exp_month smallint not null check (exp_month between 1 and 12),
  exp_year smallint not null,
  fingerprint text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index payment_methods_fingerprint_idx on public.payment_methods (fingerprint);

alter table public.payment_methods enable row level security;

create policy "payment_methods_select_authenticated" on public.payment_methods
  for select to authenticated using (true);

-- Transactions now reference a vault token instead of ever carrying card data,
-- and record the 3DS2 outcome BipraPay's own risk engine decided on.
alter table public.transactions
  add column payment_method_id text references public.payment_methods(id),
  add column three_ds_status text check (three_ds_status in ('frictionless','challenge_required','challenge_passed','challenge_failed'));
