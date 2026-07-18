import { createClient } from 'jsr:@supabase/supabase-js@2';

// Cron-driven recurring billing (every 30 minutes via pg_cron + pg_net,
// authenticated with the shared dispatch secret). Charges due
// active/past_due subscriptions against their stored vault token as
// merchant-initiated transactions (no 3DS challenge on recurring), then
// drives dunning: failure -> past_due with a retry tomorrow; the 4th
// consecutive failure cancels the subscription.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function enqueueWebhookEvent(admin: any, eventType: string, data: Record<string, unknown>) {
  const { data: endpoints } = await admin.from('webhook_endpoints').select('id, events').eq('enabled', true);
  const targets = (endpoints ?? []).filter((e: any) => (e.events ?? []).includes(eventType));
  if (!targets.length) return;
  const payload = { event: eventType, id: crypto.randomUUID(), created_at: new Date().toISOString(), data };
  await admin.from('webhook_deliveries').insert(
    targets.map((e: any) => ({ endpoint_id: e.id, event_type: eventType, payload, status: 'pending' })),
  );
}

const FREQ_DAYS: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 91, annually: 365 };
const MAX_DUNNING_ATTEMPTS = 4;
const BATCH_SIZE = 25;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: secretRow } = await admin
    .from('internal_config').select('value').eq('key', 'dispatch_secret').maybeSingle();
  if (!secretRow || req.headers.get('x-dispatch-secret') !== secretRow.value) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { data: due, error: dueError } = await admin
    .from('subscriptions')
    .select('*, billing_plans(name, amount_cents, frequency), merchants(status), payment_methods(brand)')
    .in('status', ['active', 'past_due'])
    .lte('next_billing_at', new Date().toISOString())
    .order('next_billing_at')
    .limit(BATCH_SIZE);
  if (dueError) return json({ error: dueError.message }, 500);

  let billed = 0, failed = 0, cancelled = 0, skipped = 0;

  for (const sub of due ?? []) {
    const plan = sub.billing_plans;
    if (!plan || sub.merchants?.status !== 'active') {
      // Merchant suspended/closed: park the subscription a day out rather than charging.
      await admin.from('subscriptions')
        .update({ next_billing_at: new Date(Date.now() + 86400000).toISOString() })
        .eq('id', sub.id);
      skipped++;
      continue;
    }

    // Merchant-initiated recurring charge: same simplified risk model as
    // process-payment, no 3DS step-up (that happened at enrolment).
    const risk = Math.min(97, Math.max(1, Math.round(8 + Math.random() * 25 + (plan.amount_cents > 1000000 ? 15 : 0))));
    const approved = risk <= 85;
    const ref = `SPY-SUB-${Math.floor(1000 + Math.random() * 9000)}`;

    const { error: txnError } = await admin.from('transactions').insert({
      ref,
      type: 'Pull',
      method: `${sub.payment_methods?.brand ?? 'Card'} recurring`,
      bank: 'FNB',
      customer_name: sub.customer_name,
      amount_cents: plan.amount_cents,
      risk_score: risk,
      status: approved ? 'approved' : 'declined',
      channel: 'recurring',
      merchant_id: sub.merchant_id,
      payment_method_id: sub.payment_method_id,
      created_by: sub.created_by,
    });
    if (txnError) { skipped++; continue; }

    if (approved) {
      const days = FREQ_DAYS[plan.frequency] ?? 30;
      const base = Math.max(Date.now(), new Date(sub.next_billing_at).getTime());
      await admin.from('subscriptions').update({
        status: 'active',
        failed_attempts: 0,
        next_billing_at: new Date(base + days * 86400000).toISOString(),
      }).eq('id', sub.id);
      await admin.from('audit_log').insert({
        actor_id: null, action: 'subscription.billed', entity_type: 'subscription', entity_id: sub.id,
        metadata: { ref, plan: plan.name, amount_cents: plan.amount_cents, customer: sub.customer_name },
      });
      await enqueueWebhookEvent(admin, 'payment.success', {
        ref, amount_cents: plan.amount_cents, currency: 'ZAR', merchant_id: sub.merchant_id,
        status: 'approved', subscription_id: sub.id,
      });
      billed++;
    } else {
      const attempts = sub.failed_attempts + 1;
      const exhausted = attempts >= MAX_DUNNING_ATTEMPTS;
      await admin.from('subscriptions').update({
        status: exhausted ? 'cancelled' : 'past_due',
        failed_attempts: attempts,
        next_billing_at: new Date(Date.now() + 86400000).toISOString(),
        cancelled_at: exhausted ? new Date().toISOString() : null,
      }).eq('id', sub.id);
      await admin.from('audit_log').insert({
        actor_id: null,
        action: exhausted ? 'subscription.cancelled_dunning' : 'subscription.billing_failed',
        entity_type: 'subscription', entity_id: sub.id,
        metadata: { ref, plan: plan.name, amount_cents: plan.amount_cents, customer: sub.customer_name, attempts },
      });
      await enqueueWebhookEvent(admin, 'payment.failed', {
        ref, amount_cents: plan.amount_cents, currency: 'ZAR', merchant_id: sub.merchant_id,
        status: 'declined', subscription_id: sub.id, dunning_attempt: attempts,
      });
      if (exhausted) cancelled++; else failed++;
    }
  }

  return json({ processed: (due ?? []).length, billed, failed, cancelled, skipped });
});
