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
  if (!['create', 'submit'].includes(action)) {
    return json({ error: 'action must be "create" or "submit"' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'aml' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to file FIC reports' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (action === 'submit') {
    const { reportId } = body;
    if (!reportId) return json({ error: 'reportId is required' }, 400);

    const { data, error } = await admin
      .from('fic_reports')
      .update({ status: 'submitted', submitted_at: new Date().toISOString() })
      .eq('id', reportId)
      .eq('status', 'draft')
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: `${reportId} not found or already submitted` }, 404);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'fic_report.submitted',
      entity_type: 'fic_report',
      entity_id: reportId,
      metadata: { report_type: data.report_type, ip },
    });

    return json(data);
  }

  // create
  const { reportType, transactionRef, reason, amountCents } = body;
  if (!['str', 'ctr'].includes(reportType)) return json({ error: 'reportType must be str or ctr' }, 400);
  if (!reason || typeof reason !== 'string') return json({ error: 'reason is required' }, 400);

  const { data, error } = await admin
    .from('fic_reports')
    .insert({
      report_type: reportType,
      transaction_ref: transactionRef ?? null,
      reason,
      amount_cents: amountCents ?? null,
      filed_by: user.id,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'fic_report.created',
    entity_type: 'fic_report',
    entity_id: data.id,
    metadata: { report_type: reportType, transaction_ref: transactionRef, ip },
  });

  return json(data);
});
