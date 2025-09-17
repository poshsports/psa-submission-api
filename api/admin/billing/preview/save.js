// /api/admin/billing/preview/save.js  (ESM, Vercel serverless)
import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

const DEFAULTS = { grade_fee_cents: 2000, shipping_cents: 500 };

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
const uniq = (arr) => Array.from(new Set(arr));

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error:'Method not allowed' }); }
    if (!requireAdmin(req)) return json(res, 401, { error: 'Unauthorized' });

    const { customer_email, items, invoice_id: incomingInvoiceId } = await readBody(req);
    const email = String(customer_email || '').trim().toLowerCase();
    const list = Array.isArray(items) ? items : [];
    if (!email) return json(res, 400, { error: 'customer_email is required' });
    if (!list.length) return json(res, 400, { error: 'No items to save' });

    // Normalize -> map card_id => upcharge_cents
    const upMap = new Map();
    const cardIds = [];
    for (const it of list) {
      const id = String(it?.card_id || '').trim();
      if (!id) continue;
      const cents = Math.max(0, Math.round(Number(it?.upcharge_cents || 0)));
      upMap.set(id, cents);
      cardIds.push(id);
    }
    const ids = uniq(cardIds);
    if (!ids.length) return json(res, 400, { error: 'No valid card ids' });

    const client = sb();

    // Cards -> submission codes
    const { data: cards, error: cardsErr } = await client
      .from('submission_cards')
      .select('id, submission_id')
      .in('id', ids);
    if (cardsErr) return json(res, 500, { error: 'Failed to fetch cards', details: cardsErr.message });
    if (!cards || cards.length !== ids.length) {
      const got = new Set((cards || []).map(r => r.id));
      return json(res, 400, { error: 'Some cards not found', missing: ids.filter(x => !got.has(x)) });
    }

    const subCodes = uniq(cards.map(r => r.submission_id).filter(Boolean));
    if (!subCodes.length) return json(res, 400, { error: 'Cards missing submission codes' });

// Submissions -> shopify_customer_id (from psa_submissions)
const { data: subs, error: subsErr } = await client
  .from('psa_submissions')
  .select('submission_id, shopify_customer_id, customer_email')
  .in('submission_id', subCodes);
if (subsErr) return json(res, 500, { error: 'Failed to fetch submissions', details: subsErr.message });
if (!subs?.length) return json(res, 400, { error: 'Submissions not found for cards' });

const shopIds = uniq(subs.map(s => s.shopify_customer_id).filter(Boolean));
const shopify_customer_id = shopIds[0] || null;
if (!shopify_customer_id) return json(res, 400, { error: 'Missing shopify_customer_id on submissions' });

// Derive group_code via group_submissions -> groups(code).
// If multiple different groups are present, use 'MULTI'.
let group_code = 'MULTI';
const { data: gs, error: gsErr } = await client
  .from('group_submissions')
  .select('group_id, submission_id')
  .in('submission_id', subCodes);
if (gsErr) return json(res, 500, { error: 'Failed to fetch group_submissions', details: gsErr.message });

if (gs?.length) {
  const groupIds = uniq(gs.map(g => g.group_id).filter(Boolean));
  if (groupIds.length) {
    const { data: grps, error: gErr } = await client
      .from('groups')
      .select('id, code')
      .in('id', groupIds);
    if (gErr) return json(res, 500, { error: 'Failed to fetch groups', details: gErr.message });

    const codes = uniq((grps || []).map(g => g.code).filter(Boolean));
    if (codes.length === 1) group_code = codes[0];
  }
}

// ===== Resolve or create invoice (reuse open per customer+group) =====
let invoice_id = String(incomingInvoiceId || '').trim();

