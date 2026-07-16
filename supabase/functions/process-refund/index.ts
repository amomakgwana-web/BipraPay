import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const FOUR_EYES_THRESHOLD_CENTS = 500_000; // R5,000 — matches the Refund Policy shown in the UI

// Queues an event for every enabled endpoint subscribed to it; the
// cron-driven webhook-dispatch worker sends and retries the deliveries.
async function enqueueWebhookEvent(admin: any, eventType: string, data: Record<string, unknown>) {
  const { data: endpoints } = await admin.from('webhook_endpoints').select('id, events').eq('enabled', true);
  const targets = (endpoints ?? []).filter((e: any) => (e.events ?? []).includes(eventType));
  if (!targets.length) return;
  const payload = { event: eventType, id: crypto.randomUUID(), created_at: new Date().toISOString(), data };
  await admin.from('webhook_deliveries').insert(
    targets.map((e: any) => ({ endpoint_id: e.id, event_type: eventType, payload, status: 'pending' })),
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { transactionRef, amount, reason, idempotencyKey } = body ?? {};
  if (!transactionRef || typeof transactionRef !== 'string') {
    return json({ error: 'transactionRef is required' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const idemKey = typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null;
  if (idemKey) {
    const { data: existing } = await admin
      .from('idempotency_keys')
      .select('status_code, response_body')
      .eq('key', idemKey)
      .eq('endpoint', 'process-refund')
      .maybeSingle();
    if (existing) return json(existing.response_body, existing.status_code);
  }

  const { data: txn, error: txnError } = await admin
    .from('transactions')
    .select('*')
    .eq('ref', transactionRef)
    .maybeSingle();

  if (txnError) return json({ error: txnError.message }, 500);
  if (!txn) return json({ error: `Transaction ${transactionRef} not found` }, 404);
  if (!['success', 'approved'].includes(txn.status)) {
    return json({ error: `Transaction ${transactionRef} is not refundable (status: ${txn.status})` }, 400);
  }

  const requestedCents = amount != null ? Math.round(Number(amount) * 100) : txn.amount_cents;
  if (!Number.isFinite(requestedCents) || requestedCents <= 0) {
    return json({ error: 'Invalid refund amount' }, 400);
  }
  if (requestedCents > txn.amount_cents) {
    return json({ error: 'Refund amount exceeds original transaction amount' }, 400);
  }

  const type = requestedCents >= txn.amount_cents ? 'Full' : 'Partial';
  const status = requestedCents > FOUR_EYES_THRESHOLD_CENTS ? 'pending_4eyes' : 'success';
  const ref = `TF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

  const { data, error } = await admin
    .from('refunds')
    .insert({
      ref,
      transaction_ref: txn.ref,
      type,
      amount_cents: requestedCents,
      reason: reason || 'customer_request',
      status,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return json({ error: error.message }, 500);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'refund.created',
    entity_type: 'refund',
    entity_id: data.ref,
    metadata: { transaction_ref: txn.ref, amount: requestedCents / 100, type, status: data.status, reason: data.reason, ip },
  });

  // 4-eyes-pending refunds emit no event until they are approved.
  if (status === 'success') {
    await enqueueWebhookEvent(admin, 'refund.success', {
      ref: data.ref,
      transaction_ref: txn.ref,
      amount_cents: requestedCents,
      currency: 'ZAR',
      merchant_id: txn.merchant_id,
    });
  }

  const responseBody = {
    ref: data.ref,
    orig: data.transaction_ref,
    type: data.type,
    amount: requestedCents / 100,
    reason: data.reason,
    status: data.status,
  };

  if (idemKey) {
    await admin.from('idempotency_keys').insert({
      key: idemKey,
      endpoint: 'process-refund',
      status_code: 200,
      response_body: responseBody,
      created_by: user.id,
    });
  }

  return json(responseBody);
});
