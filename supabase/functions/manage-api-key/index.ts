import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  if (!['create', 'revoke'].includes(action)) {
    return json({ error: 'action must be "create" or "revoke"' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'api_keys' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to manage API keys' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (action === 'revoke') {
    const { keyId } = body;
    if (!keyId) return json({ error: 'keyId is required' }, 400);

    const { data, error } = await admin
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .is('revoked_at', null)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: `Key ${keyId} not found or already revoked` }, 404);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'api_key.revoked',
      entity_type: 'api_key',
      entity_id: keyId,
      metadata: { name: data.name, prefix: data.key_prefix, ip },
    });

    return json({ id: data.id, revoked: true });
  }

  // create
  const { name, environment, scopes } = body;
  if (!name || typeof name !== 'string') return json({ error: 'name is required' }, 400);
  const env = environment === 'test' ? 'test' : 'live';
  const secret = `sk_${env}_${randomToken(24)}`;
  const prefix = secret.slice(0, 12) + '••••';
  const hash = await sha256Hex(secret);
  const scopeList = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string') : [];

  const { data, error } = await admin
    .from('api_keys')
    .insert({
      name,
      key_prefix: prefix,
      key_hash: hash,
      environment: env,
      scopes: scopeList,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: 'api_key.created',
    entity_type: 'api_key',
    entity_id: data.id,
    metadata: { name, environment: env, prefix, ip },
  });

  // The full secret is returned exactly once — it is never retrievable again.
  return json({ id: data.id, name: data.name, prefix, environment: env, secret });
});
