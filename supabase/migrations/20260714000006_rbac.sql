-- RBAC: profiles.role was a free-text label with no enforcement — any
-- authenticated staff member could take any action. This adds real roles,
-- permissions, and a role_permissions join, matching the role set already
-- described in the RBAC UI (Super Admin, Finance, Developer, Support,
-- Risk Analyst, Read-Only).

create table public.roles (
  id text primary key,
  name text not null,
  description text
);

create table public.permissions (
  id text primary key,
  description text
);

create table public.role_permissions (
  role_id text not null references public.roles(id) on delete cascade,
  permission_id text not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

create policy "roles_select_authenticated" on public.roles for select to authenticated using (true);
create policy "permissions_select_authenticated" on public.permissions for select to authenticated using (true);
create policy "role_permissions_select_authenticated" on public.role_permissions for select to authenticated using (true);

insert into public.roles (id, name, description) values
  ('super_admin',  'Super Admin',   'Full platform access · user management · all config'),
  ('finance',      'Finance',       'Settlements, refunds, reporting · no config access'),
  ('developer',    'Developer',     'API, webhooks, sandbox · no financial actions'),
  ('support',      'Support',       'View transactions, initiate refunds up to R 1,000'),
  ('risk_analyst', 'Risk Analyst',  'Risk, compliance, AML/fraud · read-only elsewhere'),
  ('read_only',    'Read-Only',     'View-only access to all sections');

insert into public.permissions (id) values
  ('transactions'), ('transactions_view'), ('refunds'), ('refunds_limited'),
  ('settlements'), ('merchants'), ('risk'), ('compliance'), ('fraud_rules'),
  ('aml'), ('config'), ('api_keys'), ('users'), ('audit'), ('reporting'),
  ('webhooks'), ('sandbox'), ('devportal'), ('view_all');

insert into public.role_permissions (role_id, permission_id) values
  ('super_admin','transactions'), ('super_admin','refunds'), ('super_admin','settlements'),
  ('super_admin','merchants'), ('super_admin','risk'), ('super_admin','config'),
  ('super_admin','api_keys'), ('super_admin','users'), ('super_admin','audit'),
  ('finance','transactions'), ('finance','refunds'), ('finance','settlements'), ('finance','reporting'),
  ('developer','api_keys'), ('developer','webhooks'), ('developer','sandbox'), ('developer','devportal'),
  ('support','transactions_view'), ('support','refunds_limited'),
  ('risk_analyst','risk'), ('risk_analyst','compliance'), ('risk_analyst','fraud_rules'), ('risk_analyst','aml'),
  ('read_only','view_all');

alter table public.profiles add column role_id text references public.roles(id);

update public.profiles set role_id = 'super_admin', role = 'Super Admin' where email = 'ananya@biprapay.com';
update public.profiles set role_id = 'finance', role = 'Finance' where email = 'sipho@biprapay.com';

-- New staff default to Read-Only until a Super Admin assigns a real role.
alter table public.profiles alter column role_id set default 'read_only';
update public.profiles set role_id = 'read_only' where role_id is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role, role_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'Read-Only'),
    coalesce(new.raw_user_meta_data->>'role_id', 'read_only')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Checks whether the calling user's role grants a given permission.
-- Used both in RLS policies and inside edge functions.
create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.role_permissions rp on rp.role_id = p.role_id
    where p.id = auth.uid() and rp.permission_id = perm
  );
$$;

revoke execute on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated;
