// /api/admin/groups/[id]/submissions/remove.js
import { requireAdmin } from '../../../../_util/adminAuth.js';
import { sb } from '../../../../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }
    if (!requireAdmin(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // group id (UUID or code)
    const raw = String(req.query.id || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'Missing group id' });

    // body: { submission_ids: [...] }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    let submissionIds = Array.isArray(body?.submission_ids) ? body.submission_ids : [];
    submissionIds = submissionIds.map(x => String(x).trim()).filter(Boolean);
    if (submissionIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'submission_ids is required' });
    }

    const client = sb();

    // Resolve group by UUID or code
    let groupId = raw, groupCode = null, groupStatus = null;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: codeErr } = await client
        .from('groups')
        .select('id, code, status')
        .eq('code', raw)
        .single();
      if (codeErr || !byCode?.id) return res.status(404).json({ ok: false, error: 'Group not found' });
      groupId = byCode.id; groupCode = byCode.code; groupStatus = byCode.status;
    } else {
      const { data: byId, error: idErr } = await client
        .from('groups')
        .select('id, code, status')
        .eq('id', raw)
        .single();
      if (idErr || !byId?.id) return res.status(404).json({ ok: false, error: 'Group not found' });
      groupId = byId.id; groupCode = byId.code; groupStatus = byId.status;
    }

    // Gate: only Draft or ReadyToShip
    const st = String(groupStatus || '').toLowerCase().replace(/\s+/g, '');
    const isOpen = (st === 'draft' || st === 'readytoship');
    if (!isOpen) {
      return res.status(409).json({
        ok: false,
        code: 'group_locked',
        error: `Group is not editable (status: ${groupStatus || 'unknown'}).`
      });
    }

    // ---- Delete group_cards rows for cards in the target submissions (in this group) ----
    const { data: cardsBySub, error: cardsErr } = await client
      .from('submission_cards')
      .select('id, submission_id')
      .in('submission_id', submissionIds);
    if (cardsErr) return res.status(500).json({ ok: false, error: cardsErr.message || 'Failed to load submission cards' });

    const cardIds = Array.from(new Set((cardsBySub || []).map(r => String(r.id))));
    let removedCards = 0;
    if (cardIds.length) {
      const { data: delCards, error: delErr } = await client
        .from('group_cards')
        .delete()
        .eq('group_id', groupId)
        .in('card_id', cardIds)
        .select('card_id');
      if (delErr) return res.status(500).json({ ok: false, error: delErr.message || 'Failed to detach cards from group' });
      removedCards = (delCards || []).length;
    }

    // ---- Delete membership rows (group_submissions) for those submissions in this group ----
    const { data: delMembers, error: memErr } = await client
      .from('group_submissions')
      .delete()
      .eq('group_id', groupId)
      .in('submission_id', submissionIds)
      .select('submission_id');
    if (memErr) return res.status(500).json({ ok: false, error: memErr.message || 'Failed to detach submissions from group' });
    const removedSubs = new Set((delMembers || []).map(r => String(r.submission_id))).size;

    // ---- Repack card_no to 1..N for remaining cards ----
    const { data: remaining, error: remErr } = await client
      .from('group_cards')
      .select('card_id, card_no')
      .eq('group_id', groupId)
      .order('card_no', { ascending: true, nullsFirst: false });
    if (remErr) return res.status(500).json({ ok: false, error: remErr.message || 'Failed to read remaining group cards' });

    if (remaining?.length) {
      // Stage large temps to avoid unique collisions
      let tmp = 1_000_000;
      for (const row of remaining) {
        const { error: up1 } = await client
          .from('group_cards')
          .update({ card_no: tmp++ })
          .eq('group_id', groupId)
          .eq('card_id', row.card_id);
        if (up1) return res.status(500).json({ ok: false, error: up1.message || 'Failed to stage renumber' });
      }
      // Final contiguous 1..N (preserve relative order)
      let idx = 1;
      for (const row of remaining) {
        const { error: up2 } = await client
          .from('group_cards')
          .update({ card_no: idx++ })
          .eq('group_id', groupId)
          .eq('card_id', row.card_id);
        if (up2) return res.status(500).json({ ok: false, error: up2.message || 'Failed to renumber cards' });
      }
    }

    // ---- Repack group_submissions.position to 1..M ----
    const { data: members, error: m2Err } = await client
      .from('group_submissions')
      .select('submission_id, position')
      .eq('group_id', groupId)
      .order('position', { ascending: true, nullsFirst: false });
    if (m2Err) return res.status(500).json({ ok: false, error: m2Err.message || 'Failed to read remaining members' });

    if (members?.length) {
      let tmp = 1_000_000;
      for (const row of members) {
        const { error: up1 } = await client
          .from('group_submissions')
          .update({ position: tmp++ })
          .eq('group_id', groupId)
          .eq('submission_id', row.submission_id);
        if (up1) return res.status(500).json({ ok: false, error: up1.message || 'Failed to stage member repack' });
      }
      let pos = 1;
      for (const row of members) {
        const { error: up2 } = await client
          .from('group_submissions')
          .update({ position: pos++ })
          .eq('group_id', groupId)
          .eq('submission_id', row.submission_id);
        if (up2) return res.status(500).json({ ok: false, error: up2.message || 'Failed to repack member positions' });
      }
    }

    // Touch group timestamp
    await client.from('groups').update({ updated_at: new Date().toISOString() }).eq('id', groupId);

    return res.status(200).json({
      ok: true,
      removed_submissions: removedSubs,
      removed_cards: removedCards,
      group_code: groupCode || raw
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };
