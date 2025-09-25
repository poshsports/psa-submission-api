// /api/admin/users/list.js
import { sb } from '../../_util/supabase.js';
import { requireAdmin } from '../../_util/adminAuth.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
    const ok = await requireAdmin(req, res); if (!ok) return; // 401 handled inside

    const { data, error } = await sb()
      .from('admin_users')
      .select('id, email, name, role, is_active, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: 'Failed to load users', details: error.message });
    return res.status(200).json({ users: data || [] });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
