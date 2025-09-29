// /api/_util/adminAuth.js
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function parseCookieHeader(h) {
  if (!h) return {};
  const raw = Array.isArray(h) ? h.join(';') : String(h);
  return Object.fromEntries(
    raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf('=');
        return i === -1 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
      }),
  );
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Simple guard: requires an auth cookie (psa_admin_session).
 * Returns true if present; otherwise writes 401 and returns false.
 */
export function requireAdmin(req, res) {
  const cookies = parseCookieHeader(req.headers?.cookie || req.headers?.Cookie);
  const token = cookies['psa_admin_session'];
  if (!token) {
    send(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Strict guard for owner-only routes.
 * - verifies psa_admin_session exists
 * - checks psa_role === 'owner'
 * - resolves the caller’s admin row (id/email/role/is_active)
 * Returns the admin row on success; otherwise writes 401/403 and returns null.
 */
export async function requireOwner(req, res) {
  const cookies = parseCookieHeader(req.headers?.cookie || req.headers?.Cookie);
  const token = cookies['psa_admin_session'] || '';
  const role = (cookies['psa_role'] || '').toLowerCase();

  if (!token) {
    send(res, 401, { error: 'Unauthorized' });
    return null;
  }
  if (role !== 'owner') {
    send(res, 403, { error: 'Forbidden' });
    return null;
  }

  // Get user from access token
  const { data: u, error: uErr } = await sb.auth.getUser(token);
  if (uErr || !u?.user?.email) {
    send(res, 401, { error: 'Unauthorized' });
    return null;
  }

  // Look up the admin row for this user
  const { data: me, error: aErr } = await sb
    .from('admin_users')
    .select('id, email, role, is_active')
    .ilike('email', u.user.email)
    .maybeSingle();

  if (aErr) {
    send(res, 500, { error: 'Admin lookup failed', details: aErr.message });
    return null;
  }
  if (!me || !me.is_active) {
    send(res, 403, { error: 'Forbidden' });
    return null;
  }
  if (String(me.role || '').toLowerCase() !== 'owner') {
    send(res, 403, { error: 'Forbidden' });
    return null;
  }

  return me;
}
