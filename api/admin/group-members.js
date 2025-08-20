// /api/admin/group-members.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SERVICE_ROLE; // server-side only!

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const isUuid = (s = '') =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

export default async function handler(req, res) {
  // Only GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Very light auth: require passcode cookie (same as the admin UI)
  const hasPassCookie = Boolean(req.cookies?.psa_admin);
  if (!hasPassCookie) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // Accept either ?group_id=<uuid> or ?code=GRP-0005 (or just ?id=…)
    const idParam   = req.query.group_id || req.query.id || '';
    const codeParam = req.query.code || '';

    let groupId = null;

    if (isUuid(idParam)) {
      groupId = idParam;
    } else if (codeParam || /^GRP-/i.test(idParam)) {
      const code = (codeParam || idParam).toString().trim();
      const { data: gByCode, error: gErr } = await supabase
        .from('groups')
        .select('id')
        .eq('code', code)
        .maybeSingle();

      if (gErr) throw gErr;
      if (!gByCode) {
        return res.status(404).json({ ok: false, error: 'Group not found for code' });
      }
      groupId = gByCode.id;
    } else if (idParam) {
      // If it’s not a UUID and not a code, treat as missing/invalid
      return res.status(400).json({ ok: false, error: 'Provide ?group_id=<uuid> or ?code=GRP-XXXX' });
    } else {
      return res.status(400).json({ ok: false, error: 'Missing group identifier' });
    }

    // Fetch members (minimal fields the UI needs)
    const { data: members, error: mErr } = await supabase
      .from('group_members')
      .select('submission_id, position, note')
      .eq('group_id', groupId)
      .order('position', { ascending: true });

    if (mErr) throw mErr;

    // Return a flat array; the frontend already knows how to consume this
    return res.status(200).json(members || []);
  } catch (e) {
    console.error('[group-members] error', e);
    return res.status(500).json({ ok: false, error: e.message || 'Server error' });
  }
}
