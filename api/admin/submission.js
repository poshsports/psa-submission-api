// /api/admin/submission.js  (ESM)
// Returns one submission (by submission_id or id) with rich fields for the admin drawer.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // cookie gate (set by /api/admin-login)
  const cookie = req.headers.cookie || '';
  const authed = cookie.split(';').some(v => v.trim().startsWith('psa_admin=1'));
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) {
    return res.status(500).json({ ok: false, error: 'missing_supabase_env' });
  }

  const TABLE = process.env.SUBMISSIONS_TABLE || 'psa_submissions';
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

  const supabase = createClient(URL, KEY);

  const selectCols = `
    id,
    submission_id,
    created_at,
    submitted_at_iso,
    status,
    customer_email,
    cards,
    evaluation,
    grading_service,
    totals,
    address,
    card_info,
    paid_at_iso,
    paid_amount,
    eval_line_subtotal,
    shopify_order_id,
    shopify_order_number,
    shopify_order_name,
    shop_domain
  `;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

  let q = supabase.from(TABLE).select(selectCols).limit(1);
  q = isUuid ? q.or(`id.eq.${id},submission_id.eq.${id}`) : q.eq('submission_id', id);

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: 'db_error', detail: error.message });
  if (!data || !data.length) return res.status(404).json({ ok: false, error: 'not_found' });

  return res.status(200).json({ ok: true, item: data[0] });
}
