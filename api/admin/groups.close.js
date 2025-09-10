// api/admin/groups.close.js  (ESM)
import { requireAdmin } from '../_util/adminAuth.js';
import { sb } from '../_util/supabase.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!requireAdmin(req)) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    const body = await readJson(req);
    const raw = String(body?.group_id || body?.id || body?.code || '').trim();
    if (!raw) { res.status(400).json({ ok: false, error: 'missing_group_id' }); return; }

    const client = sb();

    // Resolve UUID (accept code like "GRP-0001")
    let groupId = raw;
    if (!UUID_RE.test(raw)) {
      const { data: byCode, error: cErr } = await client
        .from('groups')
        .select('id, code')
        .eq('code', raw)
        .single();
      if (cErr || !byCode?.id) {
        res.status(404).json({ ok: false, error: 'group_not_found' });
        return;
      }
      groupId = byCode.id;
    }

    // Pull members and ensure all submissions are Delivered to Customer
    const { data: members, error: mErr } = await client
      .from('group_submissions')
      .select('submission_id')
      .eq('group_id', groupId);

    if (mErr) { res.status(500).json({ ok: false, error: mErr.message || 'members_fetch_failed' }); return; }

    const subIds = [...new Set((members || []).map(m => m.submission_id))];

    if (subIds.length > 0) {
      const { data: subs, error: sErr } = await client
        .from('psa_submissions')
        .select('submission_id, status')
        .in('submission_id', subIds);

      if (sErr) { res.status(500).json({ ok: false, error: sErr.message || 'submissions_fetch_failed' }); return; }

      const pending = (subs || []).filter(
        s => String(s.status || '').toLowerCase() !== 'delivered'
      );

      if (pending.length) {
        res.status(400).json({
          ok: false,
          error: 'not_all_delivered',
          pending: pending.map(p => ({ code: p.submission_id, status: p.status }))
        });
        return;
      }
    }

    // All good — mark Closed and clear the reopen hold
    const { data: upd, error: uErr } = await client
      .from('groups')
      .update({ status: 'Closed', reopen_hold: false, updated_at: new Date().toISOString() })
      .eq('id', groupId)
      .select('id, code, status, reopen_hold')
      .single();

    if (uErr || !upd) {
      res.status(500).json({ ok: false, error: uErr?.message || 'close_failed' });
      return;
    }

    res.status(200).json({ ok: true, group: upd });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'unexpected_error' });
  }
}

export const config = { runtime: 'nodejs' };
