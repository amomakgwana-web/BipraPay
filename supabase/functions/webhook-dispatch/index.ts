import { createClient } from 'jsr:@supabase/supabase-js@2';

// Cron-driven webhook delivery worker. pg_cron invokes this every 5 minutes
// (via pg_net) with the shared secret from internal_config — there is no
// user JWT on a cron call, so verify_jwt is off and the secret is the auth.
// Picks up due pending/failed deliveries, sends the HMAC-signed request,
// and either marks success, schedules the next backoff attempt, or
// dead-letters after the 5th failure.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Minutes until the next try, indexed by how many attempts have already run.
const BACKOFF_MINUTES = [1, 5, 30, 120];
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: secretRow } = await admin
    .from('internal_config')
    .select('value')
    .eq('key', 'dispatch_secret')
    .maybeSingle();
  if (!secretRow || req.headers.get('x-dispatch-secret') !== secretRow.value) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { data: due, error: dueError } = await admin
    .from('webhook_deliveries')
    .select('*, webhook_endpoints(url, enabled)')
    .in('status', ['pending', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at')
    .limit(BATCH_SIZE);
  if (dueError) return json({ error: dueError.message }, 500);

  let sent = 0, retried = 0, deadLettered = 0, skipped = 0;

  for (const delivery of due ?? []) {
    const endpoint = delivery.webhook_endpoints;
    if (!endpoint || !endpoint.enabled) {
      await admin.from('webhook_deliveries')
        .update({ status: 'dead_letter', last_attempt_at: new Date().toISOString() })
        .eq('id', delivery.id);
      skipped++;
      continue;
    }

    const { data: key } = await admin
      .from('webhook_signing_keys')
      .select('secret')
      .eq('endpoint_id', delivery.endpoint_id)
      .maybeSingle();
    if (!key) { skipped++; continue; }

    const body = JSON.stringify(delivery.payload);
    const signature = await hmacHex(key.secret, body);

    const started = Date.now();
    let responseCode: number | null = null;
    let ok = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BipraPay-Signature': signature,
          'X-BipraPay-Event-ID': delivery.id,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      responseCode = res.status;
      ok = res.ok;
    } catch (_e) {
      ok = false;
    }
    const durationMs = Date.now() - started;
    const attempts = delivery.attempts + 1;

    if (ok) {
      await admin.from('webhook_deliveries').update({
        status: 'success',
        attempts,
        response_code: responseCode,
        duration_ms: durationMs,
        last_attempt_at: new Date().toISOString(),
      }).eq('id', delivery.id);
      sent++;
    } else if (attempts >= MAX_ATTEMPTS) {
      await admin.from('webhook_deliveries').update({
        status: 'dead_letter',
        attempts,
        response_code: responseCode,
        duration_ms: durationMs,
        last_attempt_at: new Date().toISOString(),
      }).eq('id', delivery.id);
      deadLettered++;
    } else {
      const backoffMin = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await admin.from('webhook_deliveries').update({
        status: 'failed',
        attempts,
        response_code: responseCode,
        duration_ms: durationMs,
        last_attempt_at: new Date().toISOString(),
        next_attempt_at: new Date(Date.now() + backoffMin * 60_000).toISOString(),
      }).eq('id', delivery.id);
      retried++;
    }
  }

  return json({ processed: (due ?? []).length, sent, retried, deadLettered, skipped });
});
