// /api/admin/users/update-role.js
import { createClient } from '@supabase/supabase-js';
import { requireOwner } from '../../_util/adminAuth.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  // must be owner
  const me = await requireOwner(req, res);
  if (!me) return; // requireOwner already wrote the 401/403

  try {
    const { id, role } = await readBody(req);

    if (!id || !role) return json(res, 400, { error: 'Missing id or role' });

    // allowed values only
    const allowed = new Set(['staff', 'manager', 'owner']);
    const nextRole = String(role).toLowerCase();
    if (!allowed.has(nextRole)) return json(res, 400, { error: 'Invalid role' });

    // block editing self
    if (String(id) === String(me.id)) {
      return json(res, 403, { error: 'You cannot change your own role.' });
    }

    const { data, error } = await sb
      .from('admin_users')
      .update({ role: nextRole })
      .eq('id', id)
      .select('id, email, role')
      .maybeSingle();

    if (error) return json(res, 500, { error: 'Update failed', details: error.message });
    if (!data) return json(res, 404, { error: 'User not found' });

    return json(res, 200, { ok: true, user: data });
  } catch (e) {
    return json(res, 500, { error: 'Server error', details: String(e?.message || e) });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
