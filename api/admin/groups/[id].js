// api/admin/groups/[id].js (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';
import { sb } from '../../_util/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  if (!requireAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const id = String(req.query.id || '').trim();
  if (!id) {
    res.status(400).json({ ok: false, error: 'Missing group id' });
    return;
  }

  try {
    const { data, error } = await sb().rpc('get_group', { p_group_id: id });

    if (error) {
      res.status(500).json({ ok: false, error: error.message || 'Database error' });
      return;
    }
    if (!data) {
      res.status(404).json({ ok: false, error: 'Group not found' });
      return;
    }

    res.status(200).json({ ok: true, group: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

// Force Node runtime
export const config = { runtime: 'nodejs' };
