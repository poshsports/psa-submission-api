// /api/admin/users/me.js  (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  // Gate: returns false and sends 401 if not signed in.
  const ok = await requireAdmin(req, res);
  if (!ok) return;

  // Most implementations of requireAdmin attach the user:
  //   req.admin = { id, email, role, ... }
  // If yours doesn’t, adapt this to however you expose the session user.
  const me = req.admin || req.user || null;

  return json(res, 200, {
    id: me?.id ?? me?.auth_user_id ?? null,
    email: me?.email ?? null
  });
}
