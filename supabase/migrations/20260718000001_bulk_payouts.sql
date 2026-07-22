-- Bulk payouts with maker-checker: a batch is created (maker) in
-- pending_approval, then a *different* staff member (checker) approves it,
-- which mints one Push transaction per item. Writes go through the
-- manage-payouts edge function ('settlements' permission), which enforces
-- the maker != checker rule.
create table public.payout_batches (
  id text primary key default ('BAT-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
  name text not null,
  status text not null default 'pending_approval' check (status in ('pending_approval', 'completed', 'rejected')),
  item_count int not null default 0,
  total_cents bigint not null default 0,
  rejection_reason text,
  created_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table public.payout_items (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null references public.payout_batches(id) on delete cascade,
  beneficiary text not null,
  bank text,
  account_masked text not null,
  amount_cents bigint not null check (amount_cents > 0),
  reference text,
  transaction_ref text references public.transactions(ref)
);

alter table public.payout_batches enable row level security;
alter table public.payout_items enable row level security;

create policy "payout_batches_select_authenticated" on public.payout_batches
  for select to authenticated using (true);
create policy "payout_items_select_authenticated" on public.payout_items
  for select to authenticated using (true);
