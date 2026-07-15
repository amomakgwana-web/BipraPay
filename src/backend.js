import { supabase, SP_ENV } from './supabaseClient.js';

// ══════════════════════════════════════════════════════════════
// Bridges the Supabase backend into the legacy global-script UI.
// Exposed as window.SP_DB so the classic <script> blocks in
// index.html can call it without a bundler-managed import graph.
// ══════════════════════════════════════════════════════════════

const centsToRand = (c) => Math.round(c) / 100;
const randToCents = (r) => Math.round(Number(r) * 100);

// ── Real client-side observability ──────────────────────────────
// Captures actual runtime errors from this running app — not simulated
// CloudWatch data. Best-effort: a logging failure must never itself throw.

async function logClientError(source, message, stack, metadata) {
  try {
    await supabase.from('client_errors').insert({
      source,
      message: String(message ?? 'Unknown error').slice(0, 2000),
      stack: stack ? String(stack).slice(0, 4000) : null,
      url: location.href,
      user_agent: navigator.userAgent,
      metadata: metadata ?? null,
    });
  } catch (_e) { /* best-effort */ }
}

window.addEventListener('error', (e) => {
  logClientError('js_error', e.message, e.error?.stack, { filename: e.filename, lineno: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  logClientError('unhandled_rejection', reason?.message || String(reason), reason?.stack, null);
});

// Every edge-function call in this file goes through supabase.functions.invoke,
// so wrapping it once here captures API failures from every flow (payments,
// refunds, KYC, disputes, settlements, webhooks, DSAR, FIC) without touching
// each call site.
const _rawInvoke = supabase.functions.invoke.bind(supabase.functions);
supabase.functions.invoke = async (name, opts) => {
  const res = await _rawInvoke(name, opts);
  if (res.error) logClientError('api_error', res.error.message || String(res.error), null, { function: name });
  return res;
};

async function fetchClientErrors(limit = 100) {
  const { data, error } = await supabase.from('client_errors').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

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

const KYC_STAGE_LABELS = {
  document_review: 'Document Review',
  fica_check: 'FICA Check',
  aml_screening: 'AML Screening',
  manual_review: 'Manual Review',
  approved: 'Approved',
  rejected: 'Rejected',
};

function mapKycRow(row) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(row.submitted_at).getTime()) / 86400000));
  return {
    id: row.id,
    name: row.business_name,
    type: row.business_type,
    mcc: row.mcc,
    stage: KYC_STAGE_LABELS[row.stage] || row.stage,
    decided: ['approved', 'rejected'].includes(row.stage),
    risk: row.risk.charAt(0).toUpperCase() + row.risk.slice(1),
    submitted: new Date(row.submitted_at).toISOString().slice(0, 10),
    days,
  };
}

async function fetchKycCases() {
  const { data, error } = await supabase
    .from('kyc_cases')
    .select('*')
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return data.map(mapKycRow);
}

async function decideKyc(caseId, decision, reason) {
  const { data, error } = await supabase.functions.invoke('kyc-decision', { body: { caseId, decision, reason } });
  if (error) throw error;
  return data;
}

const DISPUTE_STAGE_LABELS = { evidence_required: 'Evidence Required', under_review: 'Under Review', resolved: 'Resolved' };

function mapDisputeRow(row) {
  const deadline = row.deadline_at ? Math.ceil((new Date(row.deadline_at).getTime() - Date.now()) / 86400000) : null;
  return {
    id: row.id,
    txn: row.transaction_ref,
    cust: row.transactions?.customer_name || '—',
    amount: centsToRand(row.amount_cents),
    reason: row.reason,
    scheme: row.scheme,
    code: row.reason_code,
    deadline,
    status: row.status,
    stage: DISPUTE_STAGE_LABELS[row.stage] || row.stage,
  };
}

async function fetchDisputes() {
  const { data, error } = await supabase
    .from('disputes')
    .select('*, transactions(customer_name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(mapDisputeRow);
}

async function resolveDispute(disputeId, outcome, note) {
  const { data, error } = await supabase.functions.invoke('dispute-resolve', { body: { disputeId, outcome, note } });
  if (error) throw error;
  return data;
}

function mapApiKeyRow(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    environment: row.environment,
    scopes: row.scopes,
    revoked: !!row.revoked_at,
    createdAt: new Date(row.created_at).toISOString().slice(0, 10),
    lastUsed: row.last_used_at ? new Date(row.last_used_at).toISOString().slice(0, 10) : 'Never',
  };
}

async function fetchApiKeys() {
  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(mapApiKeyRow);
}

async function createApiKey(name, environment, scopes) {
  const { data, error } = await supabase.functions.invoke('manage-api-key', { body: { action: 'create', name, environment, scopes } });
  if (error) throw error;
  return data;
}

async function revokeApiKey(keyId) {
  const { data, error } = await supabase.functions.invoke('manage-api-key', { body: { action: 'revoke', keyId } });
  if (error) throw error;
  return data;
}

