// api/admin/groups.close.js (ESM)
import { requireAdmin } from '../_util/adminAuth.js';
import { sb } from '../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method Not Allowed' });
      return;
    }
    if (!requireAdmin(req)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const raw = String(req.body?.group_id || '').trim();
    if (!raw) {
      res.status(400).json({ ok: false, error: 'Missing group_id' });
      return;
    }

    const client = sb();

    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data, error } = await client
        .from('groups')
        .select('id')
        .eq('code', raw)
        .single();
      if (error || !data?.id) {
        res.status(404).json({ ok: false, error: 'Group not found' });
        return;
      }
      groupId = data.id;
    }

    const { data: up, error: upErr } = await client
      .from('groups')
      .update({ status: 'Closed', reopen_hold: false })
      .eq('id', groupId)
      .select('id, code, status')
      .single();

    if (upErr) {
      res.status(500).json({ ok: false, error: upErr.message || 'Update failed' });
      return;
    }

    res.status(200).json({ ok: true, group: up });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
