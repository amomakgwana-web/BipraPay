import { createClient } from 'jsr:@supabase/supabase-js@2';

// Staff user management: invite, role assignment, deactivate/reactivate.
// Gated on the 'users' permission (Super Admin only by default). Invites
// create the account with a generated temporary password returned exactly
// once — email-link invites can replace this once an SMTP provider is
// configured. Deactivation applies a long auth-level ban (which is what
// actually blocks sign-in) and mirrors it to profiles.is_active.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tempPassword(): string {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  // Base64url, prefixed to satisfy common complexity rules.
  return 'Bp1!' + btoa(String.fromCharCode(...arr)).replace(/[+/=]/g, '').slice(0, 14);
}

async function createAccount(
  admin: ReturnType<typeof createClient>,
  email: string, name: string, roleId: string, roleLabel: string,
) {
  const password = tempPassword();
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name, role: roleLabel, role_id: roleId },
  });
  if (error) return { error };
  return { id: created.user.id, password };
}

const VALID_ROLES = ['super_admin', 'finance', 'developer', 'support', 'risk_analyst', 'read_only'];
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  finance: 'Finance',
  developer: 'Developer',
  support: 'Support',
  risk_analyst: 'Risk Analyst',
  read_only: 'Read-Only',
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { action } = body ?? {};
  const VALID_ACTIONS = ['invite', 'setRole', 'deactivate', 'reactivate', 'approveAccessRequest', 'rejectAccessRequest'];
  if (!VALID_ACTIONS.includes(action)) {
    return json({ error: `action must be one of ${VALID_ACTIONS.join(', ')}` }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: hasPerm } = await userClient.rpc('has_permission', { perm: 'users' });
  if (!hasPerm) return json({ error: 'Your role does not have permission to manage users' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (action === 'invite') {
    const { email, name, roleId } = body;
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: 'A valid email is required' }, 400);
    }
    if (!name || typeof name !== 'string') return json({ error: 'name is required' }, 400);
    if (!VALID_ROLES.includes(roleId)) return json({ error: 'Invalid roleId' }, 400);

    const result = await createAccount(admin, email, name, roleId, ROLE_LABELS[roleId]);
    if ('error' in result) {
      return json({ error: result.error!.message }, result.error!.message.includes('already') ? 409 : 500);
    }

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'user.invited',
      entity_type: 'profile',
      entity_id: result.id,
      metadata: { email, name, role_id: roleId, ip },
    });

    // The temporary password is returned exactly once, to the inviting
    // admin, and never stored anywhere retrievable.
    return json({ id: result.id, email, name, roleId, tempPassword: result.password });
  }

  if (action === 'approveAccessRequest' || action === 'rejectAccessRequest') {
    const { requestId } = body;
    if (!requestId || typeof requestId !== 'string') return json({ error: 'requestId is required' }, 400);

    const { data: reqRow } = await admin.from('access_requests').select('*').eq('id', requestId).maybeSingle();
    if (!reqRow) return json({ error: `Request ${requestId} not found` }, 404);
    if (reqRow.status !== 'pending') return json({ error: `Request ${requestId} is already ${reqRow.status}` }, 400);

    if (action === 'rejectAccessRequest') {
      const { reason } = body;
      const { data, error } = await admin
        .from('access_requests')
        .update({ status: 'rejected', reviewed_by: user.id, reviewed_at: new Date().toISOString(), rejection_reason: reason || null })
        .eq('id', requestId)
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      await admin.from('audit_log').insert({
        actor_id: user.id, action: 'access_request.rejected', entity_type: 'access_request', entity_id: requestId,
        metadata: { company: reqRow.company_name, contact_email: reqRow.contact_email, reason: reason || null, ip },
      });
      return json(data);
    }

    // approveAccessRequest — mints the login account and marks the request approved.
    const { roleId } = body;
    if (!VALID_ROLES.includes(roleId)) return json({ error: 'Invalid roleId' }, 400);

    const result = await createAccount(admin, reqRow.contact_email, reqRow.contact_name, roleId, ROLE_LABELS[roleId]);
    if ('error' in result) {
      return json({ error: result.error!.message }, result.error!.message.includes('already') ? 409 : 500);
    }

    const { data, error } = await admin
      .from('access_requests')
      .update({ status: 'approved', created_user_id: result.id, reviewed_by: user.id, reviewed_at: new Date().toISOString() })
      .eq('id', requestId)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    await admin.from('audit_log').insert({
      actor_id: user.id, action: 'access_request.approved', entity_type: 'access_request', entity_id: requestId,
      metadata: { company: reqRow.company_name, contact_email: reqRow.contact_email, role_id: roleId, created_user_id: result.id, ip },
    });

    return json({ ...data, tempPassword: result.password });
  }

  const { userId } = body;
  if (!userId || typeof userId !== 'string') return json({ error: 'userId is required' }, 400);

  if (action === 'setRole') {
    const { roleId } = body;
    if (!VALID_ROLES.includes(roleId)) return json({ error: 'Invalid roleId' }, 400);
    if (userId === user.id && roleId !== 'super_admin') {
      return json({ error: 'You cannot remove your own Super Admin role' }, 400);
    }

    const { data, error } = await admin
      .from('profiles')
      .update({ role_id: roleId, role: ROLE_LABELS[roleId] })
      .eq('id', userId)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'user.role_changed',
      entity_type: 'profile',
      entity_id: userId,
      metadata: { email: data.email, new_role_id: roleId, ip },
    });

    return json({ id: data.id, roleId: data.role_id });
  }

  // deactivate / reactivate
  if (userId === user.id) return json({ error: 'You cannot deactivate your own account' }, 400);

  const deactivating = action === 'deactivate';
  const { error: banError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: deactivating ? '876000h' : 'none', // ~100 years vs lift
  });
  if (banError) return json({ error: banError.message }, 500);

  const { data, error } = await admin
    .from('profiles')
    .update({ is_active: !deactivating })
    .eq('id', userId)
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  await admin.from('audit_log').insert({
    actor_id: user.id,
    action: deactivating ? 'user.deactivated' : 'user.reactivated',
    entity_type: 'profile',
    entity_id: userId,
    metadata: { email: data.email, ip },
  });

  return json({ id: data.id, isActive: data.is_active });
});
