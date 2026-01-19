// /api/admin/billing/create-drafts.js  (ESM)
// Creates Draft Orders either:
//   1) Per explicit billing invoice id(s) (invoice_ids[] path)  ✅ invoice-aware
//   2) Per group_code (legacy flow)                            ✅ unchanged behavior

import { sb } from '../../_util/supabase.js';
import { requireAdmin } from '../../_util/adminAuth.js';

const STORE = process.env.SHOPIFY_STORE; // e.g. poshsports.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

// ---- helpers ----
function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}
function assertEnv() {
  if (!STORE || !ADMIN_TOKEN) {
    throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_ACCESS_TOKEN env');
  }
}
function moneyStrFromCents(cents) {
  return (Math.round(cents) / 100).toFixed(2);
}
async function shopifyFetch(path, method = 'GET', body) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Shopify ${method} ${path} failed ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Build a Shopify shipping_address object from invoice ship_to_* columns
function buildShippingAddressFromInvoice(inv) {
  const hasAny =
    inv.ship_to_name ||
    inv.ship_to_line1 ||
    inv.ship_to_city ||
    inv.ship_to_region ||
    inv.ship_to_postal;

  if (!hasAny) return null;

  return {
    name:     inv.ship_to_name   || '',
    address1: inv.ship_to_line1  || '',
    address2: inv.ship_to_line2  || '',
    city:     inv.ship_to_city   || '',
    province: inv.ship_to_region || '',
    zip:      inv.ship_to_postal || '',
    country:  inv.ship_to_country || 'US'
  };
}

