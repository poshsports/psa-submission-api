// /api/admin/login.js
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// Create a server-side Supabase client with the Service Role key (bypasses RLS)
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(res, 500, { error: 'Server missing Supabase env vars' });
    }

    const { email = '', password = '' } = (await readBody(req)) || {};
    if (!email || !password) return json(res, 400, { error: 'Email and password are required' });

    // 1) Must be an active admin user (case-insensitive match)
    const { data: admin, error: adminErr } = await sb
      .from('admin_users')
      .select('id, role, is_active')
      .ilike('email', email)       // case-insensitive
      .maybeSingle();

    if (adminErr) return json(res, 500, { error: 'Admin lookup failed', details: adminErr.message });
    if (!admin || !admin.is_active) return json(res, 403, { error: 'No access' });

    // 2) Validate the credentials
    const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email, password });
    if (authErr) return json(res, 401, { error: 'Invalid email or password' });

    // 3) Set session cookie (httpOnly). Name can be anything your frontend expects.
    const access = auth.session?.access_token;
    if (!access) return json(res, 500, { error: 'No session token returned' });

// Set BOTH cookies: a front-end readable role + a real HttpOnly session
const role = String(admin.role || 'staff').toLowerCase();

const isLocal = (req.headers.host || '').startsWith('localhost');
const flags = `Path=/; SameSite=Lax; ${isLocal ? '' : 'Secure; '}Max-Age=604800`;

res.setHeader('Set-Cookie', [
  `psa_admin=1; ${flags}`,                    // optional "I'm an admin UI" flag
  `psa_role=${role}; ${flags}`,               // readable by JS (no HttpOnly)
  `psa_admin_session=${access}; ${flags}; HttpOnly`, // real session token
]);

return json(res, 200, { ok: true, role });


  } catch (e) {
    return json(res, 500, { error: 'Server error', details: String(e?.message || e) });
  }
}

// tiny body reader for Vercel/Node
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
