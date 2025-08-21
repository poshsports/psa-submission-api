// api/admin/groups/[id].js  (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';
import { sb } from '../../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    // --- method/auth guards ---
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'Method Not Allowed' });
      return;
    }
    if (!requireAdmin(req)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    // --- parse params ---
    const raw = String(req.query.id || '').trim();
    if (!raw) {
      res.status(400).json({ ok: false, error: 'Missing group id' });
      return;
    }
    const includeMembers =
      String(req.query.include || req.query.with || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .includes('members');

    // --- resolve group id: accept UUID or code like "GRP-0005" ---
    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: codeErr } = await sb()
        .from('groups')
        .select('id')
        .eq('code', raw)
        .single();
      if (codeErr || !byCode?.id) {
        res.status(404).json({ ok: false, error: 'Group not found' });
        return;
      }
      groupId = byCode.id;
    }

    // --- fetch base group (use RPC if you rely on it to shape columns) ---
    const { data: rpcData, error: rpcErr } = await sb().rpc('get_group', {
      p_group_id: groupId,
    });

    if (rpcErr) {
      res.status(500).json({ ok: false, error: rpcErr.message || 'Database error' });
      return;
    }

    const group = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    if (!group) {
      res.status(404).json({ ok: false, error: 'Group not found' });
      return;
    }

// --- include members, submissions, and cards in one go ---
const want = (String(req.query.include || req.query.with || '')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean));

if (want.includes('members') || want.includes('submissions') || want.includes('cards')) {
  // 1) members (position + submission_id)
  const { data: members, error: mErr } = await sb()
    .from('group_members')
    .select('submission_id, position, note')
    .eq('group_id', groupId)
    .order('position', { ascending: true });

  if (mErr) {
    // still return the base group so the UI renders
    res.status(200).json({ ...group, members: [], _members_error: mErr.message });
    return;
  }

  group.members = members || [];
  const submissionIds = (members || []).map(m => m.submission_id).filter(Boolean);

  // 2) submissions (bulk, single query) — eliminates N+1 in the browser
  if (want.includes('submissions') && submissionIds.length) {
    const { data: subs, error: sErr } = await sb()
      .from('submissions')
      .select('id, created_at, customer_email, status, cards, evaluation_bool, grand, grading_service')
      .in('id', submissionIds);

    group.submissions = sErr ? [] : (subs || []);
  }

  // 3) cards (aka submission items) — adjust table name/columns if yours differ
  if (want.includes('cards') && submissionIds.length) {
    const { data: items, error: iErr } = await sb()
      .from('submission_items')          // <-- if your table is named differently, change this
      .select('id, submission_id, created_at, year, brand, set, player, card_number, variation, notes, status, grading_service')
      .in('submission_id', submissionIds)
      .order('created_at', { ascending: true });

    group.cards = iErr ? [] : (items || []);
  }
}


    // IMPORTANT: return the *group object itself* (not { ok, group })
    res.status(200).json(group);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

// Force Node runtime on Vercel
export const config = { runtime: 'nodejs' };
