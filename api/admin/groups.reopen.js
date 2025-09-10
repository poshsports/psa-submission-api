// api/admin/groups.reopen.js
import { requireAdmin } from './_util/adminAuth.js';
import { sb } from './_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }
    if (!requireAdmin(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { group_id, group_code } = req.body || {};
    let where;
    if (group_id && UUID_RE.test(String(group_id))) {
      where = { column: 'id', value: String(group_id) };
    } else if (group_code) {
      where = { column: 'code', value: String(group_code).trim() };
    } else {
      return res.status(400).json({ ok: false, error: 'Missing group_id or group_code' });
    }

    const client = sb();
    const { data: grp, error: gErr } = await client
      .from('groups')
      .select('id, code, status')
      .eq(where.column, where.value)
      .single();
    if (gErr || !grp?.id) {
      return res.status(404).json({ ok: false, error: 'Group not found' });
    }

    // Re-open means: unlock editing again. We set status back to "Returned".
    const { error: uErr } = await client
      .from('groups')
      .update({ status: 'Returned', updated_at: new Date().toISOString() })
      .eq('id', grp.id);

    if (uErr) return res.status(500).json({ ok: false, error: uErr.message || 'Update failed' });

    return res.status(200).json({
      ok: true,
      group: { id: grp.id, code: grp.code, status: 'Returned' }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
