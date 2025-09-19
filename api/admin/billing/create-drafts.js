// /api/admin/billing/create-drafts.js  (ESM)
// Creates combined per-customer Draft Orders for a Returned group.
// Uses your sb() and requireAdmin() helpers as provided.

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

// Creates/attaches a Shopify draft for a single billing invoice id.
// Uses existing links if present; otherwise pulls *all* eligible submissions
// for the same customer (status='received_from_psa') that aren't already on an
// open invoice, then builds the draft and persists DB rows.
async function createDraftForInvoice(client, invoiceId, RATE_CENTS) {
  // 1) Load invoice
  const { data: inv, error: invErr } = await client
    .from('billing_invoices')
    .select('id, shopify_customer_id, status, draft_id')
    .eq('id', invoiceId)
    .single();
  if (invErr || !inv) return { ok: false, error: 'invoice-not-found' };
  if (inv.draft_id) {
    return {
      ok: true,
      data: { invoice_id: inv.id, draft_id: inv.draft_id, already: true }
    };
  }

  // 2) Existing links?
  const { data: links, error: linkErr } = await client
    .from('billing_invoice_submissions')
    .select('submission_code')
    .eq('invoice_id', inv.id);
  if (linkErr) return { ok: false, error: 'load-links-failed', details: linkErr.message };

  let codes = (links || []).map(l => l.submission_code).filter(Boolean);

  // 3) If no links, collect eligible submissions for this customer
  let subs = [];
  if (!codes.length) {
    // all 'received_from_psa' for this customer
    const { data: allForCustomer, error: sErr } = await client
      .from('psa_submissions')
      .select('submission_id, grading_service, cards')
      .eq('shopify_customer_id', inv.shopify_customer_id)
      .eq('status', 'received_from_psa');
    if (sErr) return { ok: false, error: 'load-subs-failed', details: sErr.message };
    subs = Array.isArray(allForCustomer) ? allForCustomer : [];

    // exclude those already linked to open invoices (pending/draft/sent)
    const { data: openInvs, error: openErr } = await client
      .from('billing_invoices')
      .select('id')
      .eq('shopify_customer_id', inv.shopify_customer_id)
      .in('status', ['pending', 'draft', 'sent']);
    if (openErr) return { ok: false, error: 'load-open-invs-failed', details: openErr.message };

    const openIds = (openInvs || []).map(i => i.id);
    let used = [];
    if (openIds.length) {
      const { data: usedLinks, error: usedErr } = await client
        .from('billing_invoice_submissions')
        .select('submission_code')
        .in('invoice_id', openIds);
      if (usedErr) return { ok: false, error: 'load-used-links-failed', details: usedErr.message };
      used = (usedLinks || []).map(u => u.submission_code);
    }
    const usedSet = new Set(used);
    subs = subs.filter(s => !usedSet.has(s.submission_id));
    codes = subs.map(s => s.submission_id);
  }

  if (!codes.length) return { ok: false, error: 'no-eligible-submissions' };

  // 4) Ensure we have details for each code (cards/service)
  if (!subs.length) {
    const { data: forCodes, error: detErr } = await client
      .from('psa_submissions')
      .select('submission_id, grading_service, cards')
      .in('submission_id', codes);
    if (detErr) return { ok: false, error: 'load-sub-details-failed', details: detErr.message };
    subs = Array.isArray(forCodes) ? forCodes : [];
  }

  const line_items = subs.map(s => ({
    title: `PSA Grading — ${s.grading_service || 'Service'} — ${s.submission_id}`,
    quantity: Math.max(1, Number(s.cards || 0)),
    price: moneyStrFromCents(RATE_CENTS),
    properties: [{ name: 'Submission', value: s.submission_id }]
  }));

  const subtotal = subs.reduce(
    (sum, s) => sum + Math.max(1, Number(s.cards || 0)) * RATE_CENTS,
    0
  );

  const draftPayload = {
    draft_order: {
      customer: { id: Number(String(inv.shopify_customer_id).replace(/\D/g, '')) || inv.shopify_customer_id },
      currency: 'USD',
      tags: 'PSA Billing',
      note: `PSA Invoice ${inv.id}: ${codes.join(', ')}`,
      note_attributes: [
        { name: 'psa_invoice_id', value: inv.id },
        { name: 'psa_submission_codes', value: codes.join('|') }
      ],
      line_items,
      use_customer_default_address: true
    }
  };

  const draftJson = await shopifyFetch('/draft_orders.json', 'POST', draftPayload);
  const draft = draftJson?.draft_order;
  if (!draft?.id) return { ok: false, error: 'draft-create-failed' };

  // Update invoice
  await client.from('billing_invoices')
    .update({
      status: 'draft',
      draft_id: String(draft.id),
      invoice_url: draft.invoice_url || null,
      subtotal_cents: subtotal,
      total_cents: subtotal
    })
    .eq('id', inv.id);

  // Insert links if we created from a fresh set
  if (!(links && links.length)) {
    const linkRows = codes.map(code => ({
      invoice_id: inv.id,
      submission_code: code,
      submission_uuid: null
    }));
    if (linkRows.length) {
      await client.from('billing_invoice_submissions').insert(linkRows);
    }
  }

  // Insert item rows
  const itemRows = subs.map(s => ({
    invoice_id: inv.id,
    submission_code: s.submission_id,
    kind: 'service',
    title: `PSA Grading — ${s.grading_service || 'Service'} — ${s.submission_id}`,
    qty: Math.max(1, Number(s.cards || 0)),
    unit_cents: RATE_CENTS,
    amount_cents: Math.max(1, Number(s.cards || 0)) * RATE_CENTS,
    meta: { grading_service: s.grading_service || null }
  }));
  if (itemRows.length) {
    await client.from('billing_invoice_items').insert(itemRows);
  }

  // Flip submission statuses
  await client
    .from('psa_submissions')
    .update({ status: 'balance_due' })
    .in('submission_id', codes);

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
    if (!requireAdmin(req)) return json(res, 401, { error: 'Unauthorized' });
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

// Legacy/group path remains unchanged below
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
          // Shopify Admin REST expects numeric customer id; coerce if string
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

      // Persist invoice details + links + items
      const subtotal = list.reduce((sum, s) => sum + (Number(s.cards || 0) * RATE_CENTS), 0);
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

      // item rows (service lines only for now)
      const itemRows = list.map(s => ({
        invoice_id: invoiceRow.id,
        submission_code: s.submission_id,
        kind: 'service',
        title: `PSA Grading — ${s.grading_service || 'Service'} — ${s.submission_id}`,
        qty: Math.max(1, Number(s.cards || 0)),
        unit_cents: RATE_CENTS,
        amount_cents: Math.max(1, Number(s.cards || 0)) * RATE_CENTS,
        meta: { grading_service: s.grading_service || null }
      }));
      if (itemRows.length) {
        await client.from('billing_invoice_items').insert(itemRows);
      }

      // flip submissions -> balance_due
      await client
        .from('psa_submissions')
        .update({ status: 'balance_due' })
        .in('submission_id', codes);

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
