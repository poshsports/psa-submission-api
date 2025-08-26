// /api/admin/submission.js  (ESM)
// Returns one submission (by submission_id or id) with group fields for the admin drawer.
// When ?full=1 (or true) it also enriches with shipping info from several sources.

import { sb } from '../_util/supabase.js';

// tiny helper: never throw if a table/column is missing
async function safeSelect(promise) {
  try { return await promise; } catch { return { data: null, error: null }; }
}
const isUuid = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ''));

const pick = (...vals) => {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) return v; // JSON addr
  }
  return null;
};

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
    const idParam = (url.searchParams.get('id') || url.searchParams.get('submission_id') || '').trim();
    const fullParam = String(url.searchParams.get('full') || '').toLowerCase();
    const wantFull = fullParam === '1' || fullParam === 'true';

    if (!idParam) return res.status(400).json({ ok: false, error: 'missing_id' });

    // 1) Base row from the admin VIEW (includes group fields)
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
    q = isUuid(idParam)
      ? q.or(`id.eq.${idParam},submission_id.eq.${idParam}`)
      : q.eq('submission_id', idParam);

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: 'db_error', detail: error.message });
    if (!data || !data.length) return res.status(404).json({ ok: false, error: 'not_found' });

    const item = { ...data[0] };

    // 2) Enrich with shipping when requested
    if (wantFull) {
      // 2a) Pull raw submission row (has most chances to include shipping)
      let subRow = null;
      {
        let sq = supabase
          .from('submissions')
          .select(`
            id, submission_id, customer_email, shopify_order_name,
            ship_to, shipping_address, ship_address, address, meta
          `)
          .limit(1);
        sq = isUuid(idParam)
          ? sq.or(`id.eq.${idParam},submission_id.eq.${idParam}`)
          : sq.eq('submission_id', idParam);
        const { data: sData } = await sq;
        subRow = sData?.[0] || null;
      }

      // 2b) Compute an "effective" shipping from any known fields
      let effective = pick(
        subRow?.ship_to,
        subRow?.shipping_address,
        subRow?.ship_address,
        subRow?.address,
        subRow?.meta?.ship_to,
        subRow?.meta?.shipping_address
      );

      // 2c) If still empty, try related places (best-effort; won't fail if tables missing)
      if (!effective && (subRow?.id || item.shopify_order_name)) {
        // orders table
        const { data: ord } = await safeSelect(
          supabase
            .from('orders')
            .select('shipping_address, ship_to, address, submission_id, shopify_order_name')
            .or(
              [
                subRow?.id ? `submission_id.eq.${subRow.id}` : null,
                item.shopify_order_name ? `shopify_order_name.eq.${item.shopify_order_name}` : null,
              ].filter(Boolean).join(',')
            )
            .limit(1)
        );
        const o = ord?.[0];
        effective = pick(effective, o?.ship_to, o?.shipping_address, o?.address);
      }

      if (!effective && item.customer_email) {
        // customers table
        const { data: cust } = await safeSelect(
          supabase
            .from('customers')
            .select('shipping_address, default_address')
            .eq('email', item.customer_email)
            .limit(1)
        );
        const c = cust?.[0];
        effective = pick(effective, c?.shipping_address, c?.default_address);
      }

      if (!effective && subRow?.id) {
        // submissions_addresses table (if you use a separate table)
        const { data: sa } = await safeSelect(
          supabase
            .from('submissions_addresses')
            .select('address')
            .eq('submission_id', subRow.id)
            .limit(1)
        );
        effective = pick(effective, sa?.[0]?.address);
      }

      // 2d) Write back in canonical fields your UI expects
      if (effective) {
        if (typeof effective === 'string') item.ship_to = effective;
        else item.shipping_address = effective;
      }
    }

    return res.status(200).json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server_error', detail: String(e) });
  }
}
