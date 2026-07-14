-- Idempotency keys: protects process-payment / process-refund against
-- network-retry double-submission. Client supplies a key; the edge function
-- returns the cached response on replay instead of processing again.
create table public.idempotency_keys (
  key text primary key,
  endpoint text not null,
  status_code int not null,
  response_body jsonb not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.idempotency_keys enable row level security;

create policy "idempotency_keys_select_authenticated" on public.idempotency_keys
  for select to authenticated using (true);
create policy "idempotency_keys_insert_authenticated" on public.idempotency_keys
  for insert to authenticated with check (true);

-- Audit log: append-only record of admin/system actions. No update/delete
-- policy is intentional — audit trails should not be editable by the app.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_log_created_at_idx on public.audit_log (created_at desc);

alter table public.audit_log enable row level security;

create policy "audit_log_select_authenticated" on public.audit_log
  for select to authenticated using (true);
create policy "audit_log_insert_authenticated" on public.audit_log
  for insert to authenticated with check (true);
