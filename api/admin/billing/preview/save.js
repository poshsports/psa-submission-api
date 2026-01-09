// /api/admin/billing/preview/save.js  (ESM)
import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

const DEFAULTS = { grade_fee_cents: 2000, shipping_cents: 500 };

/* -------------------------------------------------------
   LOOKUP SHOPIFY CUSTOMER ID BY EMAIL
------------------------------------------------------- */
async function resolveShopifyCustomerId(email) {
  if (!email) return null;

  // Try matching psa_submissions (most reliable source)
  const { data, error } = await sb()
    .from('psa_submissions')
    .select('shopify_customer_id')
    .eq('customer_email', email)
    .not('shopify_customer_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (data?.shopify_customer_id) return data.shopify_customer_id;

  // If your database has a dedicated customer table, drop-in replacement:
  // const { data: cust } = await sb()
  //   .from('customers')
  //   .select('shopify_customer_id')
  //   .eq('email', email)
  //   .maybeSingle();
  // return cust?.shopify_customer_id || null;

  return null;
}

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/* -------------------------------------------------------
   ADDRESS NORMALIZATION (MUST MATCH to-bill + prefill)
------------------------------------------------------- */

function normalizeShipTo(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name   = String(raw.name   || raw.full_name || raw.contact || '').trim();
  const line1  = String(raw.line1  || raw.address1 || raw.street || '').trim();
  const line2  = String(raw.line2  || raw.address2 || '').trim();
  const city   = String(raw.city   || '').trim();
  const region = String(raw.region || raw.state || '').trim();
  const postal = String(raw.postal || raw.zip || '').trim();
  const country= String(raw.country || 'US').trim();

  // Require at least enough info to be a real address
  if (!line1 && !city && !postal) return null;

  return { name, line1, line2, city, region, postal, country };
}


function normalizeShipKeyFromShipTo(shipTo) {
  if (!shipTo) return '';
  const parts = [
    shipTo.line1,
    shipTo.line2,
    shipTo.city,
    shipTo.region,
    shipTo.postal,
    shipTo.country
  ];
  return parts
    .map(p => String(p || '').trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeShipKeyFromInvoice(inv) {
  if (!inv) return '';
  const parts = [
    inv.ship_to_line1,
    inv.ship_to_line2,
    inv.ship_to_city,
    inv.ship_to_region,
    inv.ship_to_postal,
    inv.ship_to_country || 'US'
  ];
  return parts
    .map(p => String(p || '').trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchGradingCentsByCard(cardIds) {
  if (!Array.isArray(cardIds) || !cardIds.length) return {};
  const { data, error } = await sb()
    .from('billing_invoice_cards_v')
    .select('card_id, grading_amount')
    .in('card_id', cardIds);

  if (error) return {};
  const map = {};
  for (const row of data) {
    map[String(row.card_id)] = Number(row.grading_amount) || 0;
  }
  return map;
}

const uniq = (arr) => Array.from(new Set(arr));

/* -------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------- */

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (!requireAdmin(req)) return json(res, 401, { error: 'Unauthorized' });

    /* -------------------------------------------
       INPUTS
    ------------------------------------------- */
const body = await readBody(req);

const {
  customer_email,
  items,
  invoice_id: incomingInvoiceId,
  force_new
} = body;

// normalize once
const shipTo = body.ship_to ? normalizeShipTo(body.ship_to) : null;




    const email = String(customer_email || '').trim().toLowerCase();

    if (!email) return json(res, 400, { error: 'customer_email required' });

    const list = Array.isArray(items) ? items : [];
    if (!list.length) return json(res, 400, { error: 'No items to save' });

    /* -------------------------------------------
       NORMALIZE card_ids + upcharges
    ------------------------------------------- */
    const upMap = new Map();
    const cardIds = [];

    for (const it of list) {
      const id = String(it?.card_id || '').trim();
      if (!id) continue;
      cardIds.push(id);
      upMap.set(id, Math.max(0, Math.round(Number(it?.upcharge_cents || 0))));
    }
    const ids = uniq(cardIds);
    if (!ids.length) return json(res, 400, { error: 'No valid card IDs' });

    // Resolve card → submission_id
    const client = sb();
    const { data: cards, error: cardErr } = await client
      .from('submission_cards')
      .select('id, submission_id, card_description')
      .in('id', ids);

    if (cardErr)
      return json(res, 500, { error: 'Failed to fetch cards', details: cardErr.message });

    if (!cards || cards.length !== ids.length) {
      const got = new Set((cards || []).map(r => r.id));
      return json(res, 400, {
        error: 'Some cards not found',
        missing: ids.filter(x => !got.has(x))
      });
    }

    const codeByCard = new Map(cards.map(r => [r.id, r.submission_id]));
    const descByCard = new Map(cards.map(r => [r.id, (r.card_description || '').trim()]));

    const subCodes = uniq(cards.map(r => r.submission_id).filter(Boolean));
    if (!subCodes.length) return json(res, 400, { error: 'Cards missing submission codes' });

    // 🔹 we’ll need this both for reuse and for new invoice
    const resolvedShopifyId = await resolveShopifyCustomerId(email);

    /* -----------------------------------------------------------
       NEW RULE:
       NO group_code logic.
       Invoice grouping is email + normalized address ONLY.
    ----------------------------------------------------------- */

    let invoice_id = incomingInvoiceId ? String(incomingInvoiceId) : '';

      /* -----------------------------------------------------------
       INVOICE REUSE LOGIC
       Reuse an invoice only if:
         – submissions are already linked
       (No JS address-key logic; grouping is handled in SQL views)
    ----------------------------------------------------------- */

    if (!invoice_id && !force_new) {
      // 1) Does any submission already belong to an open invoice?
      const { data: links, error: linkErr } = await client
        .from('billing_invoice_submissions')
        .select('invoice_id')
        .in('submission_code', subCodes);

      if (linkErr) {
        return json(res, 500, {
          error: 'Failed to read invoice links',
          details: linkErr.message
        });
      }

      if (links?.length) {
        const invoiceIds = uniq(links.map(l => l.invoice_id));

        const { data: invs, error: invErr } = await client
          .from('billing_invoices')
          .select(`
            id,
            status,
            updated_at,
            ship_to_line1,
            ship_to_line2,
            ship_to_city,
            ship_to_region,
            ship_to_postal,
            ship_to_country
          `)
          .in('id', invoiceIds)
          .in('status', ['pending','draft']);

        if (invErr) {
          return json(res, 500, {
            error: 'Failed to read invoices',
            details: invErr.message
          });
        }

        if (invs?.length) {
          // Reuse the most recently updated pending/draft invoice
          // that is already linked to these submissions.
          invs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
          invoice_id = invs[0].id;
        }
      }
    }

/* ----------------------------------------------
   If no reusable invoice → ALWAYS create new
---------------------------------------------- */
if (!invoice_id) {
  const now = new Date().toISOString();

  const { data: inserted, error: insErr } = await client
    .from('billing_invoices')
    .insert([{
      status: 'pending',
      currency: 'USD',
      shipping_cents: DEFAULTS.shipping_cents,
      subtotal_cents: 0,
      total_cents: 0,
      created_at: now,
      updated_at: now,

      // 🔥 USE THE RESOLVED VALUE WE ALREADY COMPUTED ABOVE
      shopify_customer_id: resolvedShopifyId,

      // Legacy
      group_code: 'N/A'
    }])
    .select('id')
    .single();

   if (insErr) {
    return json(res, 500, {
      error: 'Failed to create invoice',
      details: insErr.message
    });
  }

  invoice_id = inserted.id;   // 🔥 REQUIRED
}

    /* ----------------------------------------------
       WRITE ship_to fields
    ---------------------------------------------- */
    if (shipTo) {
      const { error: addrErr } = await client
        .from('billing_invoices')
.update({
  ship_to_name:   shipTo.name || '',
  ship_to_line1:  shipTo.line1,
  ship_to_line2:  shipTo.line2,
  ship_to_city:   shipTo.city,
  ship_to_region: shipTo.region,
  ship_to_postal: shipTo.postal,
  ship_to_country: shipTo.country
})
        .eq('id', invoice_id);

      if (addrErr)
        return json(res, 500, { error:'Failed to update shipping', details: addrErr.message });
    }

    /* ----------------------------------------------
       CLEAR old service+upcharge rows for these cards
    ---------------------------------------------- */
    const { error: delErr } = await client
      .from('billing_invoice_items')
.delete()
.eq('invoice_id', invoice_id)
.in('submission_card_uuid', ids);


    if (delErr)
      return json(res, 500, { error:'Failed to clear items', details: delErr.message });

    /* ----------------------------------------------
       INSERT grading + upcharges
    ---------------------------------------------- */

    const gradingMap = await fetchGradingCentsByCard(ids);
    const now = new Date().toISOString();

const gradingRows = ids.map(cid => {
  const unit = Number(gradingMap[cid]) || DEFAULTS.grade_fee_cents;
  return {
    invoice_id,
    submission_card_uuid: cid,
    submission_code: codeByCard.get(cid),
    kind: 'service',
    title: `${codeByCard.get(cid) || ''} – ${descByCard.get(cid) || 'Card'} – PSA Grading`,
    qty: 1,
    unit_cents: unit,
    amount_cents: unit,
    created_at: now
  };
});


    const upchargeRows = ids.map(cid => {
      const cents = upMap.get(cid) || 0;
      return {
        invoice_id,
        submission_card_uuid: cid,
        submission_code: codeByCard.get(cid),
        kind: 'upcharge',
        title: `${codeByCard.get(cid) || ''} – ${descByCard.get(cid) || 'Card'} – Upcharge`,
        qty: 1,
        unit_cents: cents,
        amount_cents: cents,
        meta: { card_id: cid },
        created_at: now
      };
    });

    await client.from('billing_invoice_items').insert(gradingRows);
    await client.from('billing_invoice_items').insert(upchargeRows);

    /* ----------------------------------------------
       REBUILD invoice ↔ submission links
    ---------------------------------------------- */
    await client
      .from('billing_invoice_submissions')
      .delete()
      .eq('invoice_id', invoice_id);

    const linkRows = uniq(subCodes).map(code => ({
      invoice_id,
      submission_code: code
    }));

    await client
      .from('billing_invoice_submissions')
      .insert(linkRows);

    /* ----------------------------------------------
       RECALCULATE totals
    ---------------------------------------------- */
    const { data: sums } = await client
      .from('billing_invoice_items')
      .select('amount_cents')
      .eq('invoice_id', invoice_id);

    const subtotal = (sums || []).reduce((a,r)=>a+(Number(r.amount_cents)||0),0);

    const { data: shipRow } = await client
      .from('billing_invoices')
      .select('shipping_cents')
      .eq('id', invoice_id)
      .single();

    const shipping = Number(shipRow?.shipping_cents || 0);

    await client
      .from('billing_invoices')
      .update({
        subtotal_cents: subtotal,
        total_cents: subtotal + shipping,
        updated_at: new Date().toISOString()
      })
      .eq('id', invoice_id);

return json(res, 200, {
  invoice_id,
  ship_to: shipTo || null,
  saved: gradingRows.length + upchargeRows.length
});


  } catch (err) {
    console.error('[save] error', err);
    return json(res, 500, { error: err?.message || String(err) });
  }
}
