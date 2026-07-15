import { createClient } from '@supabase/supabase-js';

// ── Environment selection ────────────────────────────────────────
// Two Supabase projects back this app:
//   production — BipraPay-Production (clean data; staff accounts only)
//   sandbox    — SwizPay (demo/seed data; used by previews and local dev)
// The bundle is static, so the environment is chosen at runtime from the
// hostname. Both values below are public by design (publishable keys);
// access control is enforced by Postgres Row Level Security, not by
// keeping these values secret. See supabase/migrations for the policies.

const ENVIRONMENTS = {
  production: {
    url: 'https://ialcrfvgxinzovykvmzw.supabase.co',
    key: 'sb_publishable_2mVQ9N-eEkWCq74R9jB77Q_8KoPQgPL',
  },
  sandbox: {
    url: 'https://pbwbriebntqjghfppnxh.supabase.co',
    key: 'sb_publishable_STgax_KAT2PUrVPtHKu4mg_nNcgTU1i',
  },
};

const PRODUCTION_HOSTS = [
  'biprapay.com',
  'www.biprapay.com',
  'swiz-pay-amomakgwana-web.vercel.app', // Vercel production alias
  'swiz-pay-git-main-bipra.vercel.app',  // main-branch alias
];

const isProduction = PRODUCTION_HOSTS.includes(location.hostname);
const env = isProduction ? ENVIRONMENTS.production : ENVIRONMENTS.sandbox;

export const SP_ENV = isProduction ? 'production' : 'sandbox';
export const supabase = createClient(env.url, env.key);
