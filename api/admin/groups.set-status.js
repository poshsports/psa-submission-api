// api/admin/groups.set-status.js
// Bulk-update all submissions in a group (and their cards), then sync the group header/lifecycle.

import { requireAdmin } from '../_util/adminAuth.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Allowed submission statuses (must match DB / UI)
const ALLOWED = new Set([
  'pending_payment',
  'submitted',
  'submitted_paid',
  'received',             // intake complete (pre-PSA)
  'shipped_to_psa',
  'in_grading',
  'graded',
  'shipped_back_to_us',
  'received_from_psa',    // after PSA return
  'balance_due',
  'paid',
  'shipped_to_customer',
  'delivered',
]);

// Optional phase aliases ➜ concrete submission statuses
const STATUS_ALIASES = {
  ready_to_ship: 'received',
  at_psa: 'shipped_to_psa',
};

// Forward-only rank (lower -> earlier)
const FLOW = [
  'pending_payment','submitted','submitted_paid','received',
  'shipped_to_psa','in_grading','graded','shipped_back_to_us',
  'received_from_psa','balance_due','paid','shipped_to_customer','delivered'
];
const RANK = FLOW.reduce((m, v, i) => ((m[v] = i), m), {});

// Group lifecycle rank (forward-only)
const GROUP_RANK = { Draft: 0, ReadyToShip: 1, AtPSA: 2, Returned: 3, Closed: 4 };

function targetGroupStatusForSubmissionStatus(subStatus) {
  if (['shipped_to_psa', 'in_grading', 'graded'].includes(subStatus)) return 'AtPSA';
  if (['shipped_back_to_us', 'received_from_psa', 'balance_due', 'paid', 'shipped_to_customer'].includes(subStatus)) return 'Returned';
  if (subStatus === 'delivered') return 'Closed';
  return null;
}

async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const nowIso = () => new Date().toISOString();

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }

    if (!requireAdmin(req)) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'server_misconfigured' }));
      return;
    }

    const body = await readJson(req);
    const requested = String(body?.status || '').trim().toLowerCase();
    let groupId = String(body?.group_id || '').trim();
    const groupCode = String(body?.group_code || '').trim();

    // Alias ➜ real submission status
    const subStatus = STATUS_ALIASES[requested] ?? requested;
    if (!subStatus || !ALLOWED.has(subStatus)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'invalid_status' }));
      return;
    }

    if (!groupId && !groupCode) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'missing_group_identifier' }));
      return;
    }

    // Resolve group id + current lifecycle
    let groupRow = null;
    if (groupId) {
      const { data, error } = await supabase
        .from('groups')
        .select('id, status, shipped_at, returned_at')
        .eq('id', groupId)
        .single();
      if (error || !data) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'group_not_found' }));
        return;
      }
      groupRow = data; groupId = data.id;
    } else {
      const { data, error } = await supabase
        .from('groups')
        .select('id, status, shipped_at, returned_at')
        .eq('code', groupCode)
        .single();
      if (error || !data) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'group_not_found' }));
        return;
      }
      groupRow = data; groupId = data.id;
    }

    // --- 1) Update submissions via your existing RPC (best effort) ---
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      'set_submissions_status_for_group',
      { p_group_id: groupId, p_status: subStatus }
    );
    if (rpcErr) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: rpcErr.message || 'rpc_failed' }));
      return;
    }
    const rpcUpdated =
      (typeof rpcData === 'number') ? rpcData :
      (rpcData?.updated ?? rpcData?.count ?? 0);

// --- 1a) Forward-only fallback: bump psa_submissions directly if RPC did nothing ---
let directUpdated = 0;
if (submissionIds.length) {
  const targetRank = RANK[subStatus] ?? 999;

  const { data: subsNow } = await supabase
    .from('psa_submissions')
    .select('submission_id, status')
    .in('submission_id', submissionIds);

  const idsToBump = (subsNow || [])
    .filter(r => (RANK[String(r.status || '')] ?? -1) < targetRank)
    .map(r => r.submission_id);

  if (idsToBump.length) {
    const { data: up2 } = await supabase
      .from('psa_submissions')
      .update({ status: subStatus, updated_at: nowIso() })
      .in('submission_id', idsToBump)
      .select('submission_id');
    directUpdated = Array.isArray(up2) ? up2.length : 0;
  }
}
    }

    // --- 1b) Ensure cards cascade (idempotent if the RPC already cascades) ---
    let cardsUpdated = 0;
    if (submissionIds.length) {
      const { data: upCards, error: cErr } = await supabase
        .from('submission_cards')
        .update({ status: subStatus, updated_at: nowIso() })
        .in('submission_id', submissionIds)
        .select('id');
      if (!cErr && Array.isArray(upCards)) cardsUpdated = upCards.length;
    }

    // --- 2) Advance group lifecycle + timestamps (forward-only) ---
    let target = targetGroupStatusForSubmissionStatus(subStatus);
    if (requested === 'ready_to_ship') target = 'ReadyToShip';

    let finalGroup = groupRow;
    if (target) {
      const currRank = GROUP_RANK[String(groupRow.status)] ?? -1;
      const nextRank = GROUP_RANK[target] ?? -1;

      if (nextRank > currRank) {
        const patch = { status: target, updated_at: nowIso() };
        if (target === 'AtPSA' && !groupRow.shipped_at) patch.shipped_at = nowIso();
        if (target === 'Returned' && !groupRow.returned_at) patch.returned_at = nowIso();

        const { data: up, error: uerr } = await supabase
          .from('groups')
          .update(patch)
          .eq('id', groupId)
          .select('id, status, shipped_at, returned_at')
          .single();

        if (!uerr && up) finalGroup = up;
        if (uerr) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            updated_rpc: rpcUpdated,
            updated_submissions: directUpdated,
            updated_cards: cardsUpdated,
            group: finalGroup,
            warning: `submissions_updated_but_group_status_sync_failed: ${uerr.message || 'unknown'}`
          }));
          return;
        }
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      updated_rpc: rpcUpdated,
      updated_submissions: directUpdated,
      updated_cards: cardsUpdated,
      group: {
        id: finalGroup.id,
        status: finalGroup.status,
        shipped_at: finalGroup.shipped_at,
        returned_at: finalGroup.returned_at,
      }
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err || 'unknown_error') }));
  }
}
