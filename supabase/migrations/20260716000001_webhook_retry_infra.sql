-- Webhook retry infrastructure.
--
-- Deliveries gain a retry schedule: the cron-driven webhook-dispatch edge
-- function picks up pending/failed rows whose next_attempt_at has passed,
-- sends the signed request, and either marks success, schedules the next
-- backoff attempt, or dead-letters after the 5th failure.
alter table public.webhook_deliveries
  add column next_attempt_at timestamptz not null default now();

alter table public.webhook_deliveries drop constraint webhook_deliveries_status_check;
alter table public.webhook_deliveries add constraint webhook_deliveries_status_check
  check (status in ('pending', 'success', 'failed', 'dead_letter'));

create index webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at)
  where status in ('pending', 'failed');

-- Internal server-side configuration. RLS enabled with NO policies:
-- only the service role (edge functions) and the postgres role (pg_cron
-- jobs) can read it — never clients. Holds the shared secret the cron
-- job uses to authenticate to the webhook-dispatch function.
create table public.internal_config (
  key text primary key,
  value text not null
);
alter table public.internal_config enable row level security;

insert into public.internal_config (key, value)
values ('dispatch_secret', encode(gen_random_bytes(24), 'hex'));

-- Scheduler + outbound HTTP from Postgres.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The cron schedule itself is applied per-project (the function URL embeds
-- the project ref, so it can't live in a shared migration). Template:
--
--   select cron.schedule('webhook-dispatch', '*/5 * * * *', $cron$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/webhook-dispatch',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'x-dispatch-secret', (select value from public.internal_config where key = 'dispatch_secret')
--       ),
--       body := '{}'::jsonb
--     );
--   $cron$);
