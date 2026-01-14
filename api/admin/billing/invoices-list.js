// /api/admin/billing/invoices-list.js  (ESM)
import { sb } from '../../_util/supabase.js';
import { requireAdmin } from '../../_util/adminAuth.js';

const STORE = process.env.SHOPIFY_STORE;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

async function shopifyFetch(path, method = 'GET') {
  const url = `https://${STORE}/admin/api/${API_VERSION}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`Shopify ${method} ${path} ${r.status}: ${text || '(no body)'}`);
  return text ? JSON.parse(text) : {};
}


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
      .select('id, status, group_code, shopify_customer_id, draft_id, invoice_url, subtotal_cents, total_cents, shipping_cents, created_at, updated_at')
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
const { data: subRows, error: subRowsErr } = await client
  .from('admin_submissions_v')
  .select('submission_id, group_code, cards, created_at, last_updated_at')
  .in('submission_id', codeList);

if (subRowsErr) return json(res, 500, { error: 'Failed to load submission rows', details: subRowsErr.message });

const subById = new Map((subRows || []).map(s => [s.submission_id, s]));

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

// Build a view URL per invoice:
// - awaiting: use customer invoice_url (pay link)
// - paid: try to resolve admin order URL from the draft; fall back to invoice_url
const viewUrlById = new Map();
if (statusParam === 'awaiting') {
  for (const inv of invs) viewUrlById.set(inv.id, inv.invoice_url || null);
} else if (statusParam === 'paid') {
  for (const inv of invs) {
    let url = inv.invoice_url || null; // fallback
    try {
      if (inv.draft_id && STORE && ADMIN_TOKEN) {
        const jd = await shopifyFetch(`/draft_orders/${inv.draft_id}.json`, 'GET');
        const orderId = jd?.draft_order?.order_id;
        if (orderId) url = `https://${STORE}/admin/orders/${orderId}`;
      }
    } catch { /* non-fatal */ }
    viewUrlById.set(inv.id, url);
  }
}

// 5) Build rows
let rows = invs.map(inv => {
  const codes = subsByInvoice.get(inv.id) || [];
  const email = codes.length ? (emailByCode.get(codes[0]) || '') : '';

  // Expand submissions with real data
  const subs = codes
    .map(code => subById.get(code))
    .filter(Boolean);

  // Compute cards from submissions (not invoice items)
  const cards = subs.reduce((sum, s) => sum + (Number(s.cards) || 0), 0);

  // Compute returned dates
  let returned_oldest = null;
  let returned_newest = null;

  for (const s of subs) {
    const dt = s.last_updated_at || s.created_at;
    if (!dt) continue;
    if (!returned_oldest || Date.parse(dt) < Date.parse(returned_oldest)) returned_oldest = dt;
    if (!returned_newest || Date.parse(dt) > Date.parse(returned_newest)) returned_newest = dt;
  }

  return {
    invoice_id: inv.id,
    status: inv.status,
    group_code: inv.group_code || null,
    customer_email: email,
    invoice_url: inv.invoice_url || null,
    view_url: viewUrlById.get(inv.id) || inv.invoice_url || null,

    submissions: subs,
    subs_count: subs.length,
    cards,

    returned_oldest,
    returned_newest,

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
