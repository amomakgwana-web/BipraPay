import { createClient } from 'jsr:@supabase/supabase-js@2';

// ══════════════════════════════════════════════════════════════
// BipraPay's own tokenisation vault. This is the ONLY place in the
// system a raw PAN/CVV is ever seen. Neither value is stored, logged,
// or returned — only the resulting token, brand, last4, bin and a
// one-way fingerprint (for future duplicate-card detection) persist.
// Everything downstream (process-payment, confirm-3ds, transactions)
// deals exclusively in vault tokens.
// ══════════════════════════════════════════════════════════════

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function detectBrand(digits: string): string {
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720))/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'Amex';
  if (/^(6011|65)/.test(digits)) return 'Discover';
  if (/^(30[0-5]|3[68])/.test(digits)) return 'Diners';
  return 'Card';
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // pan/cvv live only in these local variables for the lifetime of this request.
  const pan = String(body?.pan ?? '').replace(/\s/g, '');
  const cvv = String(body?.cvv ?? '');
  const expMonth = Number(body?.expMonth);
  const expYear = Number(body?.expYear);
  const merchant = body?.merchant ?? null;

  if (!/^\d{12,19}$/.test(pan) || !luhnValid(pan)) {
    return json({ error: 'Invalid card number' }, 400);
  }
  if (!/^\d{3,4}$/.test(cvv)) {
    return json({ error: 'Invalid CVV' }, 400);
  }
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
    return json({ error: 'Invalid expiry month' }, 400);
  }
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  if (!Number.isInteger(expYear) || expYear < currentYear || expYear > currentYear + 20) {
    return json({ error: 'Invalid expiry year' }, 400);
  }
  if (expYear === currentYear && expMonth < now.getUTCMonth() + 1) {
    return json({ error: 'Card has expired' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const brand = detectBrand(pan);
  const last4 = pan.slice(-4);
  const bin = pan.slice(0, 6);
  const fingerprint = await sha256Hex(pan);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await admin
    .from('payment_methods')
    .insert({
      merchant_id: merchant,
      brand,
      last4,
      bin,
      exp_month: expMonth,
      exp_year: expYear,
      fingerprint,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  // pan and cvv fall out of scope here — never persisted, never logged, never echoed back.
  return json({ token: data.id, brand, last4, expMonth, expYear });
});
