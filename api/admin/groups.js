// api/admin/groups.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const status =
      typeof req.query.status === 'string' && req.query.status.trim() !== ''
        ? req.query.status.trim()
        : null;

    const search =
      typeof req.query.q === 'string' && req.query.q.trim() !== ''
        ? req.query.q.trim()
        : null;

    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    let query = supabase
      .from('groups')
      .select('id, code, status, notes, created_at, updated_at')
      .order('updated_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (search) {
      // match code or notes (case-insensitive)
      query = query.or(`code.ilike.%${search}%,notes.ilike.%${search}%`);
    }

    // pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });

 // helper to count distinct submission_ids for a group
async function countDistinctSubmissions(groupId) {
  // 1) get this group's card_ids
  const { data: cardRows, error: cardsErr } = await supabase
    .from('group_cards')
    .select('card_id')
    .eq('group_id', groupId);

  if (cardsErr) throw new Error(cardsErr.message);
  if (!cardRows || cardRows.length === 0) return 0;

  const cardIds = cardRows.map(r => r.card_id).filter(Boolean);
  if (cardIds.length === 0) return 0;

  // 2) fetch submission_ids for those cards
  const { data: subRows, error: subsErr } = await supabase
    .from('submission_cards')
    .select('submission_id')
    .in('id', cardIds);

  if (subsErr) throw new Error(subsErr.message);
  if (!subRows || subRows.length === 0) return 0;

  // 3) de-dupe submission_id
  const distinct = new Set(subRows.map(r => r.submission_id).filter(Boolean));
  return distinct.size;
}

const rows = [];
for (const r of data || []) {
  let members = 0;
  try {
    members = await countDistinctSubmissions(r.id);
  } catch (_) {
    // leave members as 0 if counting fails
  }
  rows.push({ ...r, members });
}

return res.status(200).json({ ok: true, rows });

  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
