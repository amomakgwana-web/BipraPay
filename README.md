# SwizPay

Payment Gateway

## Status

`index.html` is the SwiftPay admin console UI — currently a static mockup (mock
data, no backend) covering dashboard, transactions, card-present/not-present
processing, push/pull payments, routing, refunds, risk, merchant onboarding,
webhooks, sandbox, analytics, compliance (POPIA), RBAC, audit, and settlement
pages.

Backend integration (Supabase: auth, database, edge functions) is being wired
up incrementally, page by page.

## Development

```bash
npm install
npm run dev
```
