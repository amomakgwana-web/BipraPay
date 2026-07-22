-- Public "Request Access" sign-up flow: a prospective company submits its
-- details here (via the request-access edge function, which uses the
-- service role — there is no direct insert policy for anon/authenticated).
-- An admin reviews the request in the console and either approves it
-- (creates the login account with a temp password via manage-user, which
-- the admin then shares with the company while onboarding them) or rejects
-- it with a reason. Nothing here creates a merchant record automatically —
-- merchant onboarding stays a separate, deliberate admin-led process.
create table public.access_requests (
  id text primary key default ('REQ-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  company_name text not null,
  trading_name text,
  registration_number text,
  contact_name text not null,
  contact_email text not null,
  contact_phone text,
  business_type text,
  expected_monthly_volume text,
  use_case text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_user_id uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now()
);

create index access_requests_status_idx on public.access_requests (status, created_at desc);

alter table public.access_requests enable row level security;

create policy "access_requests_select_authenticated" on public.access_requests
  for select to authenticated using (true);
