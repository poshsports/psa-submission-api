// api/admin/groups/[id].js (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';
import { sb } from '../../_util/supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  if (!requireAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const raw = String(req.query.id || '').trim();
  if (!raw) {
    res.status(400).json({ ok: false, error: 'Missing group id' });
    return;
  }

  const includeMembers =
    String(req.query.include || req.query.with || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .includes('members');

  try {
    // Resolve UUID: if "raw" isn't a UUID, treat it as a code (e.g. "GRP-0005")
    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: codeErr } = await sb()
        .from('groups')
        .select('id')
        .eq('code', raw)
        .single();

      if (codeErr || !byCode) {
        res.status(404).json({ ok: false, error: `Group not found for code "${raw}"` });
        return;
      }
      groupId = byCode.id;
    }

    // Base group
    const { data: group, error: gErr } = await sb()
      .from('groups')
      .select('id, code, status, notes, shipped_at, returned_at, updated_at, created_at')
      .eq('id', groupId)
      .single();

    if (gErr) {
      res.status(500).json({ ok: false, error: gErr.message || 'Database error fetching group' });
      return;
    }
    if (!group) {
      res.status(404).json({ ok: false, error: 'Group not found' });
      return;
    }

    // Optional members
    if (includeMembers) {
      const { data: members, error: mErr } = await sb()
        .from('group_members')
        .select('submission_id, position, note')
        .eq('group_id', groupId)
        .order('position', { ascending: true });

      if (mErr) {
        res.status(500).json({ ok: false, error: mErr.message || 'Database error fetching members' });
        return;
      }
      group.members = members || [];
    }

    // Return the plain group object (frontend expects this)
    res.status(200).json(group);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
