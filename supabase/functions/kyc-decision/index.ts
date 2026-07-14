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

  const { caseId, decision, reason } = body ?? {};
  if (!caseId || !['approve', 'reject'].includes(decision)) {
    return json({ error: 'caseId and decision ("approve" or "reject") are required' }, 400);
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

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'merchants' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to decide onboarding applications' }, 403);

  const { data: kycCase, error: caseError } = await admin
    .from('kyc_cases')
    .select('*')
    .eq('id', caseId)
    .maybeSingle();
  if (caseError) return json({ error: caseError.message }, 500);
  if (!kycCase) return json({ error: `KYC case ${caseId} not found` }, 404);
  if (['approved', 'rejected'].includes(kycCase.stage)) {
    return json({ error: `Case ${caseId} was already ${kycCase.stage}` }, 400);
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (decision === 'reject') {
    const { data, error } = await admin
      .from('kyc_cases')
      .update({ stage: 'rejected', decided_by: user.id, decided_at: new Date().toISOString(), decision_reason: reason || null })
      .eq('id', caseId)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'kyc.rejected',
      entity_type: 'kyc_case',
      entity_id: caseId,
      metadata: { business_name: kycCase.business_name, reason: reason || null, ip },
    });

    return json({ id: data.id, stage: data.stage, merchantId: null });
  }

  // Approve: mint the merchant record and mark the case approved.
  const merchantId = caseId.replace('-APP-', '-');
  const { error: merchantError } = await admin.from('merchants').insert({
    id: merchantId,
    name: kycCase.business_name,
    mcc: kycCase.mcc?.split(' — ')[0] ?? null,
    status: 'active',
    risk: kycCase.risk,
  });
  if (merchantError && merchantError.code !== '23505') {
    // 23505 = unique_violation — merchant already exists, tolerate and continue.
    return json({ error: merchantError.message }, 500);
  }

  const { data, error } = await admin
    .from('kyc_cases')
    .update({
      stage: 'approved',
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      decision_reason: reason || null,
      merchant_id: merchantId,
    })
    .eq('id', caseId)
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'kyc.approved',
    entity_type: 'kyc_case',
    entity_id: caseId,
    metadata: { business_name: kycCase.business_name, merchant_id: merchantId, ip },
  });

  return json({ id: data.id, stage: data.stage, merchantId });
});
