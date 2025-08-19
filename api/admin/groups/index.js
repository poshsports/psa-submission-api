// api/admin/groups/index.js
const { sb } = require('../../_util/supabase');
const { requireAdmin } = require('../../_util/adminAuth');

module.exports = async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  // Auth
  if (!requireAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const status = (req.query.status || '').trim() || null;
    const q = (req.query.q || '').trim() || null;

    const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
    const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Math.max(1, Math.min(200, isFinite(limitRaw) ? limitRaw : 50));
    const offset = Math.max(0, isFinite(offsetRaw) ? offsetRaw : 0);

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
};
