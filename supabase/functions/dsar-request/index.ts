import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { action } = body ?? {};
  if (!['create', 'export', 'updateStatus'].includes(action)) {
    return json({ error: 'action must be "create", "export" or "updateStatus"' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'compliance' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to manage DSAR requests' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (action === 'create') {
    const { subjectName, subjectEmail, requestType } = body;
    if (!subjectName || !subjectEmail) return json({ error: 'subjectName and subjectEmail are required' }, 400);
    if (!['access', 'deletion', 'correction'].includes(requestType)) {
      return json({ error: 'requestType must be access, deletion or correction' }, 400);
    }

    const { data, error } = await admin
      .from('dsar_requests')
      .insert({ subject_name: subjectName, subject_email: subjectEmail, request_type: requestType, created_by: user.id })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'dsar.created',
      entity_type: 'dsar_request',
      entity_id: data.id,
      metadata: { subject_name: subjectName, request_type: requestType, ip },
    });

    return json(data);
  }

  if (action === 'export') {
    const { requestId } = body;
    if (!requestId) return json({ error: 'requestId is required' }, 400);

    const { data: reqRow } = await admin.from('dsar_requests').select('*').eq('id', requestId).maybeSingle();
    if (!reqRow) return json({ error: `Unknown request ${requestId}` }, 404);

    // This app has no dedicated customer identity table — a subject's data
    // is matched by the name captured on their transactions, the same field
    // the transactions table already uses for display. A production system
    // should key this off a stable customer ID rather than free-text name.
    const { data: txns } = await admin
      .from('transactions')
      .select('ref, amount_cents, status, channel, created_at')
      .ilike('customer_name', reqRow.subject_name);
    const refs = (txns ?? []).map((t) => t.ref);
    const { data: refunds } = refs.length
      ? await admin.from('refunds').select('ref, transaction_ref, amount_cents, status, created_at').in('transaction_ref', refs)
      : { data: [] };

    const exportData = { transactions: txns ?? [], refunds: refunds ?? [], exported_at: new Date().toISOString() };

    const { data: updated, error } = await admin
      .from('dsar_requests')
      .update({ export_data: exportData, status: 'in_progress' })
      .eq('id', requestId)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'dsar.exported',
      entity_type: 'dsar_request',
      entity_id: requestId,
      metadata: { txn_count: txns?.length ?? 0, refund_count: refunds?.length ?? 0, ip },
    });

    return json(updated);
  }

  // updateStatus
  const { requestId, status, notes } = body;
  if (!requestId) return json({ error: 'requestId is required' }, 400);
  if (!['in_progress', 'completed', 'rejected'].includes(status)) {
    return json({ error: 'status must be in_progress, completed or rejected' }, 400);
  }

  const patch: Record<string, unknown> = { status, notes: notes ?? null };
  if (status === 'completed') patch.completed_at = new Date().toISOString();

  const { data, error } = await admin.from('dsar_requests').update(patch).eq('id', requestId).select().single();
  if (error) return json({ error: error.message }, 500);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'dsar.status_updated',
    entity_type: 'dsar_request',
    entity_id: requestId,
    metadata: { status, ip },
  });

  return json(data);
});
