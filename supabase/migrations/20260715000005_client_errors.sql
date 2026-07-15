-- Real client-side observability: captures actual JS runtime errors, unhandled
-- promise rejections, and failed edge-function invocations from the running
-- app. Insert-only for authenticated (same pattern as audit_log) — the app
-- writes its own error telemetry directly, no edge function needed for that.
create table public.client_errors (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('js_error', 'unhandled_rejection', 'api_error')),
  message text not null,
  stack text,
  url text,
  user_agent text,
  actor_id uuid references public.profiles(id),
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index client_errors_created_at_idx on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;

create policy "client_errors_insert_authenticated" on public.client_errors
  for insert to authenticated with check (true);
create policy "client_errors_select_authenticated" on public.client_errors
  for select to authenticated using (true);
