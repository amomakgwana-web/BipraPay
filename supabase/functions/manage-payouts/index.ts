import { createClient } from 'jsr:@supabase/supabase-js@2';

// Bulk payouts with maker-checker. Gated on the 'settlements' permission.
// createBatch stores the items (account numbers masked to last 4 — the
// full number is never persisted); approveBatch requires a DIFFERENT staff
// member than the maker and mints one Push transaction per item.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_ITEMS = 500;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { action } = body ?? {};
  if (!['createBatch', 'approveBatch', 'rejectBatch'].includes(action)) {
    return json({ error: 'Unknown action' }, 400);
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
  if (!hasPerm) return json({ error: 'Your role does not have permission to manage payouts' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (action === 'createBatch') {
    const { name, items } = body;
    if (!name || typeof name !== 'string') return json({ error: 'name is required' }, 400);
    if (!Array.isArray(items) || items.length === 0) return json({ error: 'items are required' }, 400);
    if (items.length > MAX_ITEMS) return json({ error: `Max ${MAX_ITEMS} items per batch` }, 400);

    const clean = [];
    for (const [i, it] of items.entries()) {
      const amount = Number(it?.amountCents);
      const account = String(it?.account ?? '').replace(/\s/g, '');
      if (!it?.beneficiary || !account || !Number.isInteger(amount) || amount <= 0) {
        return json({ error: `Row ${i + 1}: beneficiary, account, and a positive amount are required` }, 400);
      }
      clean.push({
        beneficiary: String(it.beneficiary).slice(0, 120),
        bank: it.bank ? String(it.bank).slice(0, 60) : null,
        account_masked: '••••' + account.slice(-4),
        amount_cents: amount,
        reference: it.reference ? String(it.reference).slice(0, 60) : null,
      });
    }
    const total = clean.reduce((s, it) => s + it.amount_cents, 0);

    const { data: batch, error } = await admin
      .from('payout_batches')
      .insert({ name, item_count: clean.length, total_cents: total, created_by: user.id })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    const { error: itemsErr } = await admin
      .from('payout_items')
      .insert(clean.map((it) => ({ ...it, batch_id: batch.id })));
    if (itemsErr) return json({ error: itemsErr.message }, 500);

    await admin.from('audit_log').insert({
      actor_id: user.id, action: 'payout_batch.created', entity_type: 'payout_batch', entity_id: batch.id,
      metadata: { name, item_count: clean.length, total_cents: total, ip },
    });

    return json(batch);
  }

  const { batchId } = body;
  if (!batchId) return json({ error: 'batchId is required' }, 400);
  const { data: batch } = await admin.from('payout_batches').select('*').eq('id', batchId).maybeSingle();
  if (!batch) return json({ error: `Batch ${batchId} not found` }, 404);
  if (batch.status !== 'pending_approval') return json({ error: `Batch ${batchId} is already ${batch.status}` }, 400);

  if (action === 'rejectBatch') {
    const { reason } = body;
    const { data, error } = await admin
      .from('payout_batches')
      .update({ status: 'rejected', approved_by: user.id, decided_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', batchId)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    await admin.from('audit_log').insert({
      actor_id: user.id, action: 'payout_batch.rejected', entity_type: 'payout_batch', entity_id: batchId,
      metadata: { name: batch.name, reason: reason || null, ip },
    });
    return json(data);
  }

  // approveBatch — the checker must not be the maker.
  if (batch.created_by === user.id) {
    return json({ error: 'Maker-checker: a different staff member must approve this batch' }, 403);
  }

  const { data: items, error: itemsError } = await admin.from('payout_items').select('*').eq('batch_id', batchId);
  if (itemsError) return json({ error: itemsError.message }, 500);

  for (const item of items ?? []) {
    const ref = `SPY-PUSH-${Math.floor(10000 + Math.random() * 90000)}`;
    const { error: txnError } = await admin.from('transactions').insert({
      ref,
      type: 'Push',
      method: 'RTC Payout',
      bank: item.bank ?? 'FNB',
      customer_name: item.beneficiary,
      amount_cents: item.amount_cents,
      risk_score: 2,
      status: 'success',
      channel: 'payout',
      created_by: batch.created_by,
    });
    if (!txnError) {
      await admin.from('payout_items').update({ transaction_ref: ref }).eq('id', item.id);
    }
  }

  const { data: updated, error } = await admin
    .from('payout_batches')
    .update({ status: 'completed', approved_by: user.id, decided_at: new Date().toISOString() })
    .eq('id', batchId)
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  await admin.from('audit_log').insert({
    actor_id: user.id, action: 'payout_batch.approved', entity_type: 'payout_batch', entity_id: batchId,
    metadata: { name: batch.name, item_count: batch.item_count, total_cents: batch.total_cents, maker: batch.created_by, ip },
  });

  return json(updated);
});
