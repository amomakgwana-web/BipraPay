import { createClient } from 'jsr:@supabase/supabase-js@2';

// Public endpoint (no auth) — a prospective company submits its details to
// request a login. Always inserts via the service role since the requester
// has no account yet. An admin reviews and approves/rejects from the
// console (manage-user: approveAccessRequest / rejectAccessRequest).

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

  const {
    companyName, tradingName, registrationNumber,
    contactName, contactEmail, contactPhone,
    businessType, expectedMonthlyVolume, useCase,
  } = body ?? {};

  if (!companyName || typeof companyName !== 'string') {
    return json({ error: 'Company name is required' }, 400);
  }
  if (!contactName || typeof contactName !== 'string') {
    return json({ error: 'Contact name is required' }, 400);
  }
  if (typeof contactEmail !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    return json({ error: 'A valid contact email is required' }, 400);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await admin
    .from('access_requests')
    .insert({
      company_name: companyName.slice(0, 200),
      trading_name: tradingName ? String(tradingName).slice(0, 200) : null,
      registration_number: registrationNumber ? String(registrationNumber).slice(0, 60) : null,
      contact_name: contactName.slice(0, 120),
      contact_email: contactEmail.slice(0, 200),
      contact_phone: contactPhone ? String(contactPhone).slice(0, 40) : null,
      business_type: businessType ? String(businessType).slice(0, 80) : null,
      expected_monthly_volume: expectedMonthlyVolume ? String(expectedMonthlyVolume).slice(0, 40) : null,
      use_case: useCase ? String(useCase).slice(0, 1000) : null,
    })
    .select('id, created_at')
    .single();
  if (error) return json({ error: error.message }, 500);

  return json({ id: data.id, createdAt: data.created_at });
});
