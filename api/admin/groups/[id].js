// api/admin/groups/[id].js (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';
import { sb } from '../../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    // ---------- DELETE: remove a group (unassigns via FK CASCADE) ----------
    if (req.method === 'DELETE') {
      if (!requireAdmin(req)) {
        res.status(401).json({ ok: false, error: 'Unauthorized', _debug: { version: 'v3' } });
        return;
      }

      const raw = String(req.query.id || '').trim();
      if (!raw) {
        res.status(400).json({ ok: false, error: 'Missing group id', _debug: { version: 'v3' } });
        return;
      }

      const client = sb();

      // Accept UUID or code (e.g., "GRP-0018")
      let groupId = raw;
      if (!UUID_RE.test(raw)) {
        const { data: byCode, error: codeErr } = await client
          .from('groups')
          .select('id, code')
          .eq('code', raw)
          .single();
        if (codeErr || !byCode?.id) {
          res.status(404).json({ ok: false, error: 'Group not found', _debug: { version: 'v3' } });
          return;
        }
        groupId = byCode.id;
      }

      // Pre-count relationships so we can report what was unassigned
      const { count: subCount, error: c1 } = await client
        .from('group_submissions')
        .select('*', { count: 'exact', head: true })
        .eq('group_id', groupId);

      const { count: cardCount, error: c2 } = await client
        .from('group_cards')
        .select('*', { count: 'exact', head: true })
        .eq('group_id', groupId);

      if (c1 || c2) {
        const err = c1 || c2;
        res.status(500).json({ ok: false, error: err?.message || 'Count failed', _debug: { version: 'v3' } });
        return;
      }

      // Delete the group only; ON DELETE CASCADE will remove link rows
      const { error: delErr } = await client
        .from('groups')
        .delete()
        .eq('id', groupId);

      if (delErr) {
        res.status(500).json({ ok: false, error: delErr.message || 'Delete failed', _debug: { version: 'v3' } });
        return;
      }

      res.status(200).json({
        ok: true,
        id: groupId,
        unlinked_submissions: subCount || 0,
        unlinked_cards: cardCount || 0,
        _debug: { version: 'v3' }
      });
      return;
    }

    // ------------------------------- GET (existing) -------------------------------
    if (req.method === 'GET') {
      if (!requireAdmin(req)) {
        res.status(401).json({ ok: false, error: 'Unauthorized', _debug: { version: 'v3' } });
        return;
      }

      const raw = String(req.query.id || '').trim();
      if (!raw) {
        res.status(400).json({ ok: false, error: 'Missing group id', _debug: { version: 'v3' } });
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

      // Resolve UUID or code
      let groupId = raw;
      if (!UUID_RE.test(raw)) {
        const { data: byCode, error: codeErr } = await sb()
          .from('groups')
          .select('id')
          .eq('code', raw)
          .single();
        if (codeErr || !byCode?.id) {
          res.status(404).json({ ok: false, error: 'Group not found', _debug: { version: 'v3' } });
          return;
        }
        groupId = byCode.id;
      }

      // Base group via RPC
      const { data: rpcData, error: rpcErr } = await sb().rpc('get_group', { p_group_id: groupId });
      if (rpcErr) {
        res.status(500).json({ ok: false, error: rpcErr.message || 'Database error', _debug: { version: 'v3' } });
        return;
      }
      const group = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      if (!group) {
        res.status(404).json({ ok: false, error: 'Group not found', _debug: { version: 'v3' } });
        return;
      }

      // ---- members ----
      let members = [];
      if (wantMembers || wantSubmissions || wantCards) {
        const { data: gm, error: gmErr } = await sb()
          .from('group_submissions')
          .select('submission_id, position, created_at')
          .eq('group_id', groupId)
          .order('position', { ascending: true });

        if (gmErr) {
          res.status(200).json({ ...group, members: [], _members_error: gmErr.message });
          return;
        }
        members = gm || [];
        group.members = members;
      }

      // ---- submissions ----
      let submissions = [];
      if (wantSubmissions || wantCards) {
        const ids = [...new Set(members.map(m => m.submission_id).filter(Boolean))];
        if (ids.length) {
          const { data: subs, error: sErr } = await sb()
            .from('psa_submissions')
            .select('submission_id, created_at, status, grading_service, customer_email')
            .in('submission_id', ids);
          if (sErr) {
            res.status(200).json({
              ...group, members, submissions: [],
              _submissions_error: sErr.message, _debug: { version: 'v3', include: [...includeSet] }
            });
            return;
          }
          submissions = (subs || []).map(r => ({
            id: r.submission_id,
            created_at: r.created_at,
            status: r.status,
            grading_service: r.grading_service,
            customer_email: r.customer_email
          }));
        }
      }
      const subById = new Map(submissions.map(s => [String(s.id), s]));

// ---- cards ----
let cards = [];
if (wantCards) {
  const ids = [...new Set(members.map(m => m.submission_id).filter(Boolean))];
  if (ids.length) {
    const client = sb();

    // One function so we can re-run after we normalize numbering
    const selectCards = async () => {
      return client
        .from('submission_cards')
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
          card_index,
          break_date,
          break_channel,
          break_number,
          card_description,
          group_cards!left ( group_id, card_no )
        `)
        .in('submission_id', ids)
        // NO filter on group_cards.group_id — keep the LEFT JOIN intact
        .order('submission_id', { ascending: true })
        .order('card_index', { ascending: true });
    };

    // Try to load normalized cards first
    let { data: c, error: cErr } = await selectCards();
    if (cErr) {
      return res.status(500).json({ ...group, members, submissions, cards: [], _cards_error: cErr.message });
    }

    // If we have real card rows, ensure numbering rows exist for THIS group, then renumber 1..N
    if (Array.isArray(c) && c.length > 0) {
      // If any card in this set is missing a group_cards link, create it
      const { data: existingLinks, error: exErr } = await client
        .from('group_cards')
        .select('card_id')
        .eq('group_id', groupId);

      if (!exErr) {
        const have = new Set((existingLinks || []).map(r => String(r.card_id)));
        const need = (c || [])
          .filter(row => !have.has(String(row.id)))
          .map(row => ({ group_id: groupId, card_id: row.id, card_no: null }));

        if (need.length) {
          // Create missing links, then normalize numbering 1..N
          const { error: insErr } = await client.from('group_cards').insert(need);
          if (!insErr) {
            // Renumber via your existing RPC (used by Edit Card #)
            await client.rpc('renumber_group_cards', { p_group_id: groupId }).catch(() => {});
            // Re-select to pick up freshly assigned card_no
            const r2 = await selectCards();
            if (!r2.error && Array.isArray(r2.data)) c = r2.data;
          }
        }
      }

      // Build response rows (prefer created_at from submission when available)
      const toYMD = (val) => {
        try {
          if (!val) return null;
          const s = String(val);
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
          const d = new Date(s);
          return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
        } catch { return null; }
      };

      cards = (c || []).map(row => {
        const sub = subById.get(String(row.submission_id));
        const createdFrom = sub?.created_at ?? row.created_at;

        // Find numbering for THIS group if present
        const gc = Array.isArray(row.group_cards)
          ? row.group_cards.find(g => String(g.group_id) === String(groupId))
          : null;

        return {
          ...row,
          created_at: createdFrom,
          _created_on: toYMD(createdFrom),
          _break_on:   toYMD(row.break_date ?? row.created_at),
          group_card_no: gc?.card_no ?? null
        };
      });
    } else {
      // Fallback: materialized rows not present yet — read JSON card_info to at least display rows
      const { data: rawSubs, error: rsErr } = await client
        .from('psa_submissions')
        .select('submission_id, created_at, status, grading_service, card_info')
        .in('submission_id', ids);

      if (rsErr) {
        return res.status(500).json({ ...group, members, submissions, cards: [], _cards_error: rsErr.message });
      }

      const toYMD = (val) => {
        try {
          if (!val) return null;
          const s = String(val);
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
          const d = new Date(s);
          return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
        } catch { return null; }
      };

      const rows = [];
      for (const sub of rawSubs || []) {
        const info = Array.isArray(sub.card_info) ? sub.card_info : [];
        info.forEach((ci, i) => {
          rows.push({
            id: null, // no card_id yet
            submission_id: sub.submission_id,
            created_at: sub.created_at,
            status: sub.status,
            grading_service: sub.grading_service,
            year: ci.year ?? null,
            brand: ci.brand ?? null,
            set: ci.set ?? null,
            player: ci.player ?? null,
            card_number: ci.card_number ?? null,
            variation: ci.variation ?? null,
            notes: ci.notes ?? null,
            card_index: i,
            break_date: ci.break_date ?? null,
            break_channel: ci.break_channel ?? null,
            break_number: ci.break_number ?? null,
            card_description: ci.card_description ?? null,
            _created_on: toYMD(sub.created_at),
            _break_on: toYMD(ci.break_date ?? sub.created_at),
            group_card_no: null
          });
        });
      }
      cards = rows;
    }
  }
}


      res.status(200).json({
        ...group,
        members,
        submissions,
        cards,
        _debug: { version: 'v3', include: [...includeSet] }
      });
      return;
    }

    // ------------------------- Other methods: 405 -------------------------
    res.status(405).json({ ok: false, error: 'Method Not Allowed', _debug: { version: 'v3' } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error', _debug: { version: 'v3' } });
  }
}

export const config = { runtime: 'nodejs' };
