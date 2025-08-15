// GET /api/admin/submissions
// Reads from Supabase table `psa_submissions` (or SUBMISSIONS_TABLE if set)
// Supports ?q=search&status=pending_payment&page=1&limit=25

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // --- cookie gate (set by /api/admin-login)
  const cookie = req.headers.cookie || '';
  const authed = cookie.split(';').some(v => v.trim().startsWith('psa_admin=1'));
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) {
    return res.status(500).json({ ok: false, error: 'missing_supabase_env' });
  }

  const TABLE = process.env.SUBMISSIONS_TABLE || 'psa_submissions';

  // --- filters / paging
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim(); // e.g. pending_payment | submitted | submitted_paid
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
  const offset = (page - 1) * limit;

  // columns we actually display in admin
  const selectCols = [
    'submission_id',
    'created_at',
    'customer_email',
    'cards',
    'evaluation',
    'status',
    'grading_service',
    'paid_at_iso',
    'paid_amount',
    'eval_line_subtotal',
    'shopify_order_id',
    'shopify_order_number',
    'shopify_order_name',
    'shop_domain',
    'totals'
  ].join(',');

  // base query
  let qs = `select=${encodeURIComponent(selectCols)}&order=created_at.desc&limit=${limit}&offset=${offset}`;

  // status filter
  if (status) {
    qs += `&status=eq.${encodeURIComponent(status)}`;
  }

  // search on submission_id or customer_email
  if (q) {
    const orExpr = `or=(submission_id.ilike.*${q}*,customer_email.ilike.*${q}*)`;
    qs += `&${orExpr}`;
  }

  const endpoint = `${URL.replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(TABLE)}?${qs}`;

  try {
    const r = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: 'count=exact',
        Accept: 'application/json'
      }
    });

    const txt = await r.text();
    let rows = [];
    try { rows = JSON.parse(txt); } catch {}

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: 'supabase_error', detail: txt });
    }

    // parse total from Content-Range: "0-24/123"
    const contentRange = r.headers.get('content-range') || '';
    const totalStr = contentRange.split('/')[1] || '0';
    const total = Math.max(0, parseInt(totalStr, 10) || 0);

    // map rows to the shape the admin UI expects
    const items = (Array.isArray(rows) ? rows : []).map(row => ({
      submission_id: row.submission_id || null,
      customer_email: row.customer_email || null,
      cards: row.cards ?? (Array.isArray(row.card_info) ? row.card_info.length : null),
      evaluation: row.evaluation ?? 0,
      totals: row.totals ?? null,
      status: row.status ?? null,
      grading_service: row.grading_service ?? null,
      created_at: row.created_at ?? null,
      // NOTE: we intentionally removed last_updated_at; use created_at/paid_at_iso instead.
      paid_at_iso: row.paid_at_iso ?? null,
      paid_amount: row.paid_amount ?? null,
      eval_line_subtotal: row.eval_line_subtotal ?? null,
      shopify_order_id: row.shopify_order_id ?? null,
      shopify_order_number: row.shopify_order_number ?? null,
      shopify_order_name: row.shopify_order_name ?? null,
      shop_domain: row.shop_domain ?? null
    }));

    return res.status(200).json({
      ok: true,
      page,
      limit,
      total,
      items
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'fetch_failed', detail: String(e) });
  }
}
