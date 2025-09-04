// api/admin/groups.set-status.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// allowed psa_submissions.status values (matches your check constraint)
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
    const { group_id, status } = req.body || {};
    if (!group_id || typeof group_id !== 'string') {
      return res.status(400).json({ ok: false, error: 'group_id is required' });
    }
    if (!ALLOWED.has(status)) {
      return res.status(400).json({ ok: false, error: 'invalid status' });
    }

    // call the SQL function you created earlier
    const { data, error } = await supabase.rpc('set_submissions_status_for_group', {
      p_group_id: group_id,
      p_status: status
    });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.status(200).json({ ok: true, updated: data ?? 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
