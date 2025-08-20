// api/admin/groups/[id].js  (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';
import { sb } from '../../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    // --- method/auth guards ---
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'Method Not Allowed' });
      return;
    }
    if (!requireAdmin(req)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    // --- parse params ---
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

    // --- resolve group id: accept UUID or code like "GRP-0005" ---
    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: codeErr } = await sb()
        .from('groups')
        .select('id')
        .eq('code', raw)
        .single();
      if (codeErr || !byCode?.id) {
        res.status(404).json({ ok: false, error: 'Group not found' });
        return;
      }
      groupId = byCode.id;
    }

    // --- fetch base group (use RPC if you rely on it to shape columns) ---
    const { data: rpcData, error: rpcErr } = await sb().rpc('get_group', {
      p_group_id: groupId,
    });

    if (rpcErr) {
      res.status(500).json({ ok: false, error: rpcErr.message || 'Database error' });
      return;
    }

    const group = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    if (!group) {
      res.status(404).json({ ok: false, error: 'Group not found' });
      return;
    }

    // --- optionally include members from group_members ---
    if (includeMembers) {
      const { data: members, error: mErr } = await sb()
        .from('group_members')
        .select('submission_id, position, note')
        .eq('group_id', groupId)
        .order('position', { ascending: true });

      if (mErr) {
        // Prefer returning the group over failing entirely — the UI can still render
        // but do surface the error so you can see it during dev.
        res
          .status(200)
          .json({ ...group, members: [], _members_error: mErr.message });
        return;
      }
      group.members = members || [];
    }

    // IMPORTANT: return the *group object itself* (not { ok, group })
    res.status(200).json(group);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

// Force Node runtime on Vercel
export const config = { runtime: 'nodejs' };
