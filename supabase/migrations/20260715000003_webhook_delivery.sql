-- Webhook delivery infrastructure. Endpoint metadata is staff-visible; the
-- HMAC signing secret lives in a separate table with NO policies at all, so
-- only the service role (edge functions) can ever read it — the same way a
-- real processor keeps its own copy to sign outgoing deliveries.
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  merchant_id text references public.merchants(id),
  url text not null,
  events text[] not null default '{payment.success,payment.failed,refund.success}',
  enabled boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.webhook_signing_keys (
  endpoint_id uuid primary key references public.webhook_endpoints(id) on delete cascade,
  secret text not null
);

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  attempts int not null default 0,
  response_code int,
  duration_ms int,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_signing_keys enable row level security;
alter table public.webhook_deliveries enable row level security;

create policy "webhook_endpoints_select_authenticated" on public.webhook_endpoints
  for select to authenticated using (true);
create policy "webhook_deliveries_select_authenticated" on public.webhook_deliveries
  for select to authenticated using (true);
-- webhook_signing_keys intentionally has no policies: authenticated gets zero access.
