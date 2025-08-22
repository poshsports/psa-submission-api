// api/admin/groups/index.js (ESM)
import { requireAdmin } from '../../_util/adminAuth.js';
import { sb } from '../../_util/supabase.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }


  if (!requireAdmin(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
        // === POST /api/admin/groups — create a new group ===
    if (req.method === 'POST') {
      const body   = req.body || {};
      const codeIn = (typeof body.code === 'string' && body.code.trim()) ? body.code.trim().toUpperCase() : null;
      const status = (typeof body.status === 'string' && body.status.trim()) ? body.status.trim() : 'Draft';
      const notes  = (typeof body.notes === 'string') ? body.notes : null;

      const client = sb();

      // Compute next GRP-#### when code is not provided
      async function computeNextCode() {
        const { data: latest } = await client
          .from('groups')
          .select('code')
          .like('code', 'GRP-%')
          .order('code', { ascending: false })
          .limit(1)
          .maybeSingle();

        let nextNum = 1;
        if (latest?.code) {
          const m = String(latest.code).match(/^GRP-(\d{4,})$/i);
          if (m) nextNum = parseInt(m[1], 10) + 1;
        }
        return `GRP-${String(nextNum).padStart(4, '0')}`;
      }

      let code = codeIn || await computeNextCode();

      // Try insert; on duplicate code, bump and retry a few times
      let inserted = null, lastErr = null;
      for (let i = 0; i < 5; i++) {
        const { data, error } = await client
          .from('groups')
          .insert({ code, status, notes })
          .select('id, code, status, notes, created_at')
          .single();

        if (!error && data) { inserted = data; break; }

        lastErr = error;
        const dup = String(error?.message || '').toLowerCase().includes('duplicate');
        if (!dup) break;
        const n = (code.match(/^GRP-(\d{4,})$/i)?.[1]) ? (parseInt(code.slice(4), 10) + 1) : NaN;
        code = Number.isFinite(n) ? `GRP-${String(n).padStart(4, '0')}` : await computeNextCode();
      }

      if (!inserted) {
        res.status(500).json({ ok: false, error: lastErr?.message || 'Create group failed' });
        return;
      }

      res.status(200).json({ ok: true, group: inserted });
      return; // stop; don't run GET code below
    }
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
