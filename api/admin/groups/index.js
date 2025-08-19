// api/admin/groups/index.js (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';
import { sb } from '../../_util/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  if (!requireAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const status = (req.query.status || '').trim() || null;
    const q = (req.query.q || '').trim() || null;

    const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
    const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    const pageSizePlusOne = limit + 1;

    const { data, error } = await sb().rpc('list_groups', {
      p_status: status,
      p_q: q,
      p_limit: pageSizePlusOne,
      p_offset: offset,
    });

    if (error) {
      res.status(500).json({ ok: false, error: error.message || 'Database error' });
      return;
    }

    const items = Array.isArray(data) ? data : [];
    const hasMore = items.length > limit;
    const trimmed = hasMore ? items.slice(0, limit) : items;

    res.status(200).json({ ok: true, items: trimmed, limit, offset, hasMore });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

// Force Node runtime
export const config = { runtime: 'nodejs' };
