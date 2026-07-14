-- API keys: only the prefix and a hash are ever stored. The full secret is
-- generated and returned exactly once, at creation, by the manage-api-key
-- edge function — the same pattern Stripe/GitHub use. No insert/update
-- policy for authenticated; only that edge function (service role) writes.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_prefix text not null,
  key_hash text not null,
  environment text not null default 'live' check (environment in ('live','test')),
  scopes text[] not null default '{}',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

alter table public.api_keys enable row level security;

create policy "api_keys_select_authenticated" on public.api_keys
  for select to authenticated using (true);
