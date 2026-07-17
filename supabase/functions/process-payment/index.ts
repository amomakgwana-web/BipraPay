import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

const TYPE_MAP: Record<string, string> = { CNP: 'CNP', CP: 'CP', PayShap: 'Push', 'WA Pay': 'Push' };
const METHOD_MAP: Record<string, string> = {
  CP: 'Chip & PIN',
  PayShap: 'PayShap',
  'WA Pay': 'WhatsApp Pay',
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { paymentMethodToken, amount, merchant, channel, idempotencyKey } = body ?? {};
  if (typeof paymentMethodToken !== 'string' || !paymentMethodToken.startsWith('tok_')) {
    return json({ error: 'A tokenised payment method is required' }, 400);
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return json({ error: 'Invalid amount' }, 400);
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
      .eq('endpoint', 'process-payment')
      .maybeSingle();
    if (existing) return json(existing.response_body, existing.status_code);
  }

  // BipraPay never re-validates card data here — that already happened once,
  // in the vault, at tokenisation time. This step only resolves the token
  // to its non-sensitive card metadata for display purposes.
  const { data: pm } = await admin
    .from('payment_methods')
    .select('id, brand, last4')
    .eq('id', paymentMethodToken)
    .maybeSingle();
  if (!pm) return json({ error: 'Unknown or expired payment method token' }, 400);

  const merchantId = merchant || 'MRC-00142';
  const { data: merchantRow } = await admin
    .from('merchants')
    .select('id, status')
    .eq('id', merchantId)
    .maybeSingle();
  if (!merchantRow) return json({ error: `Unknown merchant ${merchantId}` }, 400);
  if (merchantRow.status !== 'active') {
    return json({ error: `Merchant ${merchantId} is ${merchantRow.status}, cannot accept payments` }, 400);
  }

  const type = TYPE_MAP[channel] ?? 'CNP';
  const method = channel === 'CNP' ? `${pm.brand} 3DS2` : (METHOD_MAP[channel] ?? channel ?? 'Card');

  // Simplified risk model: baseline jitter + a premium for high-value payments.
  const risk = Math.min(97, Math.max(1, Math.round(8 + Math.random() * 25 + (amt > 10000 ? 15 : 0))));
  const ref = `SPY-${String(channel ?? 'CNP').replace(/\s/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

  // Risk-based 3DS2 authentication, same as a real issuer ACS: very low risk
  // goes through frictionless, very high risk is a hard decline no challenge
  // can rescue, everything in between requires a step-up challenge before
  // BipraPay's authorisation engine will approve it.
  let status: string;
  let threeDsStatus: string;
  if (risk > 85) {
    status = 'declined';
    threeDsStatus = 'frictionless';
  } else if (risk > 40) {
    status = 'pending';
    threeDsStatus = 'challenge_required';
  } else {
    status = 'approved';
    threeDsStatus = 'frictionless';
  }

  const { data, error } = await admin
    .from('transactions')
    .insert({
      ref,
      type,
      method,
      bank: 'FNB',
      customer_name: 'Test Customer',
      amount_cents: Math.round(amt * 100),
      risk_score: risk,
      status,
      channel: String(channel ?? '').toLowerCase(),
      merchant_id: merchantId,
      payment_method_id: pm.id,
      three_ds_status: threeDsStatus,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return json({ error: error.message }, 500);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'payment.created',
    entity_type: 'transaction',
    entity_id: data.ref,
    metadata: { amount: amt, status: data.status, risk: data.risk_score, channel, merchant_id: merchantId, three_ds: threeDsStatus, ip },
  });

  // Challenge-pending transactions emit their event from confirm-3ds instead.
  if (status !== 'pending') {
    await enqueueWebhookEvent(admin, status === 'approved' ? 'payment.success' : 'payment.failed', {
      ref: data.ref,
      amount_cents: data.amount_cents,
      currency: 'ZAR',
      merchant_id: merchantId,
      status: data.status,
    });
  }

  const responseBody = {
    ref: data.ref,
    status: data.status,
    risk: data.risk_score,
    amount: amt,
    brand: pm.brand,
    last4: pm.last4,
    threeDsStatus,
    requiresChallenge: threeDsStatus === 'challenge_required',
    authCode: status === 'approved' ? String(Math.floor(100000 + Math.random() * 900000)) : null,
    approved: status === 'approved',
  };

  if (idemKey) {
    await admin.from('idempotency_keys').insert({
      key: idemKey,
      endpoint: 'process-payment',
      status_code: 200,
      response_body: responseBody,
      created_by: user.id,
    });
  }

  return json(responseBody);
});
