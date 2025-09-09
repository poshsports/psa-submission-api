// api/admin/groups.set-status.js
// Bulk-update all submissions in a group (and their cards), then sync the group header/lifecycle.

import { requireAdmin } from '../_util/adminAuth.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// Allowed submission statuses (must match DB / UI)
const ALLOWED = new Set([
  'pending_payment','submitted','submitted_paid','received',
  'shipped_to_psa','in_grading','graded','shipped_back_to_us',
  'received_from_psa','balance_due','paid','shipped_to_customer','delivered',
]);

// UI aliases → concrete submission statuses
const STATUS_ALIASES = { ready_to_ship: 'received', at_psa: 'shipped_to_psa' };

// Forward-only rank
const FLOW = [
  'pending_payment','submitted','submitted_paid','received',
  'shipped_to_psa','in_grading','graded','shipped_back_to_us',
  'received_from_psa','balance_due','paid','shipped_to_customer','delivered'
];
const RANK = FLOW.reduce((m, v, i) => (m[v] = i, m), {});

// Group lifecycle rank (forward-only)
const GROUP_RANK = { Draft: 0, ReadyToShip: 1, AtPSA: 2, Returned: 3, Closed: 4 };

function targetGroupStatusForSubmissionStatus(s) {
  if (['shipped_to_psa','in_grading','graded'].includes(s)) return 'AtPSA';
  if (['shipped_back_to_us','received_from_psa','balance_due','paid','shipped_to_customer'].includes(s)) return 'Returned';
  if (s === 'delivered') return 'Closed';
  return null;
}

async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = []; for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
const nowIso = () => new Date().toISOString();

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'method_not_allowed' });
    if (!requireAdmin(req))   return res.status(401).json({ ok:false, error:'Unauthorized' });
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({ ok:false, error:'server_misconfigured' });
    }

    const body = await readJson(req);
    const requested = String(body?.status || '').trim().toLowerCase();
    let groupId     = String(body?.group_id || '').trim();
    const groupCode = String(body?.group_code || '').trim();

    const subStatus = STATUS_ALIASES[requested] ?? requested;
    if (!subStatus || !ALLOWED.has(subStatus)) return res.status(400).json({ ok:false, error:'invalid_status' });
    if (!groupId && !groupCode)               return res.status(400).json({ ok:false, error:'missing_group_identifier' });

    // Resolve group
    let groupRow = null;
    if (groupId) {
      const { data, error } = await supabase.from('groups')
        .select('id,status,shipped_at,returned_at').eq('id', groupId).single();
      if (error || !data) return res.status(404).json({ ok:false, error:'group_not_found' });
      groupRow = data; groupId = data.id;
    } else {
      const { data, error } = await supabase.from('groups')
        .select('id,status,shipped_at,returned_at').eq('code', groupCode).single();
      if (error || !data) return res.status(404).json({ ok:false, error:'group_not_found' });
      groupRow = data; groupId = data.id;
    }

    // 1) Best-effort RPC (if present)
    const { data: rpcData, error: rpcErr } = await supabase
      .rpc('set_submissions_status_for_group', { p_group_id: groupId, p_status: subStatus });
    if (rpcErr) return res.status(500).json({ ok:false, error: rpcErr.message || 'rpc_failed' });
    const rpcUpdated = (typeof rpcData === 'number') ? rpcData : (rpcData?.updated ?? rpcData?.count ?? 0);

    // Collect submission_ids in this group (psa-###)
    let submissionIds = [];
    {
      const { data: members, error: memErr } = await supabase
        .from('group_submissions').select('submission_id').eq('group_id', groupId);
      if (memErr) return res.status(500).json({ ok:false, error: memErr.message || 'members_query_failed' });
      submissionIds = (members || []).map(m => m.submission_id).filter(Boolean);
    }

    // 1a) Forward-only fallback on psa_submissions (by submission_id)
    let updatedSubmissions = 0;
    if (submissionIds.length) {
      const targetRank = RANK[subStatus] ?? 999;

      const { data: subsNow } = await supabase
        .from('psa_submissions')
        .select('submission_id,status')
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
        updatedSubmissions = Array.isArray(up2) ? up2.length : 0;
      }
    }

    // 1b) Cascade to submission_cards (by submission_id)
    let updatedCards = 0;
    if (submissionIds.length) {
      const { data: upCards } = await supabase
        .from('submission_cards')
        .update({ status: subStatus, updated_at: nowIso() })
        .in('submission_id', submissionIds)
        .select('id');
      updatedCards = Array.isArray(upCards) ? upCards.length : 0;
    }

    // 2) Advance group lifecycle + timestamps (forward-only)
    let target = targetGroupStatusForSubmissionStatus(subStatus);
    if (requested === 'ready_to_ship') target = 'ReadyToShip';

    let finalGroup = groupRow;
    if (target) {
      const currRank = GROUP_RANK[String(groupRow.status)] ?? -1;
      const nextRank = GROUP_RANK[target] ?? -1;
      if (nextRank > currRank) {
        const patch = { status: target, updated_at: nowIso() };
        if (target === 'AtPSA'   && !groupRow.shipped_at)  patch.shipped_at  = nowIso();
        if (target === 'Returned'&& !groupRow.returned_at) patch.returned_at = nowIso();
        const { data: up } = await supabase
          .from('groups').update(patch).eq('id', groupId)
          .select('id,status,shipped_at,returned_at').single();
        if (up) finalGroup = up;
      }
    }

    return res.status(200).json({
      ok: true,
      updated_rpc: rpcUpdated,
      updated_submissions: updatedSubmissions,
      updated_cards: updatedCards,
      group: {
        id: finalGroup.id,
        status: finalGroup.status,
        shipped_at: finalGroup.shipped_at,
        returned_at: finalGroup.returned_at,
      }
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err?.message || err || 'unknown_error') });
  }
}

export const config = { runtime: 'nodejs' };
