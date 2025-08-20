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
    req.query.include === 'members' || req.query.with === 'members';

  try {
    // Resolve the group id:
    // - if raw is a UUID: use it directly
    // - else: treat it as a code like "GRP-0005" and look up its UUID
    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: codeErr } = await sb()
        .from('groups')
        .select('id')
        .eq('code', raw)
        .single();

      if (codeErr) {
        res.status(404).json({ ok: false, error: 'Group not found by code' });
        return;
      }
      groupId = byCode.id;
    }

    // Pull the base group row. Use your RPC if you need its shaping,
    // but return the **raw object** (no {ok, group} wrapper) so the UI reads it directly.
    let group = null;
    {
      const { data, error } = await sb().rpc('get_group', { p_group_id: groupId });
      if (error) {
        res.status(500).json({ ok: false, error: error.message || 'Database error' });
        return;
      }
      group = Array.isArray(data) ? data[0] : data;
      if (!group) {
        res.status(404).json({ ok: false, error: 'Group not found' });
        return;
      }
    }

    // Optionally include members (works with the common group_members schema)
    if (includeMembers) {
      const { data: members, error: mErr } = await sb()
        .from('group_members')// api/admin/groups/[id].js (ESM)
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
    // 1) Base group
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

    // 2) Optional members
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

    res.status(200).json({ ok: true, group });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };

        .select('position, note, submission_id')
        .eq('group_id', groupId)
        .order('position', { ascending: true });

      if (!mErr) group.members = members || [];
      // if there is a members error, we just omit them; UI has a fallback path anyway
    }

    // IMPORTANT: return the group object itself (not { ok, group })
    res.status(200).json(group);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

// Force Node runtime
export const config = { runtime: 'nodejs' };
