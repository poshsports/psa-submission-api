// api/admin/groups/[id]/cards/order.js (ESM)
import { requireAdmin } from '../../../../_util/adminAuth.js';
import { sb } from '../../../../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', ['PATCH']);
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    if (!requireAdmin(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const raw = String(req.query.id || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'Missing group id' });

    const { order } = (await parseJson(req)) ?? {};
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ ok: false, error: 'Body must include non-empty "order" array of card_ids' });
    }

    const client = sb();

    // Resolve UUID or code
    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: codeErr } = await client
        .from('groups')
        .select('id, code')
        .eq('code', raw)
        .single();
      if (codeErr || !byCode?.id) {
        return res.status(404).json({ ok: false, error: 'Group not found' });
      }
      groupId = byCode.id;
    }

    // Fetch existing group cards to validate membership
    const { data: existing, error: exErr } = await client
      .from('group_cards')
      .select('card_id, card_no')
      .eq('group_id', groupId);

    if (exErr) {
      return res.status(500).json({ ok: false, error: exErr.message || 'Failed to load group cards' });
    }

    const existingIds = new Set((existing || []).map(r => String(r.card_id)));
    const providedIds = new Set(order.map(String));

    // You can enforce full permutation if you want strict sequencing:
    // All existing must be included and no foreign ids allowed.
    for (const id of providedIds) {
      if (!existingIds.has(id)) {
        return res.status(400).json({ ok: false, error: `card_id ${id} is not in this group` });
      }
    }
    if (existingIds.size !== providedIds.size) {
      return res.status(400).json({ ok: false, error: 'Order must include all cards in the group exactly once' });
    }

    // Phase A: assign large temporary numbers to avoid unique/collision issues
    // (do it in the order provided)
    let idx = 1;
    for (const cardId of order) {
      const { error: upErr } = await client
        .from('group_cards')
        .update({ card_no: 100000 + idx++ })
        .eq('group_id', groupId)
        .eq('card_id', cardId);
      if (upErr) {
        return res.status(500).json({ ok: false, error: upErr.message || 'Failed to stage card order' });
      }
    }

    // Phase B: normalize to 1..N using your RPC
    const { error: rnErr } = await client.rpc('renumber_group_cards', { p_group_id: groupId });
    if (rnErr) {
      return res.status(500).json({ ok: false, error: rnErr.message || 'Failed to renumber cards' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

export const config = { runtime: 'nodejs' };

// ---- helpers ----
async function parseJson(req) {
  if (!req.body) return null;
  // Next.js can give body as object or string depending on config
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}
