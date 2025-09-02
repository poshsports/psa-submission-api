// /api/admin/groups/[id]/submissions/status.js (ESM)
import { requireAdmin } from '../../../_util/adminAuth.js';
import { sb } from '../../../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED = new Set([
  'pending_payment','submitted','submitted_paid',
  'received','shipped_to_psa','in_grading','graded',
  'shipped_back_to_us','balance_due','paid',
  'shipped_to_customer','delivered'
]);

export default async function handler(req, res) {
  try {
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', ['PATCH']);
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }
    if (!requireAdmin(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const raw = String(req.query.id || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'Missing group id' });

    const body = await parseJson(req);
    const status = String(body?.status || '').trim().toLowerCase();
    if (!ALLOWED.has(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status' });
    }

    const client = sb();

    // Resolve group UUID from code if needed
    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: codeErr } = await client
        .from('groups')
        .select('id')
        .eq('code', raw)
        .single();
      if (codeErr || !byCode?.id) {
        return res.status(404).json({ ok: false, error: 'Group not found' });
      }
      groupId = byCode.id;
    }

    const { data, error } = await client.rpc('set_submissions_status_for_group', {
      p_group_id: groupId,
      p_status: status
    });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Database error' });
    }

    // 'data' is the count updated; normalize to int
    const updated = Number(data || 0);
    return res.status(200).json({ ok: true, updated });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };

async function parseJson(req) {
  if (!req.body) return null;
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}