if (!invoice_id) {
  // A) Try to reuse via existing links (any of the submissions already linked to an open invoice)
  const { data: links, error: linkErr } = await client
    .from('billing_invoice_submissions')
    .select('invoice_id')
    .in('submission_code', subCodes);
  if (linkErr) return json(res, 500, { error: 'Failed to read invoice links', details: linkErr.message });

  let existing = null;
  if (links?.length) {
    const invIds = uniq(links.map(l => l.invoice_id));
    const { data: invs, error: invErr } = await client
      .from('billing_invoices')
      .select('id, status, updated_at')
      .in('id', invIds)
      .in('status', ['pending','draft']);
    if (invErr) return json(res, 500, { error: 'Failed to read invoices', details: invErr.message });
    if (invs?.length) invs.sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)), existing = invs[0];
  }

  // B) Fallback: reuse by (shopify_customer_id, group_code) unique-open rule
  if (!existing) {
    const { data: invs2, error: inv2Err } = await client
      .from('billing_invoices')
      .select('id, updated_at')
      .eq('shopify_customer_id', shopify_customer_id)
      .eq('group_code', group_code)
      .in('status', ['pending','draft'])
      .order('updated_at', { ascending: false })
      .limit(1);
    if (inv2Err) return json(res, 500, { error: 'Failed to read open invoice by customer/group', details: inv2Err.message });
    if (invs2 && invs2.length) existing = invs2[0];
  }

  if (existing) {
    invoice_id = existing.id;
  } else {
    // C) Create new (handle race with unique index by catching 23505)
    const now = new Date().toISOString();
    const { data: inserted, error: insErr } = await client
      .from('billing_invoices')
      .insert([{
        group_code,
        shopify_customer_id,
        status: 'pending',
        currency: 'USD',
        shipping_cents: DEFAULTS.shipping_cents,
        subtotal_cents: 0,
        total_cents: 0,
        created_at: now,
        updated_at: now
      }])
      .select('id')
      .single();

    if (insErr && insErr.code === '23505') {
      // Someone else created the open invoice first — reuse it
      const { data: invs3, error: inv3Err } = await client
        .from('billing_invoices')
        .select('id')
        .eq('shopify_customer_id', shopify_customer_id)
        .eq('group_code', group_code)
        .in('status', ['pending','draft'])
        .order('updated_at', { ascending: false })
        .limit(1);
      if (inv3Err || !invs3?.length) return json(res, 500, { error: 'Race on create but no invoice found' });
      invoice_id = invs3[0].id;
    } else if (insErr) {
      return json(res, 500, { error: 'Failed to create invoice', details: insErr.message });
    } else {
      invoice_id = inserted.id;
    }
  }
} else {
  const { data: inv, error: invErr } = await client
    .from('billing_invoices')
    .select('id')
    .eq('id', invoice_id)
    .single();
  if (invErr || !inv) return json(res, 404, { error: 'invoice_id not found' });
}
    
    // Idempotent clear for these cards (requires submission_card_uuid column)
    const { error: delErr } = await client
      .from('billing_invoice_items')
      .delete()
      .eq('invoice_id', invoice_id)
      .in('submission_card_uuid', ids)
      .in('kind', ['service','upcharge'])
    if (delErr) return json(res, 500, { error: 'Failed to clear existing items', details: delErr.message });

    // Insert grading + upcharge
    const now = new Date().toISOString();
    const codeByCard = new Map(cards.map(r => [r.id, r.submission_id]));
    const gradingRows = ids.map(cid => ({
      invoice_id,
      submission_card_uuid: cid,
      submission_code: codeByCard.get(cid),
      kind: 'service',
      title: 'Grading Fee',
      qty: 1,
      unit_cents: DEFAULTS.grade_fee_cents,
      amount_cents: DEFAULTS.grade_fee_cents,
      created_at: now
    }));
    const upchargeRows = ids.map(cid => {
      const cents = upMap.get(cid) ?? 0;
      return {
        invoice_id,
        submission_card_uuid: cid,
        submission_code: codeByCard.get(cid),
        kind: 'upcharge',
        title: 'Upcharge',
        qty: 1,
        unit_cents: cents,
        amount_cents: cents,
        created_at: now
      };
    });

    const { error: insG } = await client.from('billing_invoice_items').insert(gradingRows);
    if (insG) return json(res, 500, { error: 'Failed to insert grading items', details: insG.message });
    const { error: insU } = await client.from('billing_invoice_items').insert(upchargeRows);
    if (insU) return json(res, 500, { error: 'Failed to insert upcharge items', details: insU.message });

    // Rebuild invoice<->submission links
    const { error: delLinks } = await client.from('billing_invoice_submissions').delete().eq('invoice_id', invoice_id);
    if (delLinks) return json(res, 500, { error: 'Failed to clear invoice links', details: delLinks.message });
    const linkRows = uniq(subCodes).map(code => ({ invoice_id, submission_code: code }));
    const { error: insLinks } = await client.from('billing_invoice_submissions').insert(linkRows);
    if (insLinks) return json(res, 500, { error: 'Failed to insert invoice links', details: insLinks.message });

    // Recompute totals
    const { data: sums, error: sumErr } = await client
      .from('billing_invoice_items')
      .select('amount_cents')
      .eq('invoice_id', invoice_id);
    if (sumErr) return json(res, 500, { error: 'Failed to load items for totals', details: sumErr.message });
    const subtotal = (sums || []).reduce((a, r) => a + (Number(r.amount_cents) || 0), 0);

    const { data: invShip, error: shipErr } = await client
      .from('billing_invoices')
      .select('shipping_cents')
      .eq('id', invoice_id)
      .single();
    if (shipErr) return json(res, 500, { error: 'Failed to read shipping', details: shipErr.message });
    const shipping = Number(invShip?.shipping_cents ?? DEFAULTS.shipping_cents) || 0;

    const { error: upInv } = await client
      .from('billing_invoices')
      .update({ subtotal_cents: subtotal, total_cents: subtotal + shipping, updated_at: new Date().toISOString() })
      .eq('id', invoice_id);
    if (upInv) return json(res, 500, { error: 'Failed to update invoice totals', details: upInv.message });

    return json(res, 200, { saved: gradingRows.length + upchargeRows.length, invoice_id });
  } catch (err) {
    console.error('[preview/save] error', err);
    return json(res, 500, { error: err?.message || String(err) });
  }
}
