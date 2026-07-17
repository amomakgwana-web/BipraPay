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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const action = body?.action ?? 'generate';
  if (!['generate', 'markPaid'].includes(action)) {
    return json({ error: 'action must be "generate" or "markPaid"' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'settlements' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to run settlements' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (action === 'markPaid') {
    const { settlementId } = body;
    if (!settlementId) return json({ error: 'settlementId is required' }, 400);

    const { data, error } = await admin
      .from('settlements')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', settlementId)
      .eq('status', 'pending')
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: `${settlementId} not found or already paid` }, 404);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'settlement.paid',
      entity_type: 'settlement',
      entity_id: settlementId,
      metadata: { merchant_id: data.merchant_id, net_amount_cents: data.net_amount_cents, ip },
    });

    await enqueueWebhookEvent(admin, 'settlement.paid', {
      id: data.id,
      merchant_id: data.merchant_id,
      net_amount_cents: data.net_amount_cents,
      currency: 'ZAR',
    });

    return json({ id: data.id, status: 'paid' });
  }

  // generate: one batch per active merchant, covering every unsettled
  // approved/success transaction that hasn't shipped in an earlier batch.
  const { data: merchants } = await admin
    .from('merchants')
    .select('id, fee_bps')
    .eq('status', 'active');

  const created: any[] = [];
  for (const merchant of merchants ?? []) {
    const { data: txns } = await admin
      .from('transactions')
      .select('ref, amount_cents')
      .eq('merchant_id', merchant.id)
      .in('status', ['success', 'approved'])
      .is('settlement_id', null);
    if (!txns || txns.length === 0) continue;

    const gross = txns.reduce((sum, t) => sum + Number(t.amount_cents), 0);
    const fee = Math.round((gross * merchant.fee_bps) / 10000);
    const net = gross - fee;

    const { data: settlement, error: settlementErr } = await admin
      .from('settlements')
      .insert({
        merchant_id: merchant.id,
        txn_count: txns.length,
        gross_amount_cents: gross,
        fee_amount_cents: fee,
        net_amount_cents: net,
        created_by: user.id,
      })
      .select()
      .single();
    if (settlementErr) return json({ error: settlementErr.message }, 500);

    const items = txns.map((t) => {
      const itemFee = Math.round((Number(t.amount_cents) * merchant.fee_bps) / 10000);
      return {
        settlement_id: settlement.id,
        transaction_ref: t.ref,
        amount_cents: t.amount_cents,
        fee_cents: itemFee,
        net_cents: Number(t.amount_cents) - itemFee,
      };
    });
    const { error: itemsErr } = await admin.from('settlement_items').insert(items);
    if (itemsErr) return json({ error: itemsErr.message }, 500);

    await admin
      .from('transactions')
      .update({ settlement_id: settlement.id })
      .in('ref', txns.map((t) => t.ref));

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'settlement.generated',
      entity_type: 'settlement',
      entity_id: settlement.id,
      metadata: { merchant_id: merchant.id, txn_count: txns.length, net_amount_cents: net, ip },
    });

    created.push(settlement);
  }

  return json({ settlements: created, count: created.length });
});
