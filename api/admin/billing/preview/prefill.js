// /api/admin/billing/preview/prefill.js
import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

// Normalize incoming ship_to from the client
function normalizeShipTo(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name   = String(raw.name   || '').trim();
  const line1  = String(raw.line1  || raw.address1 || raw.street || '').trim();
  const line2  = String(raw.line2  || raw.address2 || '').trim();
  const city   = String(raw.city   || '').trim();
  const region = String(raw.region || raw.state || '').trim();
  const postal = String(raw.postal || raw.zip || '').trim();
  const country= String(raw.country || 'US').trim();

  if (!line1 && !city && !postal) return null;

  return { name, line1, line2, city, region, postal, country };
}

// Convert an invoice DB row → normalized key
function normalizeShipKeyFromInvoice(inv) {
  if (!inv) return '';
  const line1  = (inv.ship_to_line1 || '').trim().toLowerCase();
  const line2  = (inv.ship_to_line2 || '').trim().toLowerCase();
  const city   = (inv.ship_to_city  || '').trim().toLowerCase();
  const region = (inv.ship_to_region|| '').trim().toLowerCase();
  const postal = (inv.ship_to_postal|| '').trim().toLowerCase();
  const country= (inv.ship_to_country|| 'us').trim().toLowerCase();

  return [line1, line2, city, region, postal, country]
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Convert a shipTo object → normalized key
function normalizeShipKeyFromShipTo(shipTo) {
  if (!shipTo) return '';
  const line1  = (shipTo.line1 || '').trim().toLowerCase();
  const line2  = (shipTo.line2 || '').trim().toLowerCase();
  const city   = (shipTo.city  || '').trim().toLowerCase();
  const region = (shipTo.region|| '').trim().toLowerCase();
  const postal = (shipTo.postal|| '').trim().toLowerCase();
  const country= (shipTo.country|| 'us').trim().toLowerCase();

  return [line1, line2, city, region, postal, country]
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (!requireAdmin(req)) return json(res, 401, { error: 'Unauthorized' });

    const email = String(req.query.email || '').trim().toLowerCase();
    const subsRaw = String(req.query.subs || '').trim();
    const shipToRaw = req.query.ship_to ? JSON.parse(req.query.ship_to) : null;

    const subCodes = subsRaw ? subsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!email || !subCodes.length) {
      return json(res, 200, { invoice_id: null, items: [] });
    }

    // Normalize incoming address
    const shipTo = normalizeShipTo(shipToRaw);
    const shipKey = shipTo ? normalizeShipKeyFromShipTo(shipTo) : '';

    // Look for existing invoice via submission links
    const client = sb();

    const { data: links } = await client
      .from('billing_invoice_submissions')
      .select('invoice_id')
      .in('submission_code', subCodes);

    let candidateInvoiceId = null;

    if (links?.length) {
      const invoiceIds = [...new Set(links.map(l => l.invoice_id))];

      const { data: invs } = await client
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

      if (invs?.length) {
        // Filter by address if we know the address
        let filtered = invs;
        if (shipKey) {
          filtered = invs.filter(inv =>
            normalizeShipKeyFromInvoice(inv) === shipKey
          );
        }

        if (filtered.length) {
          // Prefer most recently updated invoice
          filtered.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
          candidateInvoiceId = filtered[0].id;
        }
      }
    }

    return json(res, 200, {
      invoice_id: candidateInvoiceId || null,
      items: [],
    });

  } catch (err) {
    console.error('[prefill] error', err);
    return json(res, 500, { error: err?.message || String(err) });
  }
}
