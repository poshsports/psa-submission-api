// api/admin/group-members.js (ESM)
import { requireAdmin } from './_util/adminAuth.js';
import { sb } from './_util/supabase.js';

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

  let { group_id, code } = req.query;

  try {
    // Resolve code -> id if needed
    if (!group_id && code && !UUID_RE.test(code)) {
      const { data: g, error } = await sb()
        .from('groups')
        .select('id')
        .eq('code', String(code).trim())
        .single();
      if (error || !g) {
        res.status(404).json({ ok: false, error: 'Group not found by code' });
        return;
      }
      group_id = g.id;
    }

    if (!group_id || !UUID_RE.test(group_id)) {
      res.status(400).json({ ok: false, error: 'Provide group_id (uuid) or code' });
      return;
    }

    // Pull members from group_submissions and join psa_submissions for display fields
    const { data, error } = await sb()
      .from('group_submissions')
      .select(`
        position,
        note,
        submission_id,
        submission:psa_submissions (
          submission_id,
          customer_email,
          status,
          created_at,
          grading_service
        )
      `)
      .eq('group_id', group_id)
      .order('position', { ascending: true });

    if (error) {
      res.status(500).json({ ok: false, error: error.message || 'Database error' });
      return;
    }

    res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
