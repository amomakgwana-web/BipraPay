-- Every real write in this app goes through an edge function using the
-- service role (which bypasses RLS entirely) after an explicit
-- has_permission() check. The client-facing "authenticated" insert/update
-- policies below are leftovers from the very first schema migration,
-- before edge functions existed, and are now pure attack surface:
--
--   * profiles_update_own had no WITH CHECK, so any signed-in user could
--     call supabase.from('profiles').update({role_id:'super_admin', ...})
--     directly from the browser and grant themselves Super Admin.
--   * transactions/refunds/merchants insert+update let any authenticated
--     session forge transactions, refunds, or merchant records without
--     going through process-payment/process-refund/onboarding at all.
--   * audit_log insert let a user write fake audit entries into the very
--     table meant to be the tamper-evident record of what happened.
--   * idempotency_keys insert served no purpose the edge functions
--     (service role) don't already cover themselves.
--
-- None of these are used by any client code path (verified: only
-- edge functions write to these tables). Dropping them leaves every
-- table select-only for authenticated users, with all mutation routed
-- through permission-checked edge functions — the database itself is
-- never exposed for direct writes.
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "transactions_insert_authenticated" on public.transactions;
drop policy if exists "transactions_update_authenticated" on public.transactions;
drop policy if exists "refunds_insert_authenticated" on public.refunds;
drop policy if exists "refunds_update_authenticated" on public.refunds;
drop policy if exists "merchants_insert_authenticated" on public.merchants;
drop policy if exists "merchants_update_authenticated" on public.merchants;
drop policy if exists "audit_log_insert_authenticated" on public.audit_log;
drop policy if exists "idempotency_keys_insert_authenticated" on public.idempotency_keys;
