// /api/admin/submission.js  (ESM)
// Returns one submission (by submission_id or id) with group fields for the admin drawer.

import { sb } from '../_util/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // cookie gate (set by /api/admin-login)
  const cookie = req.headers.cookie || '';
  const authed = cookie.split(';').some(v => v.trim().startsWith('psa_admin=1'));
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const supabase = sb();

    // Support both ?id= (uuid or psa-###) and ?submission_id=
    const url = new URL(req.url, `http://${req.headers.host}`);
    const idParam =
      (url.searchParams.get('id') || url.searchParams.get('submission_id') || '').trim();

    if (!idParam) {
      return res.status(400).json({ ok: false, error: 'missing_id' });
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idParam);

    // Select from the VIEW so we get group_id + group_code
    const selectCols = `
      id,
      submission_id,
      created_at,
      customer_email,
      cards,
      evaluation,
      totals,
      status,
      grading_service,
      submitted_at_iso,
      paid_at_iso,
      paid_amount,
      shopify_order_name,
      shop_domain,
      last_updated_at,
      group_id,
      group_code
    `;

    let q = supabase.from('admin_submissions_v').select(selectCols).limit(1);
    q = isUuid
      ? q.or(`id.eq.${idParam},submission_id.eq.${idParam}`)
      : q.eq('submission_id', idParam);

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: 'db_error', detail: error.message });
    if (!data || !data.length) return res.status(404).json({ ok: false, error: 'not_found' });

    return res.status(200).json({ ok: true, item: data[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server_error', detail: String(e) });
  }
}
