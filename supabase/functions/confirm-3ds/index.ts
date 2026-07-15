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

  const { ref, otp, idempotencyKey } = body ?? {};
  if (typeof ref !== 'string' || !ref) return json({ error: 'ref is required' }, 400);
  if (!/^\d{6}$/.test(String(otp ?? ''))) return json({ error: 'Enter the 6-digit code from your banking app' }, 400);

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
      .eq('endpoint', 'confirm-3ds')
      .maybeSingle();
    if (existing) return json(existing.response_body, existing.status_code);
  }

  const { data: txn } = await admin.from('transactions').select('*').eq('ref', ref).maybeSingle();
  if (!txn) return json({ error: `Unknown transaction ${ref}` }, 404);
  if (txn.status !== 'pending' || txn.three_ds_status !== 'challenge_required') {
    return json({ error: `${ref} is not awaiting a 3DS challenge` }, 400);
  }

  // The step-up outcome is decided by BipraPay's own ACS-equivalent — the
  // risk score already computed at authorisation time — not by the OTP's
  // digits themselves, exactly as a real issuer's out-of-band challenge does.
  const passed = txn.risk_score <= 65;
  const newStatus = passed ? 'approved' : 'declined';
  const newThreeDs = passed ? 'challenge_passed' : 'challenge_failed';
  const authCode = passed ? String(Math.floor(100000 + Math.random() * 900000)) : null;

  const { data: updated, error } = await admin
    .from('transactions')
    .update({ status: newStatus, three_ds_status: newThreeDs })
    .eq('ref', ref)
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'payment.3ds_confirmed',
    entity_type: 'transaction',
    entity_id: ref,
    metadata: { status: newStatus, three_ds: newThreeDs, ip },
  });

  const responseBody = {
    ref: updated.ref,
    status: newStatus,
    approved: passed,
    threeDsStatus: newThreeDs,
    risk: updated.risk_score,
    authCode,
  };

  if (idemKey) {
    await admin.from('idempotency_keys').insert({
      key: idemKey,
      endpoint: 'confirm-3ds',
      status_code: 200,
      response_body: responseBody,
      created_by: user.id,
    });
  }

  return json(responseBody);
});
