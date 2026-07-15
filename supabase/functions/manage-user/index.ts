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
  if (!['invite', 'setRole', 'deactivate', 'reactivate'].includes(action)) {
    return json({ error: 'action must be "invite", "setRole", "deactivate" or "reactivate"' }, 400);
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

    const password = tempPassword();
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, role: ROLE_LABELS[roleId], role_id: roleId },
    });
    if (error) return json({ error: error.message }, error.message.includes('already') ? 409 : 500);

    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'user.invited',
      entity_type: 'profile',
      entity_id: created.user.id,
      metadata: { email, name, role_id: roleId, ip },
    });

    // The temporary password is returned exactly once, to the inviting
    // admin, and never stored anywhere retrievable.
    return json({ id: created.user.id, email, name, roleId, tempPassword: password });
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
