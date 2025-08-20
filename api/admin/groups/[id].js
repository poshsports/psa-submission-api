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

  const includeMembers = String(req.query.include || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .includes('members');

  try {
    // 1) Fetch the base group
    const { data: group, error: gErr } = await sb()
      .from('groups')
      .select('id, code, status, notes, shipped_at, returned_at, updated_at, created_at')
      .eq('id', id)
      .single();

    if (gErr) {
      res.status(500).json({ ok: false, error: gErr.message || 'Database error' });
      return;
    }
    if (!group) {
      res.status(404).json({ ok: false, error: 'Group not found' });
      return;
    }

    // 2) If requested, attach members
    if (includeMembers) {
      const { data: members, error: mErr } = await sb()
        .from('group_members')
        .select('submission_id, position, note')
        .eq('group_id', id)
        .order('position', { ascending: true });

      if (mErr) {
        res.status(500).json({ ok: false, error: mErr.message || 'Members query failed' });
        return;
      }

      group.members = members || [];
    }

    // Return a clean JSON
    res.status(200).json(group);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
