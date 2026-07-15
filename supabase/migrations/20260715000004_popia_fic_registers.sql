-- POPIA Data Subject Access Requests and FIC (Financial Intelligence Centre)
-- suspicious/cash-threshold transaction reporting registers.
create table public.dsar_requests (
  id text primary key default (
    'DSAR-' || to_char(now(), 'YYYY') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)
  ),
  subject_name text not null,
  subject_email text not null,
  request_type text not null check (request_type in ('access', 'deletion', 'correction')),
  status text not null default 'received' check (status in ('received', 'in_progress', 'completed', 'rejected')),
  notes text,
  export_data jsonb,
  requested_at timestamptz not null default now(),
  due_at timestamptz not null default (now() + interval '30 days'),
  completed_at timestamptz,
  created_by uuid references public.profiles(id)
);

-- 'str' = Suspicious Transaction Report, 'ctr' = Cash Threshold Report — the
-- two FIC Act filing types. "submitted" here means internally marked
-- ready-for-filing; actual transmission to the FIC's goAML system is a
-- separate regulatory integration this register feeds into, not replaces.
create table public.fic_reports (
  id text primary key default (
    'FIC-' || to_char(now(), 'YYYY') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)
  ),
  report_type text not null check (report_type in ('str', 'ctr')),
  transaction_ref text references public.transactions(ref),
  reason text not null,
  amount_cents bigint,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'acknowledged')),
  filed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);

alter table public.dsar_requests enable row level security;
alter table public.fic_reports enable row level security;

create policy "dsar_requests_select_authenticated" on public.dsar_requests
  for select to authenticated using (true);
create policy "fic_reports_select_authenticated" on public.fic_reports
  for select to authenticated using (true);
