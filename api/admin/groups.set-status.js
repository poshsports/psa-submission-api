// api/admin/groups.set-status.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// must match the CHECK constraint in psa_submissions
const ALLOWED = new Set([
  'pending_payment',
  'submitted',
  'submitted_paid',
  'received',
  'shipped_to_psa',
  'in_grading',
  'graded',
  'shipped_back_to_us',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered'
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const status = body.status;

    if (!ALLOWED.has(status)) {
      return res.status(400).json({ ok: false, error: `invalid status "${status}"` });
    }

    // Resolve the group id from either group_id or group_code
    let groupId = body.group_id;
    if (!groupId && body.group_code) {
      const { data: g, error: gerr } = await supabase
        .from('groups')
        .select('id')
        .eq('code', body.group_code)
        .limit(1)
        .maybeSingle();

      if (gerr) return res.status(500).json({ ok: false, error: gerr.message });
      if (!g)   return res.status(404).json({ ok: false, error: 'Group not found' });
      groupId = g.id;
    }

    if (!groupId) {
      return res.status(400).json({ ok: false, error: 'group_id or group_code is required' });
    }

    // Update submissions for this group
    const { data, error } = await supabase.rpc('set_submissions_status_for_group', {
      p_group_id: groupId,
      p_status: status
    });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, updated: data ?? 0 });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
