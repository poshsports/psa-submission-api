// /api/admin/groups/[id]/submissions/status.js (ESM)
import { requireAdmin } from '../../../_util/adminAuth.js';
import { sb } from '../../../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Allowed TARGET statuses (do NOT include the checkout trio)
const TARGETS = new Set([
  'received',
  'shipped_to_psa',
  'in_grading',
  'graded',
  'shipped_back_to_us',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
]);

// Current statuses we allow to be changed in bulk (now includes the two pre-checkout states)
const MUTABLE_CURRENT = new Set([
  'pending_payment',   // <-- added
  'submitted',         // <-- added
  'submitted_paid',
  'received',
  'shipped_to_psa',
  'in_grading',
  'graded',
  'shipped_back_to_us',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
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

    // body: { status }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const status = String(body?.status || '').trim().toLowerCase();
    if (!TARGETS.has(status)) {
      return res.status(400).json({ ok: false, error: `Invalid status: ${status}` });
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

    // Collect submission ids for this group: prefer group_members, fall back to group_cards
    let submissionIds = [];
    {
      const { data: members, error: mErr } = await client
        .from('group_members')
        .select('submission_id')
        .eq('group_id', groupId);

      if (!mErr && members?.length) {
        submissionIds = [...new Set(members.map(m => String(m.submission_id)))];
      } else {
        const { data: cards, error: cErr } = await client
          .from('group_cards')
          .select('submission_id')
          .eq('group_id', groupId);
        if (cErr) {
          return res.status(500).json({ ok: false, error: cErr.message || 'Failed to load group members' });
        }
        submissionIds = [...new Set((cards || []).map(c => String(c.submission_id)))];
      }
    }

    if (!submissionIds.length) {
      return res.status(200).json({ ok: true, updated: 0 });
    }

    // Bulk update, but only for rows in MUTABLE_CURRENT
    const { data: updated, error: upErr } = await client
      .from('submissions')
      .update({ status })
      .in('id', submissionIds)
      .in('status', Array.from(MUTABLE_CURRENT))
      .select('id');

    if (upErr) {
      return res.status(500).json({ ok: false, error: upErr.message || 'Failed to update submissions' });
    }

    // Touch the group timestamp (optional)
    await client.from('groups').update({ updated_at: new Date().toISOString() }).eq('id', groupId);

    return res.status(200).json({ ok: true, updated: updated?.length || 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
