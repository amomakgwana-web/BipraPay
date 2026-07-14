-- Merchants: the multi-tenant root. transactions.merchant_id was a free-text
-- field with no backing table; this adds the real one and a FK.
create table public.merchants (
  id text primary key,
  name text not null,
  mcc text,
  status text not null default 'active' check (status in ('pending','active','suspended','closed')),
  fee_bps int not null default 190 check (fee_bps >= 0),
  risk text not null default 'low' check (risk in ('low','medium','high')),
  created_at timestamptz not null default now()
);

alter table public.merchants enable row level security;

create policy "merchants_select_authenticated" on public.merchants
  for select to authenticated using (true);
create policy "merchants_insert_authenticated" on public.merchants
  for insert to authenticated with check (true);
create policy "merchants_update_authenticated" on public.merchants
  for update to authenticated using (true);

insert into public.merchants (id, name, mcc, status, fee_bps, risk) values
  ('MRC-00142', 'Sipho''s Electronics', '5999', 'active', 190, 'low'),
  ('MRC-00141', 'Cape Town Eats', '5812', 'active', 210, 'low'),
  ('MRC-00140', 'Zanele Fashion', '5621', 'active', 190, 'medium'),
  ('MRC-00139', 'Priya Tech Solutions', '7372', 'pending', 170, 'low'),
  ('MRC-00138', 'Unknown Ventures', '5999', 'suspended', 0, 'high')
on conflict (id) do nothing;

alter table public.transactions
  add constraint transactions_merchant_id_fkey foreign key (merchant_id) references public.merchants(id);
