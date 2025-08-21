// api/admin/groups/[id].js (ESM)
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

    const includeSet = new Set(
      String(req.query.include || req.query.with || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );
    const wantMembers     = includeSet.has('members');
    const wantSubmissions = includeSet.has('submissions');
    const wantCards       = includeSet.has('cards');

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

    // ---- optionally include members (support common table names) ----
    let members = [];
    if (wantMembers || wantSubmissions || wantCards) {
      const { data: gm, error: gmErr } = await sb()
        .from('group_members') // adjust if your table has a different name
        .select('submission_id, position, note')
        .eq('group_id', groupId)
        .order('position', { ascending: true });

      if (gmErr) {
        // return base group with a hint rather than hard failing
        res.status(200).json({ ...group, members: [], _members_error: gmErr.message });
        return;
      }
      members = gm || [];
      group.members = members; // attach for the client
    }

    // ---- submissions (single batched query) ----
    let submissions = [];
    if (wantSubmissions || wantCards) {
      const ids = [...new Set(members.map(m => m.submission_id).filter(Boolean))];
      if (ids.length) {
        const { data: subs, error: sErr } = await sb()
          .from('submissions')
          .select('id, created_at, status, grading_service, customer_email')
          .in('id', ids);
        if (sErr) {
          res.status(200).json({ ...group, members, submissions: [], _submissions_error: sErr.message });
          return;
        }
        submissions = subs || [];
      }
      group.submissions = submissions;
    }

    // ---- cards (single batched query) ----
    if (wantCards) {
      const ids = [...new Set(members.map(m => m.submission_id).filter(Boolean))];
      let cards = [];
      if (ids.length) {
        const { data: c, error: cErr } = await sb()
          .from('cards') // <- your card table name
          .select(`
            id,
            submission_id,
            created_at,
            status,
            grading_service,
            year,
            brand,
            set,
            player,
            card_number,
            variation,
            notes,
            card_index
          `)
          .in('submission_id', ids)
          .order('submission_id', { ascending: true })
          .order('card_index', { ascending: true }); // harmless if column doesn’t exist

        if (cErr) {
          res.status(200).json({ ...group, members, submissions, cards: [], _cards_error: cErr.message });
          return;
        }
        cards = c || [];
      }
      group.cards = cards;
    }

    // IMPORTANT: return the group object itself (not { ok, group })
    res.status(200).json(group);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
