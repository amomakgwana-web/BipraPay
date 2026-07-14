-- KYC/onboarding pipeline. No insert/update policy for authenticated —
-- all writes go through the kyc-decision edge function, which enforces
-- the 'merchants' permission and logs to audit_log.
create table public.kyc_cases (
  id text primary key,
  business_name text not null,
  business_type text,
  mcc text,
  stage text not null default 'document_review'
    check (stage in ('document_review','fica_check','aml_screening','manual_review','approved','rejected')),
  risk text not null default 'low' check (risk in ('low','medium','high')),
  submitted_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_reason text,
  merchant_id text references public.merchants(id),
  created_at timestamptz not null default now()
);

alter table public.kyc_cases enable row level security;

create policy "kyc_cases_select_authenticated" on public.kyc_cases
  for select to authenticated using (true);

insert into public.kyc_cases (id, business_name, business_type, mcc, stage, risk, submitted_at) values
  ('MRC-APP-0022', 'Sipho''s Spaza Store',   'Sole Prop', '5411 — Grocery',  'document_review', 'low',    '2026-05-04'),
  ('MRC-APP-0021', 'TechBuild (Pty) Ltd',    'Pty Ltd',   '7372 — Software', 'fica_check',       'low',    '2026-05-03'),
  ('MRC-APP-0020', 'Zanele''s Salon',        'Sole Prop', '7230 — Beauty',   'aml_screening',    'medium', '2026-05-02'),
  ('MRC-APP-0019', 'Unknown Corp Ltd',       'Pty Ltd',   '7999 — Misc',     'manual_review',    'high',   '2026-04-30')
on conflict (id) do nothing;
