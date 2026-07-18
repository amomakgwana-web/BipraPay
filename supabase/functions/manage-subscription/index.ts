import { createClient } from 'jsr:@supabase/supabase-js@2';

// Staff CRUD for recurring billing: plans and subscriptions. Gated on the
// 'transactions' permission. The actual charging happens in billing-run.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annually'];

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { action } = body ?? {};
  if (!['createPlan', 'archivePlan', 'createSubscription', 'cancelSubscription'].includes(action)) {
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

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'transactions' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to manage billing' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const audit = (auditAction: string, entityId: string, metadata: Record<string, unknown>) =>
    admin.from('audit_log').insert({ actor_id: user.id, action: auditAction, entity_type: 'subscription', entity_id: entityId, metadata: { ...metadata, ip } });

  if (action === 'createPlan') {
    const { name, code, amountCents, frequency } = body;
    if (!name || !code) return json({ error: 'name and code are required' }, 400);
    const amt = Number(amountCents);
    if (!Number.isInteger(amt) || amt <= 0) return json({ error: 'Invalid amount' }, 400);
    if (!FREQUENCIES.includes(frequency)) return json({ error: 'Invalid frequency' }, 400);

    const { data, error } = await admin
      .from('billing_plans')
      .insert({ name, code, amount_cents: amt, frequency, created_by: user.id })
      .select()
      .single();
    if (error) return json({ error: error.message }, error.code === '23505' ? 409 : 500);
    await audit('billing_plan.created', data.id, { name, code, amount_cents: amt, frequency });
    return json(data);
  }

  if (action === 'archivePlan') {
    const { planId } = body;
    if (!planId) return json({ error: 'planId is required' }, 400);
    const { data, error } = await admin
      .from('billing_plans')
      .update({ status: 'archived' })
      .eq('id', planId)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    await audit('billing_plan.archived', planId, { name: data.name });
    return json(data);
  }

  if (action === 'createSubscription') {
    const { planId, merchantId, customerName, paymentMethodToken } = body;
    if (!planId || !merchantId || !customerName || !paymentMethodToken) {
      return json({ error: 'planId, merchantId, customerName and paymentMethodToken are required' }, 400);
    }
    const { data: plan } = await admin.from('billing_plans').select('*').eq('id', planId).eq('status', 'active').maybeSingle();
    if (!plan) return json({ error: `Plan ${planId} not found or archived` }, 400);
    const { data: merchant } = await admin.from('merchants').select('id, status').eq('id', merchantId).maybeSingle();
    if (!merchant || merchant.status !== 'active') return json({ error: `Merchant ${merchantId} not found or not active` }, 400);
    const { data: pm } = await admin.from('payment_methods').select('id').eq('id', paymentMethodToken).maybeSingle();
    if (!pm) return json({ error: 'Unknown payment method token' }, 400);

    // next_billing_at defaults to now — the first charge lands on the next
    // billing-run pass (within 30 minutes).
    const { data, error } = await admin
      .from('subscriptions')
      .insert({ plan_id: planId, merchant_id: merchantId, customer_name: customerName, payment_method_id: paymentMethodToken, created_by: user.id })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    await audit('subscription.created', data.id, { plan_id: planId, merchant_id: merchantId, customer_name: customerName });
    return json(data);
  }

  // cancelSubscription
  const { subscriptionId } = body;
  if (!subscriptionId) return json({ error: 'subscriptionId is required' }, 400);
  const { data, error } = await admin
    .from('subscriptions')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', subscriptionId)
    .neq('status', 'cancelled')
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: `${subscriptionId} not found or already cancelled` }, 404);
  await audit('subscription.cancelled', subscriptionId, { customer_name: data.customer_name });
  return json(data);
});
