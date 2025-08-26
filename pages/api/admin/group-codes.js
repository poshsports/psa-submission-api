// /pages/api/admin/group-codes.js
// Batch map submissions -> group_code using simple lookups (no fragile joins)

import { createClient } from '@supabase/supabase-js';

// We need the service key server-side to read linking tables safely.
// These envs already exist in your project (same ones your other admin APIs use).
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const idsParam = String(req.query.ids || '').trim(); // "psa-182,psa-181,..."
    if (!idsParam) return res.status(400).json({ error: 'ids required' });

    const submissionIds = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (submissionIds.length === 0) {
      return res.status(400).json({ error: 'no ids' });
    }

    // 1) resolve external submission_id -> internal submissions.id (uuid)
    const { data: subRows, error: subErr } = await supabase
      .from('submissions')
      .select('id, submission_id')
      .in('submission_id', submissionIds);

    if (subErr) throw subErr;

    // Map external id => internal uuid
    const sidToUuid = new Map(subRows.map(r => [String(r.submission_id), r.id]));
    const uuids = subRows.map(r => r.id);
    if (uuids.length === 0) {
      return res.json({ ok: true, data: [] });
    }

    // 2) find group links (join table)
    // Assumes linking table: group_submissions(group_id uuid, submission_id uuid)
    const { data: linkRows, error: linkErr } = await supabase
      .from('group_submissions')
      .select('group_id, submission_id')
      .in('submission_id', uuids);

    if (linkErr) throw linkErr;

    const groupIds = Array.from(new Set(linkRows.map(r => r.group_id).filter(Boolean)));
    if (groupIds.length === 0) {
      // no groups
      const out = submissionIds.map(sid => ({ submission_id: sid, group_code: null }));
      return res.json({ ok: true, data: out });
    }

    // 3) get group codes
    // Assumes groups(id uuid, code text)
    const { data: groupRows, error: grpErr } = await supabase
      .from('groups')
      .select('id, code')
      .in('id', groupIds);

    if (grpErr) throw grpErr;

    const gidToCode = new Map(groupRows.map(g => [g.id, g.code || null]));

    // Build result for all requested submissions (if multiple links, pick first)
    const uuidToCode = new Map();
    for (const lr of linkRows) {
      if (!uuidToCode.has(lr.submission_id)) {
        uuidToCode.set(lr.submission_id, gidToCode.get(lr.group_id) || null);
      }
    }

    const result = submissionIds.map(sid => {
      const uuid = sidToUuid.get(sid);
      const code = uuid ? (uuidToCode.get(uuid) || null) : null;
      return { submission_id: sid, group_code: code };
    });

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
}
