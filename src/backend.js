import { supabase } from './supabaseClient.js';

// ══════════════════════════════════════════════════════════════
// Bridges the Supabase backend into the legacy global-script UI.
// Exposed as window.SP_DB so the classic <script> blocks in
// index.html can call it without a bundler-managed import graph.
// ══════════════════════════════════════════════════════════════

const centsToRand = (c) => Math.round(c) / 100;
const randToCents = (r) => Math.round(Number(r) * 100);

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// DB statuses that don't have a matching UI badge class collapse onto one that does.
function displayStatus(status) {
  if (status === 'approved') return 'success';
  if (status === 'declined') return 'failed';
  return status;
}

function mapTxnRow(row) {
  return {
    ref: row.ref,
    type: row.type,
    method: row.method,
    bank: row.bank,
    cust: row.customer_name,
    amount: centsToRand(row.amount_cents),
    risk: row.risk_score,
    status: displayStatus(row.status),
    time: formatTime(row.created_at),
  };
}

function mapRefundRow(row) {
  return {
    ref: row.ref,
    orig: row.transaction_ref,
    type: row.type,
    amount: centsToRand(row.amount_cents),
    reason: row.reason,
    status: row.status,
    time: formatTime(row.created_at),
  };
}

function mapAuditRow(row) {
  const amount = row.metadata?.amount;
  const resource = amount != null ? `${row.entity_id} · R ${Number(amount).toFixed(2)}` : row.entity_id;
  const severity = ['declined', 'pending_4eyes'].includes(row.metadata?.status) ? 'high' : 'low';
  return {
    user: row.actor?.name || 'System',
    action: row.action.replace(/\./g, '_').toUpperCase(),
    resource,
    severity,
    ip: row.metadata?.ip || 'unknown',
    time: new Date(row.created_at).toLocaleString('en-ZA', { hour12: false }),
  };
}

async function fetchTransactions(limit = 200) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(mapTxnRow);
}

async function fetchRefunds(limit = 100) {
  const { data, error } = await supabase
    .from('refunds')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(mapRefundRow);
}

async function fetchAuditLog(limit = 100) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*, actor:profiles(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(mapAuditRow);
}

async function fetchMerchants() {
  const { data, error } = await supabase
    .from('merchants')
    .select('*')
    .order('name');
  if (error) throw error;
  return data;
}

function subscribeTransactions(onInsert) {
  return supabase
    .channel('public:transactions')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, (payload) => {
      onInsert(mapTxnRow(payload.new));
    })
    .subscribe();
}

function subscribeRefunds(onInsert) {
  return supabase
    .channel('public:refunds')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'refunds' }, (payload) => {
      onInsert(mapRefundRow(payload.new));
    })
    .subscribe();
}

function subscribeAuditLog(onInsert) {
  return supabase
    .channel('public:audit_log')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_log' }, async (payload) => {
      // The realtime payload doesn't include the joined profile name; look it up.
      const row = payload.new;
      let actorName = 'System';
      if (row.actor_id) {
        const { data } = await supabase.from('profiles').select('name').eq('id', row.actor_id).maybeSingle();
        if (data) actorName = data.name;
      }
      onInsert(mapAuditRow({ ...row, actor: { name: actorName } }));
    })
    .subscribe();
}

// ── Auth ────────────────────────────────────────────────────────

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

async function listMfaFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data.totp || [];
}

async function challengeMfa(factorId) {
  const { data, error } = await supabase.auth.mfa.challenge({ factorId });
  if (error) throw error;
  return data;
}

async function verifyMfa(factorId, challengeId, code) {
  const { data, error } = await supabase.auth.mfa.verify({ factorId, challengeId, code });
  return { data, error };
}

async function getProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  return data;
}

async function signOut() {
  await supabase.auth.signOut();
}

// ── Payment / refund processing (server-side via Edge Functions) ─

function newIdempotencyKey() {
  return crypto.randomUUID();
}

async function createPayment(payload) {
  const body = { idempotencyKey: newIdempotencyKey(), ...payload };
  const { data, error } = await supabase.functions.invoke('process-payment', { body });
  if (error) throw error;
  return data;
}

async function createRefund(payload) {
  const body = { idempotencyKey: newIdempotencyKey(), ...payload };
  const { data, error } = await supabase.functions.invoke('process-refund', { body });
  if (error) throw error;
  return data;
}

window.SP_DB = {
  supabase,
  fetchTransactions,
  fetchRefunds,
  fetchAuditLog,
  fetchMerchants,
  subscribeTransactions,
  subscribeRefunds,
  subscribeAuditLog,
  signIn,
  listMfaFactors,
  challengeMfa,
  verifyMfa,
  getProfile,
  signOut,
  createPayment,
  createRefund,
  randToCents,
};

window.dispatchEvent(new Event('sp-db-ready'));
