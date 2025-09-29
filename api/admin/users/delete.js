// /api/admin/users/delete.js
import { sb } from '../../_util/supabase.js';
import { requireOwner } from '../../_util/adminAuth.js';

const json = (res, s, p) => (res.status(s).setHeader('Content-Type','application/json'), res.end(JSON.stringify(p)));
const readBody = async (req) => {
  const chunks = []; for await (const ch of req) chunks.push(Buffer.from(ch));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
const me = await requireOwner(req, res);
if (!me) return;


  const { id, hard } = await readBody(req);
  if (!id) return json(res, 400, { error: 'id is required' });

  const client = sb();

  // Load user row
  const { data: row, error } = await client
    .from('admin_users')
    .select('id, email, role, is_active, auth_user_id')
    .eq('id', id).single();
  if (error || !row) return json(res, 404, { error: 'User not found' });

  // Safety: don’t allow deleting yourself or the last owner
  // (Adjust if your requireAdmin can give you the current admin email)
  const { data: owners } = await client.from('admin_users')
    .select('id').eq('role','owner').eq('is_active', true);
  if (row.role === 'owner' && (owners?.length ?? 0) <= 1)
    return json(res, 400, { error: 'Cannot delete the last owner' });

  // Soft delete in your table
  const { error: upErr } = await client
    .from('admin_users')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (upErr) return json(res, 500, { error: 'Failed to deactivate user' });

  // Optional HARD delete from Supabase Auth (only if you want it and you have the auth_user_id)
  if (hard && row.auth_user_id) {
    try { await client.auth.admin.deleteUser(row.auth_user_id); } catch {}
  }

  return json(res, 200, { ok: true });
}
