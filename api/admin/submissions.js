// GET /api/admin/submissions
// Reads from Supabase view `admin_submissions_v` (joined with latest group)
// Supports ?q=search&status=pending_payment,page=1,limit=50

import { sb } from '../_util/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // --- cookie gate (set by /api/admin-login)
  const cookie = req.headers.cookie || '';
  const authed = cookie.split(';').some(v => v.trim().startsWith('psa_admin=1'));
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const supabase = sb();

    // Query params
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = (url.searchParams.get('q') || '').trim();
    const statusParam = (url.searchParams.get('status') || '').trim();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Base select from the view
    let query = supabase
      .from('admin_submissions_v')
      .select(
        `
        submission_id,
        customer_email,
        status,
        cards,
        evaluation,
        totals,
        grading_service,
        created_at,
        submitted_at_iso,
        paid_at_iso,
        paid_amount,
        shopify_order_name,
        shop_domain,
        last_updated_at,
        group_id,
        group_code
      `,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(from, to);

    // Search: submission_id or customer_email
    if (q) {
      const like = `%${q}%`;
      query = query.or(`submission_id.ilike.${like},customer_email.ilike.${like}`);
    }

    // Status filter: comma-separated
    if (statusParam) {
      const statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) query = query.in('status', statuses);
    }

    const { data, error, count } = await query;
    if (error) {
      console.error('[admin/submissions] db_error:', error);
      return res.status(500).json({ ok: false, error: 'db_error' });
    }

    // Normalize minimally; keep existing keys; add group fields
    const items = (data || []).map(row => ({
      submission_id: row.submission_id ?? null,
      customer_email: row.customer_email ?? null,
      status: row.status ?? null,
      cards: row.cards ?? 0,
      evaluation: row.evaluation ?? 0,
      totals: row.totals ?? null,
      grading_service: row.grading_service ?? null,
      created_at: row.created_at ?? null,
      submitted_at_iso: row.submitted_at_iso ?? null,
      paid_at_iso: row.paid_at_iso ?? null,
      paid_amount: row.paid_amount ?? null,
      shopify_order_name: row.shopify_order_name ?? null,
      shop_domain: row.shop_domain ?? null,
      last_updated_at: row.last_updated_at ?? null,
      group_id: row.group_id ?? null,
      group_code: row.group_code ?? null
    }));

    return res.status(200).json({
      ok: true,
      page,
      limit,
      total: typeof count === 'number' ? count : items.length,
      items
    });
  } catch (e) {
    console.error('[admin/submissions] server_error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
