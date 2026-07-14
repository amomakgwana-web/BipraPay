-- Chargebacks/disputes. No insert/update policy for authenticated — all
-- resolutions go through the dispute-resolve edge function, which enforces
-- the 'risk' permission and logs to audit_log.
create table public.disputes (
  id text primary key,
  transaction_ref text not null references public.transactions(ref),
  reason text not null,
  scheme text,
  reason_code text,
  deadline_at date,
  status text not null default 'pending' check (status in ('pending','urgent','won','lost','withdrawn')),
  stage text not null default 'evidence_required' check (stage in ('evidence_required','under_review','resolved')),
  amount_cents bigint not null,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now()
);

alter table public.disputes enable row level security;

create policy "disputes_select_authenticated" on public.disputes
  for select to authenticated using (true);

-- amount_cents matches each referenced transaction's actual amount.
insert into public.disputes (id, transaction_ref, reason, scheme, reason_code, deadline_at, status, stage, amount_cents) values
  ('DSP-2026-0318', 'SPY-CNP-0040', 'Fraud — Unauthorised',  'Visa',       '10.4', current_date + 3,  'urgent',  'evidence_required', 435000),
  ('DSP-2026-0312', 'SPY-PULL-0093','Not Received',          'Mastercard', '4853', current_date + 7,  'pending', 'under_review',       240000),
  ('DSP-2026-0298', 'SPY-CNP-0038', 'Duplicate Charge',      'Visa',       '12.6', current_date + 12, 'pending', 'evidence_required',  120000)
on conflict (id) do nothing;
