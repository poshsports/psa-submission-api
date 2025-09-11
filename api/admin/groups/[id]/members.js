// api/admin/groups/[id]/members.js (ESM)
import { requireAdmin } from '../../../_util/adminAuth.js';
import { sb } from '../../../_util/supabase.js';

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

    const groupParam = req.query.id; // UUID or code like GRP-0012
    const { submission_ids = [], insert_at } = (req.body || {});

    if (!groupParam) {
      res.status(400).json({ ok: false, error: 'Missing group id/code' });
      return;
    }
    if (!Array.isArray(submission_ids) || submission_ids.length === 0) {
      res.status(400).json({ ok: false, error: 'submission_ids must be a non-empty array of strings' });
      return;
    }

// Resolve group: try code, then id — and enforce status guard
const client = sb();
let groupId = null;
let groupRow = null;

{
  const { data: byCode } = await client
    .from('groups')
    .select('id, code, status')
    .eq('code', groupParam)
    .limit(1)
    .maybeSingle();

  if (byCode?.id) {
    groupId = byCode.id;
    groupRow = byCode;
  } else {
    const { data: byId } = await client
      .from('groups')
      .select('id, code, status')
      .eq('id', groupParam)
      .limit(1)
      .maybeSingle();
    if (byId?.id) {
      groupId = byId.id;
      groupRow = byId;
    }
  }
}

if (!groupId) {
  res.status(404).json({ ok: false, error: 'Group not found' });
  return;
}

// 🚫 Guard: once shipped (or any non-open state), block adding members.
// Only Draft or ReadyToShip are open for adding.
const st = String(groupRow?.status || '').toLowerCase().replace(/\s+/g, '');
const isOpen = (st === 'draft' || st === 'readytoship');
if (!isOpen) {
  res.status(409).json({
    ok: false,
    code: 'group_locked',
    error: `Cannot add submissions to ${groupRow?.code || 'this group'} because its status is “${groupRow?.status || 'Unknown'}”.`
  });
  return;
}


    // NOTE: insert_at is reserved for future use (e.g., front/back of list)
    // Current numbering is handled in SQL trigger and by stable ordering of cards.

    // Call SQL helper (idempotent): add members + attach cards + auto-number
    const { data, error } = await client.rpc('add_submissions_to_group', {
      p_group_id: groupId,
      p_submission_ids: submission_ids
    });

    if (error) {
      // Friendly surfacing for the “already attached to an open group” guard
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('already attached to an open group') || msg.includes('prevent_duplicate_open_membership')) {
        res.status(409).json({
          ok: false,
          code: 'duplicate_open_membership',
          error: 'One or more submissions are already attached to an open group',
          detail: error.message
        });
        return;
      }
      res.status(500).json({ ok: false, error: error.message || 'Database error' });
      return;
    }

    // data = { added_submissions, added_cards }
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
