// /api/_util/adminAuth.js  (ESM)
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// Server-side Supabase client (Service Role so we can validate tokens and read admin_users)
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function parseCookies(req) {
  const h = req.headers?.cookie || '';
  const out = {};
  h.split(';').map(v => v.trim()).filter(Boolean).forEach(kv => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  return out;
}

async function getAdminUserFromRequest(req) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  const cookies = parseCookies(req);
  const accessToken = cookies['psa_admin_session'];
  if (!accessToken) return null;

  // 1) Validate Supabase auth token
  const { data: auth, error: authErr } = await sb.auth.getUser(accessToken);
  if (authErr || !auth?.user?.email) return null;

  const email = String(auth.user.email).toLowerCase();

  // 2) Enforce admin access + role via your admin_users table
  const { data: admin, error: adminErr } = await sb
    .from('admin_users')
    .select('id, email, role, is_active')
    .ilike('email', email)
    .maybeSingle();

  if (adminErr || !admin || !admin.is_active) return null;

  return {
    id: admin.id,
    email: admin.email,
    role: String(admin.role || 'staff').toLowerCase(),
    supabase_user_id: auth.user.id,
  };
}

/** Require any admin (staff/manager/owner). */
export async function requireAdmin(req, res) {
  try {
    const me = await getAdminUserFromRequest(req);
    if (me) return me;
  } catch {}
  if (res) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  }
  return null;
}

/** Require owner role specifically. */
export async function requireOwner(req, res) {
  const me = await requireAdmin(req, res);
  if (!me) return null;
  if (me.role !== 'owner') {
    if (res) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden (owner role required)' }));
    }
    return null;
  }
  return me;
}

// Optional helper if a route wants to read user without enforcing
export async function getOptionalAdmin(req) {
  try { return await getAdminUserFromRequest(req); } catch { return null; }
}
