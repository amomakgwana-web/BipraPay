# BipraPay

Payment Gateway

## Status

`index.html` is the BipraPay admin console UI, backed by Supabase (Postgres +
Auth + Edge Functions), covering dashboard, transactions, card-present/not-present
processing, push/pull payments, routing, refunds, risk, merchant onboarding,
webhooks, sandbox, analytics, compliance (POPIA), RBAC, audit, and settlement
pages.

Live so far: staff sign-in (Supabase Auth, with optional TOTP MFA), the
transactions dashboard and table (real data + realtime updates), the payment
initiator (server-side risk scoring via an Edge Function), and refunds
(TrasFund flow via an Edge Function with a 4-eyes threshold). The remaining
pages are still mock data and are being wired up incrementally.

Demo staff logins (seeded in `supabase/seed.sql`):
- `ananya@biprapay.com` / `Demo2026!` — Super Admin
- `sipho@biprapay.com` / `Admin123!` — Payments Ops

## Development

```bash
npm install
npm run dev
```

## Backend

Schema, RLS policies, and edge functions live under `supabase/`. Migrations
are applied in order via the Supabase MCP tooling / `supabase db push`.
