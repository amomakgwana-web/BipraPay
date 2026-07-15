import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function randomSecret(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return 'whsec_' + Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  if (!['create', 'delete', 'sendTest'].includes(action)) {
    return json({ error: 'action must be "create", "delete" or "sendTest"' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'webhooks' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to manage webhooks' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (action === 'delete') {
    const { endpointId } = body;
    if (!endpointId) return json({ error: 'endpointId is required' }, 400);
    const { error } = await admin.from('webhook_endpoints').delete().eq('id', endpointId);
    if (error) return json({ error: error.message }, 500);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'webhook.deleted',
      entity_type: 'webhook_endpoint',
      entity_id: endpointId,
      metadata: { ip },
    });
    return json({ id: endpointId, deleted: true });
  }

  if (action === 'sendTest') {
    const { endpointId } = body;
    if (!endpointId) return json({ error: 'endpointId is required' }, 400);

    const { data: endpoint } = await admin.from('webhook_endpoints').select('*').eq('id', endpointId).maybeSingle();
    if (!endpoint) return json({ error: `Unknown endpoint ${endpointId}` }, 404);
    const { data: key } = await admin.from('webhook_signing_keys').select('secret').eq('endpoint_id', endpointId).maybeSingle();
    if (!key) return json({ error: 'No signing key found for this endpoint' }, 500);

    const payload = JSON.stringify({
      event: 'test.ping',
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      data: { message: 'This is a test event from BipraPay' },
    });
    const signature = await hmacHex(key.secret, payload);

    const started = Date.now();
    let statusCode: number | null = null;
    let deliveryStatus: 'success' | 'failed' = 'failed';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BipraPay-Signature': signature },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      statusCode = res.status;
      deliveryStatus = res.ok ? 'success' : 'failed';
    } catch (_e) {
      statusCode = null;
      deliveryStatus = 'failed';
    }
    const durationMs = Date.now() - started;

    const { data: delivery, error } = await admin
      .from('webhook_deliveries')
      .insert({
        endpoint_id: endpointId,
        event_type: 'test.ping',
        payload: JSON.parse(payload),
        status: deliveryStatus,
        attempts: 1,
        response_code: statusCode,
        duration_ms: durationMs,
        last_attempt_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    return json({ id: delivery.id, status: deliveryStatus, responseCode: statusCode, durationMs });
  }

  // create
  const { url, events, merchant } = body;
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return json({ error: 'url must be a valid https:// URL' }, 400);
  }
  const eventList = Array.isArray(events) && events.length > 0
    ? events.filter((e: unknown) => typeof e === 'string')
    : ['payment.success', 'payment.failed', 'refund.success'];

  const { data: endpoint, error: endpointErr } = await admin
    .from('webhook_endpoints')
    .insert({ merchant_id: merchant ?? null, url, events: eventList, created_by: user.id })
    .select()
    .single();
  if (endpointErr) return json({ error: endpointErr.message }, 500);

  const secret = randomSecret();
  const { error: keyErr } = await admin
    .from('webhook_signing_keys')
    .insert({ endpoint_id: endpoint.id, secret });
  if (keyErr) return json({ error: keyErr.message }, 500);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'webhook.created',
    entity_type: 'webhook_endpoint',
    entity_id: endpoint.id,
    metadata: { url, events: eventList, ip },
  });

  // The signing secret is returned exactly once — BipraPay keeps its own
  // copy (to sign future deliveries) but never displays it again.
  return json({ id: endpoint.id, url: endpoint.url, events: endpoint.events, secret });
});
