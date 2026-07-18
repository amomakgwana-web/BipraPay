-- Recurring billing: plans and subscriptions. Writes go through the
-- manage-subscription edge function ('transactions' permission); the
-- cron-driven billing-run function charges due subscriptions against
-- their stored vault token and drives the dunning lifecycle
-- (active -> past_due -> cancelled after 4 failed attempts).
create table public.billing_plans (
  id text primary key default ('PLN-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  name text not null,
  code text unique not null,
  amount_cents bigint not null check (amount_cents > 0),
  frequency text not null default 'monthly' check (frequency in ('weekly', 'monthly', 'quarterly', 'annually')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id text primary key default ('SUB-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  plan_id text not null references public.billing_plans(id),
  merchant_id text not null references public.merchants(id),
  customer_name text not null,
  payment_method_id text not null references public.payment_methods(id),
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled')),
  next_billing_at timestamptz not null default now(),
  failed_attempts int not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create index subscriptions_due_idx on public.subscriptions (next_billing_at)
  where status in ('active', 'past_due');

alter table public.billing_plans enable row level security;
alter table public.subscriptions enable row level security;

create policy "billing_plans_select_authenticated" on public.billing_plans
  for select to authenticated using (true);
create policy "subscriptions_select_authenticated" on public.subscriptions
  for select to authenticated using (true);

-- The billing-run cron schedule is applied per-project (URL embeds the
-- project ref), reusing the webhook dispatch secret:
--   select cron.schedule('billing-run', '*/30 * * * *', $cron$ ... $cron$);
