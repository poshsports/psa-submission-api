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

    // --- fetch base group (rpc get_group returns one row) ---
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

    // ---- optionally include members ----
    let members = [];
    if (wantMembers || wantSubmissions || wantCards) {
      const { data: gm, error: gmErr } = await sb()
        .from('group_submissions')
        .select('submission_id, position, note')
        .eq('group_id', groupId)
        .order('position', { ascending: true });

      if (gmErr) {
        res.status(200).json({ ...group, members: [], _members_error: gmErr.message, _debug:{ include:[...includeSet] } });
        return;
      }
      members = gm || [];
      group.members = members;
    }

    // ---- submissions (single batched query) ----
    let submissions = [];
    if (wantSubmissions || wantCards) {
      const ids = [...new Set((members || []).map(m => m.submission_id).filter(Boolean))];
      if (ids.length) {
        const { data: subs, error: sErr } = await sb()
          .from('psa_submissions')
          .select('submission_id, created_at, status, grading_service, customer_email')
          .in('submission_id', ids);

        if (sErr) {
          res.status(200).json({ ...group, members, submissions: [], _submissions_error: sErr.message, _debug:{ include:[...includeSet] } });
          return;
        }
        // normalize shape: id = submission_id
        submissions = (subs || []).map(r => ({
          id: r.submission_id,
          created_at: r.created_at,
          status: r.status,
          grading_service: r.grading_service,
          customer_email: r.customer_email
        }));
      }
      group.submissions = submissions;
    }

    // ---- cards (if you add a cards table later) ----
    if (wantCards) {
      const ids = [...new Set((members || []).map(m => m.submission_id).filter(Boolean))];
      let cards = [];
      if (ids.length) {
        const { data: c, error: cErr } = await sb()
          .from('cards') // if you create this table later
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
          .order('card_index', { ascending: true });

        if (cErr) {
          // ignore cards failure; still return members/submissions
          group.cards = [];
          group._cards_error = cErr.message;
        } else {
          group.cards = c || [];
        }
      } else {
        group.cards = [];
      }
    }

    // return the group row enriched with requested data (+ tiny debug)
    res.status(200).json({ ...group, _debug: { include: [...includeSet] } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