// Creates/attaches a Shopify draft for a single billing invoice id.
// STRICTLY invoice-aware: uses billing_invoice_items + invoice shipping,
// and existing billing_invoice_submissions links for metadata.
async function createDraftForInvoice(client, invoiceId /*, RATE_CENTS (unused) */) {
  const DEFAULT_SHIPPING_CENTS = 500; // fallback $5 if nothing else is set

  // 1) Load invoice, including shipping + ship_to_* fields
  const { data: inv, error: invErr } = await client
    .from('billing_invoices')
    .select(`
      id,
      shopify_customer_id,
      status,
      draft_id,
      group_code,
      shipping_cents,
      subtotal_cents,
      total_cents,
      ship_to_name,
      ship_to_line1,
      ship_to_line2,
      ship_to_city,
      ship_to_region,
      ship_to_postal,
      ship_to_country
    `)
    .eq('id', invoiceId)
    .single();

  if (invErr || !inv) return { ok: false, error: 'invoice-not-found' };

  if (!inv.shopify_customer_id) {
    return { ok: false, error: 'missing-shopify-customer-id' };
  }

  // If it already has a draft, just reuse it
  if (inv.draft_id) {
    return {
      ok: true,
      data: {
        invoice_id: inv.id,
        draft_id: inv.draft_id,
        invoice_url: inv.invoice_url || null,
        already: true
      }
    };
  }

  // 2) Existing submission links for this invoice (for notes only)
  const { data: links, error: linkErr } = await client
    .from('billing_invoice_submissions')
    .select('submission_code')
    .eq('invoice_id', inv.id);

  if (linkErr) {
    return { ok: false, error: 'load-links-failed', details: linkErr.message };
  }

  const codes = (links || []).map(l => l.submission_code).filter(Boolean);

// 3) Build Shopify line items from cards (canonical source of truth)
if (!codes.length) {
  return { ok: false, error: 'no-linked-submissions' };
}

const { data: cards, error: cardsErr } = await client
  .from('billing_invoice_cards_v')
  .select(`
    card_id,
    submission_id,
    card_description,
    break_date,
    break_channel,
    break_number,
    grading_service,
    grading_amount,
    upcharge_amount
  `)
  .in('submission_id', codes)
  .order('submission_id', { ascending: true });

if (cardsErr) {
  return { ok: false, error: 'load-cards-failed', details: cardsErr.message };
}
if (!cards || !cards.length) {
  return { ok: false, error: 'no-cards-for-linked-submissions' };
}

const line_items = [];
let subtotal = 0;

// Helper for “Option C” title formatting
function fmtBreakInfo(row) {
  const parts = [];
  if (row.break_date) parts.push(String(row.break_date));
  if (row.break_channel) parts.push(String(row.break_channel));
  if (row.break_number) parts.push(`Break #${row.break_number}`);
  return parts.length ? `(${parts.join(' • ')})` : '';
}

for (const c of cards) {
  const gradingCents = Math.max(0, Number(c.grading_amount || 0));
  const upchargeCents = Math.max(0, Number(c.upcharge_amount || 0));

  const desc = (c.card_description || 'Card').toString().trim();
  const svc = (c.grading_service || 'PSA Grading').toString().trim();
  const breakInfo = fmtBreakInfo(c);

  // 1) One grading line per card
  if (gradingCents > 0) {
    line_items.push({
      title: `${c.submission_id} — ${desc} ${breakInfo} — ${svc}`.replace(/\s+/g, ' ').trim(),
      quantity: 1,
      price: moneyStrFromCents(gradingCents),
      properties: [
        { name: 'Kind', value: 'Grading' },
        { name: 'Submission', value: c.submission_id },
        { name: 'Card ID', value: String(c.card_id) },
        { name: 'Service', value: svc },
        ...(c.break_channel ? [{ name: 'Break channel', value: String(c.break_channel) }] : []),
        ...(c.break_number ? [{ name: 'Break #', value: String(c.break_number) }] : []),
        ...(c.break_date ? [{ name: 'Break date', value: String(c.break_date) }] : [])
      ]
    });
    subtotal += gradingCents;
  }

  // 2) One upcharge line per card (if any)
  if (upchargeCents > 0) {
    line_items.push({
      title: `${c.submission_id} — ${desc} ${breakInfo} — Upcharge`.replace(/\s+/g, ' ').trim(),
      quantity: 1,
      price: moneyStrFromCents(upchargeCents),
      properties: [
        { name: 'Kind', value: 'Upcharge' },
        { name: 'Submission', value: c.submission_id },
        { name: 'Card ID', value: String(c.card_id) }
      ]
    });
    subtotal += upchargeCents;
  }
}

// 4) Shipping: prefer invoice.shipping_cents else fallback
let shippingCents = 0;

if (Number.isFinite(Number(inv.shipping_cents)) && Number(inv.shipping_cents) > 0) {
  shippingCents = Number(inv.shipping_cents);
} else {
  shippingCents = DEFAULT_SHIPPING_CENTS;
}

if (shippingCents > 0) {
  line_items.push({
    title: 'Return Shipping',
    quantity: 1,
    price: moneyStrFromCents(shippingCents),
    requires_shipping: true,
    taxable: false,
    properties: [{ name: 'Kind', value: 'Shipping' }]
  });
  subtotal += shippingCents;
}


if (!line_items.length) {
  return { ok: false, error: 'no-invoice-items' };
}

  // 5) Build shipping address from invoice ship_to_* (if present)
  const shipping_address = buildShippingAddressFromInvoice(inv);

  // 6) Create Shopify Draft Order
  const cleanedCustomerId =
    Number(String(inv.shopify_customer_id).replace(/\D/g, '')) ||
    inv.shopify_customer_id;

  const note = `PSA Invoice ${inv.id}` + (codes.length ? `: ${codes.join(', ')}` : '');
  const note_attributes = [
    { name: 'psa_invoice_id', value: inv.id },
    { name: 'psa_submission_codes', value: codes.join('|') }
  ];

  const draftPayload = {
    draft_order: {
      customer: { id: cleanedCustomerId },
      currency: 'USD',
      tags: inv.group_code
        ? `PSA Billing, Group:${inv.group_code}`
        : 'PSA Billing',
      note,
      note_attributes,
      line_items,
      ...(shipping_address
        ? { shipping_address }
        : { use_customer_default_address: true })
    }
  };

  const draftJson = await shopifyFetch('/draft_orders.json', 'POST', draftPayload);
  const draft = draftJson?.draft_order;
  if (!draft || !draft.id) return { ok: false, error: 'draft-create-failed' };

  const now = new Date().toISOString();
  const total_cents = subtotal;

  // 7) Update invoice totals & IDs
  await client.from('billing_invoices')
    .update({
      status: 'draft',
      draft_id: String(draft.id),
      invoice_url: draft.invoice_url || null,
      shipping_cents: shippingCents,
      subtotal_cents: subtotal,
      total_cents,
      updated_at: now
    })
    .eq('id', inv.id);

  // If this invoice had no links yet, we DON'T auto-add new submissions here.
  // Split/preview flows are responsible for billing_invoice_submissions.

  return {
    ok: true,
    data: {
      invoice_id: inv.id,
      draft_id: String(draft.id),
      invoice_url: draft.invoice_url || null,
      submissions: codes,
      subtotal_cents: subtotal
    }
  };
}

