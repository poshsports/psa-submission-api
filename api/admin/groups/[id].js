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

      // Flag: lock bulk control once ALL submissions are at/after 'received_from_psa'
      const POST_SET = new Set(['received_from_psa','balance_due','paid','shipped_to_customer','delivered']);
      const bulk_locked =
        submissions.length > 0 &&
        submissions.every(s => POST_SET.has(String(s.status || '').toLowerCase()));

        }
      }
      const subById = new Map(submissions.map(s => [String(s.id), s]));

// ---- cards ----
let cards = [];
if (wantCards) {
  const ids = [...new Set(members.map(m => m.submission_id).filter(Boolean))];
  if (ids.length) {
    const client = sb();

    // 0) Read card_info for these submissions
    const { data: rawSubs, error: rsErr } = await client
      .from('psa_submissions')
      .select('submission_id, created_at, status, grading_service, card_info')
      .in('submission_id', ids);
    if (rsErr) {
      return res.status(500).json({ ...group, members, submissions, cards: [], _cards_error: rsErr.message });
    }

    // 1) Ensure submission_cards exist (materialize missing rows by (submission_id, card_index))
    const { data: existingRows, error: exErr } = await client
      .from('submission_cards')
      .select('id, submission_id, card_index')
      .in('submission_id', ids);
    if (exErr) {
      return res.status(500).json({ ...group, members, submissions, cards: [], _cards_error: exErr.message });
    }

    const haveBySub = new Map();
    for (const r of existingRows || []) {
      const key = String(r.submission_id);
      if (!haveBySub.has(key)) haveBySub.set(key, new Set());
      haveBySub.get(key).add(Number(r.card_index));
    }

    const toInsert = [];
    for (const sub of rawSubs || []) {
      const sid = String(sub.submission_id);
      const haveIdx = haveBySub.get(sid) || new Set();

      // Robustly parse card_info (can be JSON text or already an array)
      let info = [];
      try {
        info = Array.isArray(sub.card_info)
          ? sub.card_info
          : JSON.parse(sub.card_info || '[]');
      } catch {
        info = [];
      }

      info.forEach((ci, i) => {
        if (!haveIdx.has(i)) {
          // Derive a description from common keys if present
          const desc =
            ci?.description ??
            ci?.card_description ??
            ci?.title ??
            ci?.card ??
            ci?.name ??
            null;

          toInsert.push({
            submission_id: sub.submission_id,
            card_index: i,
            status: sub.status ?? null,

            // Prefer card-level grading_service, fall back to submission default
            grading_service:
              ci?.grading_service ??
              ci?.psa_grading ??
              sub.grading_service ??
              null,

            // Card meta (best-effort)
            year: ci?.year ?? null,
            brand: ci?.brand ?? null,
            set: ci?.set ?? null,
            player: ci?.player ?? null,
            card_number: ci?.card_number ?? null,
            variation: ci?.variation ?? null,
            notes: ci?.notes ?? null,
            card_description: desc,

            // Break meta (CHANNEL FIX: accept break_channel OR channel)
            break_date: ci?.break_date ?? ci?.date ?? null,
            break_channel: ci?.break_channel ?? ci?.channel ?? null,
            break_number: ci?.break_number ?? null
          });
        }
      });
    }


        if (toInsert.length) {
      const { error: upErr } = await client
        .from('submission_cards')
        .upsert(toInsert, { onConflict: 'submission_id,card_index' }); // idempotent
      if (upErr) {
        return res.status(500).json({ ...group, members, submissions, cards: [], _cards_error: upErr.message });
      }
    }


    // 2) Select cards (now guaranteed to exist) with LEFT join to group_cards
    const selectCards = async () => client
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
      .order('submission_id', { ascending: true })
      .order('card_index', { ascending: true });

    let { data: c, error: cErr } = await selectCards();
    if (cErr) {
      return res.status(500).json({ ...group, members, submissions, cards: [], _cards_error: cErr.message });
    }

    // 3) Ensure group_cards links exist for THIS group, then renumber 1..N
    const { data: existingLinks, error: linkErr } = await client
      .from('group_cards')
      .select('card_id')
      .eq('group_id', groupId);
    if (!linkErr) {
      const have = new Set((existingLinks || []).map(r => String(r.card_id)));
      const need = (c || [])
        .filter(row => !have.has(String(row.id)))
        .map(row => ({ group_id: groupId, card_id: row.id, card_no: null }));

      if (need.length) {
        const { error: insLinkErr } = await client.from('group_cards').insert(need);
        if (!insLinkErr) {
          await client.rpc('renumber_group_cards', { p_group_id: groupId }).catch(() => {});
          const r2 = await selectCards();
          if (!r2.error && Array.isArray(r2.data)) c = r2.data;
        }
      }
    }

    // 4) Build response
    const toYMD = (val) => {
      try {
        if (!val) return null;
        const s = String(val);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
      } catch { return null; }
    };

        const PRE  = new Set(['pending_payment','submitted','submitted_paid','received','shipped_to_psa']);
    const POST = new Set(['received_from_psa','balance_due','paid','shipped_to_customer','delivered']);

    const phaseOf = (st) => {
      const s = String(st || '').toLowerCase();
      if (PRE.has(s)) return 'pre';
      if (s === 'in_grading' || s === 'graded') return 'at_psa';
      if (s === 'shipped_back_to_us') return 'return';
      if (POST.has(s)) return 'post';
      return 'pre';
    };

    const effective = (subStatus, cardStatus) => {
      const sub = String(subStatus || '').toLowerCase();
      const card = String(cardStatus || '').toLowerCase();
      const ph = phaseOf(sub);

      // Pre-PSA → show submission status
      if (ph === 'pre') return sub || card;

      // At the handoff → prefer a post-PSA card status if present
      if (sub === 'received_from_psa') return POST.has(card) ? card : sub;

      // Post-PSA → submission dominates (paid/shipped/delivered)
      if (POST.has(sub)) return sub;

      // At PSA / Return → show submission status
      return sub || card;
    };

    const subById = new Map(submissions.map(s => [String(s.id), s]));
    cards = (c || []).map(row => {
      const sub = subById.get(String(row.submission_id));
      const createdFrom = sub?.created_at ?? row.created_at;

      // prefer an explicit card_description; if missing, client will fall back to bits
      const gc = Array.isArray(row.group_cards)
        ? row.group_cards.find(g => String(g.group_id) === String(groupId))
        : null;

      const raw_card_status = row.status; // keep the DB value for audit/debug
      const display_status  = effective(sub?.status, raw_card_status);

      return {
        ...row,
        // IMPORTANT: we *override* status so the UI shows the effective status
        status: display_status,
        raw_card_status,

        created_at: createdFrom,
        _created_on: toYMD(createdFrom),
        _break_on:   toYMD(row.break_date ?? row.created_at),
        group_card_no: gc?.card_no ?? null
      };
    });

  }
}

      // Compute lock for bulk updates:
      // lock once ALL items in the group are at/after 'received_from_psa'
      const POST_PSA_SET = new Set([
        'received_from_psa','balance_due','paid','shipped_to_customer','delivered'
      ]);

      // Prefer card statuses when cards exist; otherwise fall back to submission statuses.
      const allCardsPost = (Array.isArray(cards) && cards.length > 0)
        ? cards.every(c => POST_PSA_SET.has(String(c?.status || '').toLowerCase()))
        : false;

      const allSubsPost = (!allCardsPost && Array.isArray(submissions) && submissions.length > 0)
        ? submissions.every(s => POST_PSA_SET.has(String(s?.status || '').toLowerCase()))
        : false;

      const bulk_locked = allCardsPost || allSubsPost;

      res.status(200).json({
        ...group,
        bulk_locked,
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
