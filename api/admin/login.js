// /api/admin/login.js
// Email + password admin login: verifies Supabase credentials, checks admin table,
// then sets an httpOnly cookie for the admin portal.

import { createClient as createSb } from '@supabase/supabase-js';
import { sb } from '../../_util/supabase.js';           // your service client
import jwt from 'jsonwebtoken';

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'change-me';

// Small helpers
function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_ANON || !ADMIN_JWT_SECRET) {
    return json(res, 500, { error: 'Server misconfigured (env missing)' });
  }

  try {
    const { email, password } = await readBody(req);
    if (!email || !password) return json(res, 400, { error: 'Email and password are required' });

    // 1) Make sure this user exists in your admin users table AND is active
    const svc = sb(); // service key client
    const { data: adminUser, error: auErr } = await svc
      .from('admin_users')             // <- use your exact table name
      .select('id, email, name, role, is_active')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (auErr)           return json(res, 500, { error: 'DB error' });
    if (!adminUser)      return json(res, 401, { error: 'Not authorized' });
    if (adminUser && adminUser.is_active === false)
                         return json(res, 403, { error: 'User disabled' });

    // 2) Verify credentials with Supabase Auth
    const pub = createSb(SUPABASE_URL, SUPABASE_ANON);
    const { data: signIn, error: signErr } = await pub.auth.signInWithPassword({ email, password });
    if (signErr || !signIn?.session?.access_token)
      return json(res, 401, { error: 'Invalid email or password' });

    // 3) Create a short JWT for your admin portal (what requireAdmin() will verify)
    const payload = {
      sub: adminUser.id,
      email: adminUser.email,
      role: adminUser.role || 'staff',
      kind: 'psa_admin',
    };
    const token = jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '7d' });

    // 4) Set cookie (httpOnly) used by requireAdmin()
    const isProd = process.env.NODE_ENV === 'production';
    const cookie = [
      `psa_admin=${token}`,
      'Path=/',
      'HttpOnly',
      isProd ? 'Secure' : '',
      'SameSite=Lax',
      `Max-Age=${60 * 60 * 24 * 7}`, // 7d
    ].filter(Boolean).join('; ');

    res.setHeader('Set-Cookie', cookie);
    return json(res, 200, { ok: true, user: { id: adminUser.id, email: adminUser.email, role: adminUser.role } });
  } catch (err) {
    console.error('admin/login error', err);
    return json(res, 500, { error: 'Server error' });
  }
}