async function hasPermission(perm) {
  const { data, error } = await supabase.rpc('has_permission', { perm });
  if (error) { console.error('[BipraPay] has_permission check failed', error); return false; }
  return !!data;
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

async function tokenizeCard(payload) {
  const { data, error } = await supabase.functions.invoke('vault-tokenize', { body: payload });
  if (error) throw error;
  return data;
}

async function createPayment(payload) {
  const body = { idempotencyKey: newIdempotencyKey(), ...payload };
  const { data, error } = await supabase.functions.invoke('process-payment', { body });
  if (error) throw error;
  return data;
}

async function confirmThreeDs(ref, otp) {
  const body = { ref, otp, idempotencyKey: newIdempotencyKey() };
  const { data, error } = await supabase.functions.invoke('confirm-3ds', { body });
  if (error) throw error;
  return data;
}

async function createRefund(payload) {
  const body = { idempotencyKey: newIdempotencyKey(), ...payload };
  const { data, error } = await supabase.functions.invoke('process-refund', { body });
  if (error) throw error;
  return data;
}

// ── Settlement ledger ────────────────────────────────────────────

function mapSettlementRow(row) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    merchantName: row.merchants?.name || row.merchant_id,
    batchDate: row.batch_date,
    status: row.status,
    txnCount: row.txn_count,
    gross: centsToRand(row.gross_amount_cents),
    fee: centsToRand(row.fee_amount_cents),
    net: centsToRand(row.net_amount_cents),
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

async function fetchSettlements(limit = 50) {
  const { data, error } = await supabase
    .from('settlements')
    .select('*, merchants(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(mapSettlementRow);
}

async function runSettlement() {
  const { data, error } = await supabase.functions.invoke('run-settlement', { body: { action: 'generate' } });
  if (error) throw error;
  return data;
}

async function markSettlementPaid(settlementId) {
  const { data, error } = await supabase.functions.invoke('run-settlement', { body: { action: 'markPaid', settlementId } });
  if (error) throw error;
  return data;
}

// ── Webhook delivery infrastructure ────────────────────────────────

function mapWebhookEndpointRow(row) {
  return { id: row.id, url: row.url, events: row.events, enabled: row.enabled, createdAt: row.created_at };
}

async function fetchWebhookEndpoints() {
  const { data, error } = await supabase.from('webhook_endpoints').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(mapWebhookEndpointRow);
}

function mapDeliveryRow(row) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    url: row.webhook_endpoints?.url || '—',
    event: row.event_type,
    status: row.status,
    responseCode: row.response_code,
    durationMs: row.duration_ms,
    time: row.last_attempt_at || row.created_at,
  };
}

async function fetchWebhookDeliveries(limit = 50) {
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .select('*, webhook_endpoints(url)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(mapDeliveryRow);
}

async function createWebhookEndpoint(url, events) {
  const { data, error } = await supabase.functions.invoke('manage-webhook', { body: { action: 'create', url, events } });
  if (error) throw error;
  return data;
}

async function deleteWebhookEndpoint(endpointId) {
  const { data, error } = await supabase.functions.invoke('manage-webhook', { body: { action: 'delete', endpointId } });
  if (error) throw error;
  return data;
}

async function sendTestWebhook(endpointId) {
  const { data, error } = await supabase.functions.invoke('manage-webhook', { body: { action: 'sendTest', endpointId } });
  if (error) throw error;
  return data;
}

// ── POPIA DSAR requests ─────────────────────────────────────────────

async function fetchDsarRequests() {
  const { data, error } = await supabase.from('dsar_requests').select('*').order('requested_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function createDsarRequest(subjectName, subjectEmail, requestType) {
  const { data, error } = await supabase.functions.invoke('dsar-request', { body: { action: 'create', subjectName, subjectEmail, requestType } });
  if (error) throw error;
  return data;
}

async function exportDsarRequest(requestId) {
  const { data, error } = await supabase.functions.invoke('dsar-request', { body: { action: 'export', requestId } });
  if (error) throw error;
  return data;
}

async function updateDsarStatus(requestId, status, notes) {
  const { data, error } = await supabase.functions.invoke('dsar-request', { body: { action: 'updateStatus', requestId, status, notes } });
  if (error) throw error;
  return data;
}

// ── FIC (Financial Intelligence Centre) reporting register ──────────

async function fetchFicReports() {
  const { data, error } = await supabase.from('fic_reports').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function createFicReport(reportType, transactionRef, reason, amountCents) {
  const { data, error } = await supabase.functions.invoke('fic-report', { body: { action: 'create', reportType, transactionRef, reason, amountCents } });
  if (error) throw error;
  return data;
}

async function submitFicReport(reportId) {
  const { data, error } = await supabase.functions.invoke('fic-report', { body: { action: 'submit', reportId } });
  if (error) throw error;
  return data;
}

window.SP_DB = {
  supabase,
  env: SP_ENV,
  fetchTransactions,
  fetchRefunds,
  fetchAuditLog,
  fetchMerchants,
  fetchKycCases,
  decideKyc,
  fetchDisputes,
  resolveDispute,
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
  hasPermission,
  subscribeTransactions,
  subscribeRefunds,
  subscribeAuditLog,
  signIn,
  listMfaFactors,
  challengeMfa,
  verifyMfa,
  getProfile,
  signOut,
  tokenizeCard,
  createPayment,
  confirmThreeDs,
  createRefund,
  randToCents,
  fetchSettlements,
  runSettlement,
  markSettlementPaid,
  fetchWebhookEndpoints,
  fetchWebhookDeliveries,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  sendTestWebhook,
  fetchDsarRequests,
  createDsarRequest,
  exportDsarRequest,
  updateDsarStatus,
  fetchFicReports,
  createFicReport,
  submitFicReport,
  fetchClientErrors,
};

window.dispatchEvent(new Event('sp-db-ready'));
