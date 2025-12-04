// /api/admin/billing/preview/prefill.js
import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/* -------------------------------------------------------
   ADDRESS NORMALIZATION (matches billing_to_bill_v rules)
------------------------------------------------------- */

function normalizeShipTo(raw) {
  if (!raw || typeof raw !== "object") return null;

  const name   = String(raw.name   || raw.full_name || raw.contact || "").trim();
  const line1  = String(raw.line1  || raw.address1 || raw.street || "").trim();
  const line2  = String(raw.line2  || raw.address2 || "").trim();
  const city   = String(raw.city   || "").trim();
  const region = String(raw.region || raw.state || "").trim();
  const postal = String(raw.postal || raw.zip || "").trim();
  const country= String(raw.country || "US").trim();

  if (!line1 && !city && !postal) return null;

  return { name, line1, line2, city, region, postal, country };
}

// convert invoice DB row → normalized key
function normalizeShipKeyFromInvoice(inv) {
  if (!inv) return '';

  const fields = [
    inv.ship_to_line1,
    inv.ship_to_line2,
    inv.ship_to_city,
    inv.ship_to_region,
    inv.ship_to_postal,
    inv.ship_to_country || 'US'
  ];

  return fields
    .map(x => String(x || '').trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}


// convert incoming shipTo → normalized key
function normalizeShipKeyFromShipTo(shipTo) {
  if (!shipTo) return '';

  const fields = [
    shipTo.line1,
    shipTo.line2,
    shipTo.city,
    shipTo.region,
    shipTo.postal,
    (shipTo.country || 'US')
  ];

  return fields
    .map(x => String(x || '').trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------
   HANDLER
------------------------------------------------------- */

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow','GET');
      return json(res, 405, { error:'Method not allowed' });
    }
    if (!requireAdmin(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    // parse inputs
    const email = String(req.query.email || '').trim().toLowerCase();
    const subsRaw = String(req.query.subs || '').trim();
    const shipToRaw = req.query.ship_to ? JSON.parse(req.query.ship_to) : null;

    const subCodes = subsRaw
      ? subsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    if (!email || !subCodes.length) {
      return json(res, 200, { invoice_id: null, items: [] });
    }

    // normalize incoming ship-to
    const shipTo = normalizeShipTo(shipToRaw);
    const incomingShipKey = shipTo
      ? normalizeShipKeyFromShipTo(shipTo)
      : '';

    const client = sb();

    /* ----------------------------------------------------
       1) Look for existing invoices linked to these subs
    ---------------------------------------------------- */
    const { data: links, error: linkErr } = await client
      .from('billing_invoice_submissions')
      .select('invoice_id')
      .in('submission_code', subCodes);

    if (linkErr) {
      console.error('[prefill] linkErr:', linkErr);
      return json(res, 500, { error: 'Failed to read invoice-submission links' });
    }

    let candidateInvoiceId = null;

    if (links?.length) {
      const invoiceIds = [...new Set(links.map(l => l.invoice_id))];

      const { data: invoices, error: invErr } = await client
        .from('billing_invoices')
        .select(`
          id,
          updated_at,
          status,
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
        console.error('[prefill] invErr:', invErr);
        return json(res, 500, { error:'Failed to read invoices' });
      }

      if (invoices?.length) {
        let candidates = invoices;

        // Must match address exactly if client sent address
        if (incomingShipKey) {
          candidates = candidates.filter(inv =>
            normalizeShipKeyFromInvoice(inv) === incomingShipKey
          );
        }

        if (candidates.length) {
          candidates.sort((a, b) =>
            new Date(b.updated_at) - new Date(a.updated_at)
          );
          candidateInvoiceId = candidates[0].id;
        }
      }
    }

    /* ----------------------------------------------------
       No fallback logic.
       If the address doesn't match → must create a new invoice.
       This keeps deterministic grouping by (email + address).
    ---------------------------------------------------- */

/* ----------------------------------------------------
   Use matched invoice to return ship-to fields
---------------------------------------------------- */
let shipFields = null;
let matchedInvoice = null;

// We can only know matched invoice if invoices existed
if (candidateInvoiceId) {
  // Re-fetch the invoice row (safe + simple)
  const { data: invoiceRow, error: inv2Err } = await client
    .from('billing_invoices')
    .select(`
      id,
      ship_to_line1,
      ship_to_line2,
      ship_to_city,
      ship_to_region,
      ship_to_postal,
      ship_to_country
    `)
    .eq('id', candidateInvoiceId)
    .maybeSingle();

  if (!inv2Err && invoiceRow) {
    matchedInvoice = invoiceRow;

    shipFields = {
      ship_to_line1: invoiceRow.ship_to_line1,
      ship_to_line2: invoiceRow.ship_to_line2,
      ship_to_city: invoiceRow.ship_to_city,
      ship_to_region: invoiceRow.ship_to_region,
      ship_to_postal: invoiceRow.ship_to_postal,
      ship_to_country: invoiceRow.ship_to_country
    };
  }
}

/* ----------------------------------------------------
   Load saved upcharges for this invoice
---------------------------------------------------- */
let items = [];
if (candidateInvoiceId) {
  const { data: itemRows, error: itemErr } = await client
    .from('billing_invoice_items')
    .select('submission_card_uuid, unit_cents, kind')
    .eq('invoice_id', candidateInvoiceId)
    .eq('kind', 'upcharge');

  if (!itemErr && itemRows) {
    items = itemRows.map(r => ({
      card_id: String(r.submission_card_uuid),
      upcharge_cents: Number(r.unit_cents || 0)
    }));
  }
}


/* ----------------------------------------------------
   RETURN FULL PREFILL
---------------------------------------------------- */
return json(res, 200, {
  invoice_id: candidateInvoiceId || null,
  ship_to: shipFields,
  items
});



  } catch (err) {
    console.error('[prefill] error', err);
    return json(res, 500, { error: err?.message || String(err) });
  }
}
