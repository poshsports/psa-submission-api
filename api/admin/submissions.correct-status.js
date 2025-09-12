// api/admin/submissions.correct-status.js (ESM)
import { requireAdmin } from '../_util/adminAuth.js';
import { sb } from '../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const POST_PSA = new Set([
  'received_from_psa',
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
]);

const PRE_PSA = new Set([
  'pending_payment','submitted','submitted_paid','received','shipped_to_psa'
]);

const RANK = {
  pending_payment:0, submitted:1, submitted_paid:2, received:3, shipped_to_psa:4,
  in_grading:5, graded:6, shipped_back_to_us:7,
  received_from_psa:8, balance_due:9, paid:10, shipped_to_customer:11, delivered:12
};

const ALL_ALLOWED = new Set([...PRE_PSA, ...POST_PSA]);

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

// (NEW BLOCK — PASTE THIS)
const body = req.body || {};
const to = String(body.status || '').toLowerCase();
if (!ALL_ALLOWED.has(to)) {
  res.status(400).json({ ok: false, error: 'invalid_status' });
  return;
}

const client = sb();

// Resolve submission id from UUID or code
let sid = (body.submission_id && String(body.submission_id).trim()) || '';
if (!UUID_RE.test(sid)) {
  const code = String(body.submission_code || '').trim();
  if (!code) {
    res.status(400).json({ ok: false, error: 'missing_submission_identifier' });
    return;
  }
  const { data: byCode, error: codeErr } = await client
    .from('psa_submissions')
    .select('submission_id')
    .eq('submission_id', code)   // your submission "code" equals submission_id in DB
    .single();
  if (codeErr || !byCode?.submission_id) {
    res.status(404).json({ ok: false, error: 'submission_not_found' });
    return;
  }
  sid = byCode.submission_id;
}

// Get current status
const { data: subRow, error: subErr } = await client
  .from('psa_submissions')
  .select('submission_id, status')
  .eq('submission_id', sid)
  .single();

if (subErr || !subRow) {
  res.status(404).json({ ok: false, error: 'submission_not_found' });
  return;
}

const from = String(subRow.status || '').toLowerCase();

// ---- Branch A: pre-PSA backward (allowed, no reopen_hold needed) ----
if (PRE_PSA.has(to)) {
  if (!PRE_PSA.has(from)) {
    res.status(400).json({ ok: false, error: 'current_not_pre_psa' });
    return;
  }
  const isBackward = (RANK[to] ?? 999) < (RANK[from] ?? 999);
  if (!isBackward) {
    res.status(400).json({ ok: false, error: 'not_backward' });
    return;
  }

  // Update
  const { error: upErr } = await client
    .from('psa_submissions')
    .update({ status: to })
    .eq('submission_id', sid);

  if (upErr) {
    res.status(500).json({ ok: false, error: upErr.message || 'update_failed' });
    return;
  }

  if (body.cascade_cards) {
    await client
      .from('submission_cards')
      .update({ status: to })
      .eq('submission_id', sid);
  }

  res.status(200).json({ ok: true, submission_id: sid, status: to, corrected: true });
  return;
}

// ---- Branch B: post-PSA correction (your existing logic with reopen_hold) ----

// Only allow correction if this submission belongs to any group with reopen_hold=true
const { data: linkRows, error: linksErr } = await client
  .from('group_submissions')
  .select('group_id')
  .eq('submission_id', sid);

if (linksErr) {
  res.status(500).json({ ok: false, error: linksErr.message || 'group_link_error' });
  return;
}

const gIds = (linkRows || []).map(r => r.group_id);
if (!gIds.length) {
  res.status(400).json({ ok: false, error: 'not_in_group' });
  return;
}

const { data: groups, error: gErr } = await client
  .from('groups')
  .select('id, reopen_hold')
  .in('id', gIds);

if (gErr) {
  res.status(500).json({ ok: false, error: gErr.message || 'groups_fetch_error' });
  return;
}

const hasHold = (groups || []).some(g => g.reopen_hold === true);
if (!hasHold) {
  res.status(400).json({ ok: false, error: 'cannot_move_backward' });
  return;
}

    // Perform the correction (admin override)
    const { error: upErr } = await client
      .from('psa_submissions')
      .update({ status: to })
      .eq('submission_id', sid);

    if (upErr) {
      res.status(500).json({ ok: false, error: upErr.message || 'update_failed' });
      return;
    }

    if (body.cascade_cards) {
      await client
        .from('submission_cards')
        .update({ status: to })
        .eq('submission_id', sid);
    }

    res.status(200).json({ ok: true, submission_id: sid, status: to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
