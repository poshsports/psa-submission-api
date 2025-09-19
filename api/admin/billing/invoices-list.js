// /api/admin/billing/invoices-list.js  (ESM)
import { sb } from '../../_util/supabase.js';
import { requireAdmin } from '../../_util/adminAuth.js';

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    if (!requireAdmin(req)) return json(res, 401, { error: 'Unauthorized' });

    const client = sb();
    const url = new URL(req.url, 'http://x'); // base doesn't matter in node
    const statusParam = (url.searchParams.get('status') || 'awaiting').toLowerCase();
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10), 1), 500);

    // Map UI buckets -> DB statuses. Adjust if your schema uses different labels.
    const STATUS_MAP = {
      awaiting: ['sent'],           // waiting for payment
      paid:     ['paid', 'closed'], // historical
    };
    const wantedStatuses = STATUS_MAP[statusParam] || STATUS_MAP.awaiting;

    // 1) Grab invoices in this bucket
    const { data: invs, error: invErr } = await client
      .from('billing_invoices')
      .select('id, status, group_code, shopify_customer_id, subtotal_cents, total_cents, shipping_cents, created_at, updated_at')
      .in('status', wantedStatuses)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (invErr) return json(res, 500, { error: 'Failed to load invoices', details: invErr.message });
    if (!invs?.length) return json(res, 200, { items: [] });

    const invoiceIds = invs.map(i => i.id);

    // 2) Load linked submissions for these invoices
    const { data: links, error: linkErr } = await client
      .from('billing_invoice_submissions')
      .select('invoice_id, submission_code')
      .in('invoice_id', invoiceIds);
    if (linkErr) return json(res, 500, { error: 'Failed to load invoice links', details: linkErr.message });

    const subsByInvoice = new Map();
    const allCodes = new Set();
    (links || []).forEach(l => {
      if (!subsByInvoice.has(l.invoice_id)) subsByInvoice.set(l.invoice_id, []);
      subsByInvoice.get(l.invoice_id).push(l.submission_code);
      allCodes.add(l.submission_code);
    });

    // 3) Derive customer email from one representative submission per invoice
    // (same customer across an invoice by design)
    const codeList = Array.from(allCodes);
    let emailByCode = new Map();
    if (codeList.length) {
      const { data: subs, error: subsErr } = await client
        .from('psa_submissions')
        .select('submission_id, customer_email')
        .in('submission_id', codeList);
      if (subsErr) return json(res, 500, { error: 'Failed to load submissions', details: subsErr.message });
      emailByCode = new Map((subs || []).map(s => [s.submission_id, (s.customer_email || '').trim()]));
    }

    // 4) Optional: compute "cards" count from service lines
    const { data: items, error: itemsErr } = await client
      .from('billing_invoice_items')
      .select('invoice_id, kind, qty')
      .in('invoice_id', invoiceIds);
    if (itemsErr) return json(res, 500, { error: 'Failed to load invoice items', details: itemsErr.message });

    const cardsByInvoice = new Map();
    (items || []).forEach(it => {
      if (it.kind !== 'service') return;
      cardsByInvoice.set(it.invoice_id, (cardsByInvoice.get(it.invoice_id) || 0) + (Number(it.qty) || 0));
    });

    // 5) Build rows
    let rows = invs.map(inv => {
      const codes = subsByInvoice.get(inv.id) || [];
      const email = codes.length ? (emailByCode.get(codes[0]) || '') : '';
      return {
        invoice_id: inv.id,
        status: inv.status,
        group_code: inv.group_code || null,
        customer_email: email,
        submissions: codes.map(code => ({ submission_id: code })), // minimal; enough for UI counts/search
        subs_count: codes.length,
        cards: cardsByInvoice.get(inv.id) || 0,
        subtotal_cents: inv.subtotal_cents ?? null,
        shipping_cents: inv.shipping_cents ?? null,
        total_cents: inv.total_cents ?? null,
        updated_at: inv.updated_at,
        created_at: inv.created_at,
      };
    });

    // 6) In-memory search filter (email, group code, submission code)
    if (q) {
      rows = rows.filter(r =>
        (r.customer_email || '').toLowerCase().includes(q) ||
        (r.group_code || '').toLowerCase().includes(q) ||
        r.submissions.some(s => String(s.submission_id).toLowerCase().includes(q))
      );
    }

    return json(res, 200, { items: rows });
  } catch (err) {
    console.error('invoices-list error', err);
    return json(res, 500, { error: err?.message || String(err) });
  }
}
