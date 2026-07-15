-- Staff deactivation: the auth-level ban (via the admin API) is what actually
-- blocks sign-in; this column mirrors that state so the console can display
-- and filter it without needing service-role access to auth.users.
alter table public.profiles add column is_active boolean not null default true;
