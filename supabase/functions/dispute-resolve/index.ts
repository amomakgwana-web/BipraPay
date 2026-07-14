import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OUTCOMES = ['won', 'lost', 'withdrawn'];

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { disputeId, outcome, note } = body ?? {};
  if (!disputeId || !OUTCOMES.includes(outcome)) {
    return json({ error: `disputeId and outcome (${OUTCOMES.join('/')}) are required` }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'risk' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to resolve disputes' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: dispute, error: disputeError } = await admin
    .from('disputes')
    .select('*')
    .eq('id', disputeId)
    .maybeSingle();
  if (disputeError) return json({ error: disputeError.message }, 500);
  if (!dispute) return json({ error: `Dispute ${disputeId} not found` }, 404);
  if (dispute.stage === 'resolved') {
    return json({ error: `Dispute ${disputeId} was already resolved (${dispute.status})` }, 400);
  }

  const { data, error } = await admin
    .from('disputes')
    .update({
      status: outcome,
      stage: 'resolved',
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_note: note || null,
    })
    .eq('id', disputeId)
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'dispute.resolved',
    entity_type: 'dispute',
    entity_id: disputeId,
    metadata: { outcome, transaction_ref: dispute.transaction_ref, amount: dispute.amount_cents / 100, note: note || null, ip },
  });

  return json({ id: data.id, status: data.status, stage: data.stage });
});
