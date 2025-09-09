// api/admin/groups.set-status.js
import { requireAdmin } from '../_util/adminAuth.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// Allowed submission statuses (must match DB/UI)
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
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch {} }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const nowIso = () => new Date().toISOString();
const sample = (arr, n = 5) => (arr || []).slice(0, n);

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'method_not_allowed' });
    if (!requireAdmin(req))   return res.status(401).json({ ok:false, error:'Unauthorized' });
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ ok:false, error:'server_misconfigured' });

    const body = await readJson(req);
    const requested = String(body?.status || '').trim().toLowerCase();
    let groupId     = String(body?.group_id || '').trim();
    const groupCode = String(body?.group_code || '').trim();

    const subStatus = STATUS_ALIASES[requested] ?? requested;
    if (!ALLOWED.has(subStatus)) return res.status(400).json({ ok:false, error:'invalid_status' });
    if (!groupId && !groupCode)  return res.status(400).json({ ok:false, error:'missing_group_identifier' });

    // Resolve group
    let groupRow = null;
    if (groupId) {
      const { data, error } = await supabase
        .from('groups').select('id,status,shipped_at,returned_at')
        .eq('id', groupId).single();
      if (error || !data) return res.status(404).json({ ok:false, error:'group_not_found' });
      groupRow = data; groupId = data.id;
    } else {
      const { data, error } = await supabase
        .from('groups').select('id,status,shipped_at,returned_at')
        .eq('code', groupCode).single();
      if (error || !data) return res.status(404).json({ ok:false, error:'group_not_found' });
      groupRow = data; groupId = data.id;
    }

    // 0) Who/what are we touching?
    const { data: members, error: memErr } = await supabase
      .from('group_submissions').select('submission_id').eq('group_id', groupId);
    if (memErr) return res.status(500).json({ ok:false, error: memErr.message || 'members_query_failed' });

    const submissionIds = (members || []).map(m => m.submission_id).filter(Boolean);

    const { data: links, error: linkErr } = await supabase
      .from('group_cards').select('card_id').eq('group_id', groupId);
    if (linkErr) return res.status(500).json({ ok:false, error: linkErr.message || 'links_query_failed' });

    const cardIds = (links || []).map(r => r.card_id).filter(Boolean);

    // --- 1) Keep your RPC (legacy side-effects)
    let updated_rpc = 0;
    {
      const { data: rpcData, error: rpcErr } = await supabase
        .rpc('set_submissions_status_for_group', { p_group_id: groupId, p_status: subStatus });
      if (rpcErr) {
        // Non-fatal; we still push to the two tables the UI uses
        updated_rpc = 0;
      } else {
        updated_rpc = (typeof rpcData === 'number') ? rpcData : (rpcData?.updated ?? rpcData?.count ?? 0);
      }
    }

    // Snapshot BEFORE
    const { data: subsBefore } = submissionIds.length
      ? await supabase.from('psa_submissions').select('submission_id,status').in('submission_id', submissionIds)
      : { data: [] };
    const { data: cardsBefore } = (cardIds.length || submissionIds.length)
      ? await supabase.from('submission_cards').select('id,submission_id,status')
          .or([
            cardIds.length ? `id.in.(${cardIds.join(',')})` : null,
            submissionIds.length ? `submission_id.in.(${submissionIds.join(',')})` : null
          ].filter(Boolean).join(','))
      : { data: [] };

    // --- 1a) Forward-only bump on psa_submissions
    let updated_submissions = 0;
    if (submissionIds.length) {
      const targetRank = RANK[subStatus] ?? 999;
      const idsToBump = (subsBefore || [])
        .filter(r => (RANK[String(r.status || '')] ?? -1) < targetRank)
        .map(r => r.submission_id);

      if (idsToBump.length) {
        const { data: up2 } = await supabase
          .from('psa_submissions')
          .update({ status: subStatus, updated_at: nowIso() })
          .in('submission_id', idsToBump)
          .select('submission_id');
        updated_submissions = Array.isArray(up2) ? up2.length : 0;
      }
    }

    // --- 1b) Cascade status to cards (robust: by card_id and by submission_id)
    let updated_cards = 0;
    if (cardIds.length) {
      const { data: upByCard } = await supabase
        .from('submission_cards')
        .update({ status: subStatus, updated_at: nowIso() })
        .in('id', cardIds)
        .select('id');
      updated_cards += Array.isArray(upByCard) ? upByCard.length : 0;
    }
    if (submissionIds.length) {
      const { data: upBySub } = await supabase
        .from('submission_cards')
        .update({ status: subStatus, updated_at: nowIso() })
        .in('submission_id', submissionIds)
        .select('id');
      updated_cards += Array.isArray(upBySub) ? upBySub.length : 0;
    }

    // Snapshot AFTER
    const { data: subsAfter } = submissionIds.length
      ? await supabase.from('psa_submissions').select('submission_id,status').in('submission_id', submissionIds)
      : { data: [] };
    const { data: cardsAfter } = (cardIds.length || submissionIds.length)
      ? await supabase.from('submission_cards').select('id,submission_id,status')
          .or([
            cardIds.length ? `id.in.(${cardIds.join(',')})` : null,
            submissionIds.length ? `submission_id.in.(${submissionIds.join(',')})` : null
          ].filter(Boolean).join(','))
      : { data: [] };

    // --- 2) Advance group lifecycle (forward-only)
    let finalGroup = groupRow;
    let target = targetGroupStatusForSubmissionStatus(subStatus);
    if (requested === 'ready_to_ship') target = 'ReadyToShip';

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
      updated_rpc,
      updated_submissions,
      updated_cards,
      group: {
        id: finalGroup.id,
        status: finalGroup.status,
        shipped_at: finalGroup.shipped_at,
        returned_at: finalGroup.returned_at,
      },
      debug: {
        groupId,
        submissionIds_len: submissionIds.length,
        submissionIds_sample: sample(submissionIds),
        cardIds_len: cardIds.length,
        cardIds_sample: sample(cardIds),
        subs_before: sample(subsBefore, 10),
        subs_after: sample(subsAfter, 10),
        cards_before: sample(cardsBefore, 10),
        cards_after: sample(cardsAfter, 10),
      }
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err?.message || err || 'unknown_error') });
  }
}

export const config = { runtime: 'nodejs' };