// ---- main handler ----
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const ok = await requireAdmin(req, res);
    if (!ok) return;
    assertEnv();

    const { group_code, invoice_ids, rate_cents } = (await readBody(req));
    const ids = Array.isArray(invoice_ids) ? invoice_ids.filter(Boolean) : [];
    const RATE_CENTS = Number.isFinite(rate_cents) ? Math.max(0, rate_cents) : 2000; // default $20

    // New path: ensure/create drafts by explicit invoice id(s)
    if (ids.length) {
      const client = sb();
      const created = [];
      const skipped = [];

      for (const iid of ids) {
        const out = await createDraftForInvoice(client, iid, RATE_CENTS);
        if (out.ok) created.push(out.data);
        else skipped.push({ invoice_id: iid, reason: out.error || 'unknown' });
      }

      return json(res, 200, { ok: true, created, skipped });
    }

    // ---- Legacy/group path below (unchanged from your existing behavior) ----
    if (!group_code || typeof group_code !== 'string') {
      return json(res, 400, { error: 'group_code is required (or pass invoice_ids[])' });
    }

    const client = sb();

    // 1) Look up the group
    const { data: group, error: gErr } = await client
      .from('groups')
      .select('id, code, status')
      .eq('code', group_code)
      .single();
    if (gErr || !group) {
      return json(res, 404, { error: `Group not found for code ${group_code}` });
    }

    // 2) Get submission ids attached to this group
    const { data: members, error: mErr } = await client
      .from('group_submissions')
      .select('submission_id')
      .eq('group_id', group.id);
    if (mErr) return json(res, 500, { error: 'Failed to load group_submissions', details: mErr.message });
    const submissionIds = (members || []).map(r => r.submission_id);
    if (submissionIds.length === 0) {
      return json(res, 400, { error: 'No submissions in this group' });
    }

    // 3) Load submissions
    const { data: subs, error: sErr } = await client
      .from('psa_submissions')
      .select('submission_id, shopify_customer_id, customer_email, cards, grading_service, status')
      .in('submission_id', submissionIds);
    if (sErr) return json(res, 500, { error: 'Failed to load submissions', details: sErr.message });

    // only those returned from PSA and not yet billed on an open invoice
    const eligible = subs.filter(s => s.status === 'received_from_psa');

    // 4) Exclude already-billed submissions on open invoices (pending/draft/sent)
    const { data: openInvoices, error: invErr } = await client
      .from('billing_invoices')
      .select('id, shopify_customer_id, status')
      .eq('group_code', group_code)
      .in('status', ['pending', 'draft', 'sent']);
    if (invErr) return json(res, 500, { error: 'Failed to load existing invoices', details: invErr.message });

    let billedSet = new Set();
    if (openInvoices && openInvoices.length) {
      const invIds = openInvoices.map(i => i.id);
      const { data: links, error: linkErr } = await client
        .from('billing_invoice_submissions')
        .select('invoice_id, submission_code')
        .in('invoice_id', invIds);
      if (linkErr) return json(res, 500, { error: 'Failed to load invoice links', details: linkErr.message });
      (links || []).forEach(l => billedSet.add(l.submission_code));
    }

    const toBill = eligible.filter(s => !billedSet.has(s.submission_id));
    if (toBill.length === 0) {
      return json(res, 200, { ok: true, message: 'No new billable submissions (already billed or not returned yet).', created: [] });
    }

    // 5) Group by customer_id (must exist)
    const byCustomer = new Map();
    for (const s of toBill) {
      const cid = (s.shopify_customer_id || '').trim();
      if (!cid) continue; // skip; cannot draft without a customer
      if (!byCustomer.has(cid)) byCustomer.set(cid, []);
      byCustomer.get(cid).push(s);
    }

    const results = [];
    const skipped = [];
    for (const s of toBill) {
      if (!s.shopify_customer_id) skipped.push({ submission_id: s.submission_id, reason: 'missing shopify_customer_id' });
    }

    // 6) For each customer, build draft order with one service line per submission
    for (const [customerId, list] of byCustomer.entries()) {
      // If an open invoice for this customer×group already exists, reuse/update it; otherwise create a new DB row.
      let invoiceRow = (openInvoices || []).find(i => i.shopify_customer_id === customerId) || null;

      if (!invoiceRow) {
        // create DB row first (status 'pending'); we will update with Shopify ids
        const totalCentsPre = list.reduce((sum, s) => sum + (Number(s.cards || 0) * RATE_CENTS), 0);
        const { data: insRows, error: insErr } = await client
          .from('billing_invoices')
          .insert([{
            group_code: group_code,
            shopify_customer_id: customerId,
            status: 'pending',
            currency: 'USD',
            subtotal_cents: totalCentsPre,
            total_cents: totalCentsPre
          }])
          .select('id')
          .limit(1);
        if (insErr) return json(res, 500, { error: 'Failed to create invoice row', details: insErr.message });
        invoiceRow = { id: insRows[0].id, shopify_customer_id: customerId, status: 'pending' };
      } else {
        // refresh totals in case list changed
        const subtotal = list.reduce((sum, s) => sum + (Number(s.cards || 0) * RATE_CENTS), 0);
        await client.from('billing_invoices')
          .update({ subtotal_cents: subtotal, total_cents: subtotal })
          .eq('id', invoiceRow.id);
        // clear previous items/links so we re-sync to current contents
        await client.from('billing_invoice_items').delete().eq('invoice_id', invoiceRow.id);
        await client.from('billing_invoice_submissions').delete().eq('invoice_id', invoiceRow.id);
      }

      // Prepare Shopify line items and notes
      const codes = list.map(s => s.submission_id);
      const line_items = list.map(s => ({
        title: `PSA Grading — ${s.grading_service || 'Service'} — ${s.submission_id}`,
        quantity: Math.max(1, Number(s.cards || 0)),
        price: moneyStrFromCents(RATE_CENTS), // per-card rate
        properties: [
          { name: 'Submission', value: s.submission_id },
          { name: 'Group', value: group_code }
        ]
      }));

      const note = `PSA Group ${group_code}: ${codes.join(', ')}`;
      const note_attributes = [
        { name: 'psa_group_code', value: group_code },
        { name: 'psa_submission_codes', value: codes.join('|') },
        { name: 'psa_invoice_id', value: invoiceRow.id }
      ];

      // Create Shopify Draft Order
      const draftPayload = {
        draft_order: {
          customer: { id: Number(String(customerId).replace(/\D/g, '')) || customerId },
          currency: 'USD',
          tags: `PSA Billing, Group:${group_code}`,
          note,
          note_attributes,
          line_items,
          use_customer_default_address: true
        }
      };

      const draftJson = await shopifyFetch('/draft_orders.json', 'POST', draftPayload);
      const draft = draftJson?.draft_order;
      if (!draft || !draft.id) throw new Error('Draft order create returned no id');

      const subtotal = list.reduce((sum, s) => sum + (Number(s.cards || 0) * RATE_CENTS), 0);
      // Persist invoice details + links + items
      await client.from('billing_invoices')
        .update({
          status: 'draft',
          draft_id: String(draft.id),
          invoice_url: draft.invoice_url || null,
          subtotal_cents: subtotal,
          total_cents: subtotal
        })
        .eq('id', invoiceRow.id);

      // link submissions
      const linkRows = list.map(s => ({
        invoice_id: invoiceRow.id,
        submission_code: s.submission_id,
        submission_uuid: null
      }));
      if (linkRows.length) {
        await client.from('billing_invoice_submissions').insert(linkRows);
      }

      // NOTE: do not flip here; send-invoice.js will mark balance_due after a successful email send

      results.push({
        group_code,
        shopify_customer_id: customerId,
        invoice_id: invoiceRow.id,
        draft_id: String(draft.id),
        invoice_url: draft.invoice_url || null,
        submissions: codes,
        subtotal_cents: subtotal
      });
    }

    return json(res, 200, { ok: true, created: results, skipped });
  } catch (err) {
    console.error('create-drafts error', err);
    return json(res, 500, { error: err.message || String(err) });
  }
}

// read JSON body safely
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}
