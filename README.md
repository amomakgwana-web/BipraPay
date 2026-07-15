# BipraPay

Payment Gateway

## Status

`index.html` is the BipraPay admin console UI, backed by Supabase (Postgres +
Auth + Edge Functions), covering dashboard, transactions, card-present/not-present
processing, push/pull payments, routing, refunds, risk, merchant onboarding,
webhooks, sandbox, analytics, compliance (POPIA), RBAC, audit, and settlement
pages.

Live so far: staff sign-in (Supabase Auth, with optional TOTP MFA), the
transactions dashboard and table (real data + realtime updates), refunds
(TrasFund flow via an Edge Function with a 4-eyes threshold), RBAC-gated KYC
decisions, dispute resolution, and API key management. The remaining pages
are still mock data and are being wired up incrementally.

**Payment processing (BipraPay as its own processor, not a Stripe/Adyen
wrapper):** the Payment Initiator sends the card number, expiry and CVV to a
`vault-tokenize` Edge Function exactly once. That function validates the
card, stores only a token + brand + last4 + bin + a one-way fingerprint in
`payment_methods`, and discards the PAN/CVV — they are never logged, stored,
or seen by any other function. `process-payment` only ever receives that
token, runs risk-based decisioning, and either approves/declines
frictionlessly or marks the transaction `pending` with
`three_ds_status: challenge_required`; the UI then presents a step-up
challenge that `confirm-3ds` resolves. This mirrors real EMV 3-D Secure 2 risk-based
authentication, run by BipraPay's own risk engine rather than a third-party
processor.

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
