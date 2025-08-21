// api/admin/groups/[id].js  (ESM)
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
    const includeMembers =
      String(req.query.include || req.query.with || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .includes('members');

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

    // --- fetch base group (use RPC if you rely on it to shape columns) ---
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

// --- optionally include members (try a few common table/column names) ---
if (includeMembers) {
  const debug = String(req.query.debug || '') === '1';
  const tried = [];

  const candidates = [
    { table: 'group_members',      fk: 'group_id' },
    { table: 'groups_submissions', fk: 'group_id' },
    { table: 'group_submissions',  fk: 'group_id' },
    { table: 'groups_members',     fk: 'group_id' },
  ];

  const submissionFields = ['submission_id', 'submissionId', 'submission', 'id'];

  let members = [];
  for (const c of candidates) {
    try {
      const sel = debug ? '*' : 'submission_id, position, note';
      const { data, error } = await sb()
        .from(c.table)
        .select(sel)
        .eq(c.fk, groupId)
        .order('position', { ascending: true });

      tried.push({
        table: c.table,
        fk: c.fk,
        ok: !error,
        count: Array.isArray(data) ? data.length : null,
        error: error?.message || null,
        sample: debug && Array.isArray(data) ? data.slice(0, 2) : undefined,
      });

      if (!error && Array.isArray(data) && data.length) {
        members = data.map((row, i) => {
          let submission_id = '';
          for (const f of submissionFields) {
            if (row[f] != null && String(row[f]).trim() !== '') {
              submission_id = String(row[f]).trim();
              break;
            }
          }
          return {
            submission_id,
            position: Number(row.position ?? i + 1),
            note: row.note ?? '',
          };
        });
        break;
      }
    } catch (e) {
      tried.push({
        table: c.table,
        fk: c.fk,
        ok: false,
        error: e?.message || 'query threw',
      });
    }
  }

  group.members = members;
  if (debug) group._members_debug = tried;
}

    // IMPORTANT: return the *group object itself* (not { ok, group })
    res.status(200).json(group);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Unexpected error' });
  }
}

// Force Node runtime on Vercel
export const config = { runtime: 'nodejs' };
