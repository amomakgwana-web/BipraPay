-- Settlement/reconciliation ledger: batches unsettled approved transactions
-- per merchant into a payable settlement, computing fees from the
-- merchant's own fee_bps. Only run-settlement (service role) writes.
create table public.settlements (
  id text primary key default (
    'STL-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)
  ),
  merchant_id text not null references public.merchants(id),
  batch_date date not null default current_date,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  txn_count int not null default 0,
  gross_amount_cents bigint not null default 0,
  fee_amount_cents bigint not null default 0,
  net_amount_cents bigint not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table public.settlement_items (
  id uuid primary key default gen_random_uuid(),
  settlement_id text not null references public.settlements(id) on delete cascade,
  transaction_ref text not null references public.transactions(ref),
  amount_cents bigint not null,
  fee_cents bigint not null,
  net_cents bigint not null
);

alter table public.transactions add column settlement_id text references public.settlements(id);

alter table public.settlements enable row level security;
alter table public.settlement_items enable row level security;

create policy "settlements_select_authenticated" on public.settlements
  for select to authenticated using (true);
create policy "settlement_items_select_authenticated" on public.settlement_items
  for select to authenticated using (true);
