// /api/admin/billing/preview/prefill.js
import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

const uniq = (arr) => Array.from(new Set(arr));

/* -------------------------------------------------------
   NORMALIZATION HELPERS (MATCH preview/save.js EXACTLY)
------------------------------------------------------- */

function normalizeShipKeyFromInvoice(inv) {
  if (!inv) return '';
  const line1  = String(inv.ship_to_line1  || '').trim().toLowerCase();
  const line2  = String(inv.ship_to_line2  || '').trim().toLowerCase();
  const city   = String(inv.ship_to_city   || '').trim().toLowerCase();
  const region = String(inv.ship_to_region || '').trim().toLowerCase();
  const postal = String(inv.ship_to_postal || '').trim().toLowerCase();
  const country= String(inv.ship_to_country || 'US').trim().toLowerCase();

  const base = [line1, line2, city, region, postal, country]
    .filter(Boolean)
    .join(', ');

  return base.replace(/\s+/g, ' ').trim();
}

function normalizeShipKeyFromShipTo(shipTo) {
  if (!shipTo) return '';
  const line1  = String(shipTo.line1  || '').trim().toLowerCase();
  const line2  = String(shipTo.line2  || '').trim().toLowerCase();
  const city   = String(shipTo.city   || '').trim().toLowerCase();
  const region = String(shipTo.region || '').trim().toLowerCase();
  const postal = String(shipTo.postal || '').trim().toLowerCase();
  const country= String(shipTo.country || 'US').trim().toLowerCase();

  const base = [line1, line2, city, region, postal, country]
    .filter(Boolean)
    .join(', ');

  return base.replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------
   HANDLER
------------------------------------------------------- */

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow','GET');
      return res.status(405).json({ error:'Method not allowed' });
    }

    const ok = await requireAdmin(req, res);
    if (!ok) return;

    /* --------------------------------------------
       Parse incoming subs list
    -------------------------------------------- */
    const raw = String(req.query.subs || '').trim();
    const subCodes = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!subCodes.length) {
      return res.status(200).json({ invoice_id: null, items: [] });
    }

    /* --------------------------------------------
       Parse optional incoming ship_to (JSON string)
       This ensures address-based reuse works
    -------------------------------------------- */
    let incomingShipTo = null;
    if (req.query.ship_to) {
      try {
        incomingShipTo = JSON.parse(req.query.ship_to);
      } catch (_) {}
    }
    const incomingShipKey = incomingShipTo
      ? normalizeShipKeyFromShipTo(incomingShipTo)
      : '';

    const client = sb();

    /* ----------------------------------------------------
       A) Try to REUSE existing invoice via submission links
    ---------------------------------------------------- */
    const { data: links, error: linkErr } = await client
      .from('billing_invoice_submissions')
      .select('invoice_id')
      .in('submission_code', subCodes);

    if (linkErr) {
      return res.status(500).json({ error: 'Failed to read invoice links', details: linkErr.message });
    }

    let invoice_id = null;

    if (links?.length) {
      const invIds = uniq(links.map(l => l.invoice_id));

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
        .in('id', invIds)
        .in('status', ['pending','draft'])
        .order('updated_at', { ascending: false });

      if (invErr) {
        return res.status(500).json({ error: 'Failed to read invoices', details: invErr.message });
      }

      let candidates = invs || [];

      // Match addresses strictly if caller included ship_to
      if (incomingShipKey) {
        candidates = candidates.filter(inv =>
          normalizeShipKeyFromInvoice(inv) === incomingShipKey
        );
      }

      if (candidates.length) {
        candidates.sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at));
        invoice_id = candidates[0].id;
      }
    }

    /* ----------------------------------------------------
       B) Fallback: reuse by shopify_customer_id + group_code
       BUT STILL must match address if incomingShipKey exists
    ---------------------------------------------------- */

    if (!invoice_id) {
      // Need customer id
      const { data: subs, error: subsErr } = await client
        .from('psa_submissions')
        .select('submission_id, shopify_customer_id')
        .in('submission_id', subCodes);

      if (subsErr) {
        return res.status(500).json({ error: 'Failed to fetch submissions', details: subsErr.message });
      }

      const shopIds = uniq((subs || []).map(s => s.shopify_customer_id).filter(Boolean));
      const shopify_customer_id = shopIds[0] || null;

      // Determine group_code from group_submissions
      let group_code = 'MULTI';

      const { data: gs, error: gsErr } = await client
        .from('group_submissions')
        .select('group_id, submission_id')
        .in('submission_id', subCodes);

      if (gsErr) {
        return res.status(500).json({ error: 'Failed to fetch group_submissions', details: gsErr.message });
      }

      if (gs?.length) {
        const groupIds = uniq(gs.map(g => g.group_id).filter(Boolean));
        if (groupIds.length) {
          const { data: grps, error: gErr } = await client
            .from('groups')
            .select('id, code')
            .in('id', groupIds);

          if (gErr) {
            return res.status(500).json({ error: 'Failed to fetch groups', details: gErr.message });
          }

          const codes = uniq((grps || []).map(g => g.code).filter(Boolean));
          if (codes.length === 1) group_code = codes[0];
        }
      }

      if (shopify_customer_id) {
        const { data: invs2, error: inv2Err } = await client
          .from('billing_invoices')
          .select(`
            id,
            updated_at,
            ship_to_line1,
            ship_to_line2,
            ship_to_city,
            ship_to_region,
            ship_to_postal,
            ship_to_country
          `)
          .eq('shopify_customer_id', shopify_customer_id)
          .eq('group_code', group_code)
          .in('status', ['pending','draft'])
          .order('updated_at', { ascending: false });

        if (inv2Err) {
          return res.status(500).json({ error: 'Failed to read open invoice by customer/group', details: inv2Err.message });
        }

        let candidates2 = invs2 || [];

        if (incomingShipKey) {
          candidates2 = candidates2.filter(inv =>
            normalizeShipKeyFromInvoice(inv) === incomingShipKey
          );
        }

        if (candidates2.length) {
          invoice_id = candidates2[0].id;
        }
      }
    }

    /* ----------------------------------------------------
       If still no invoice_id → return empty results
    ---------------------------------------------------- */
    if (!invoice_id) {
      return res.status(200).json({ invoice_id: null, items: [] });
    }

    /* ----------------------------------------------------
       C) Load saved upcharges for THIS invoice
    ---------------------------------------------------- */
    const { data: rows, error: vErr } = await client
      .from('billing_invoice_items')
      .select('submission_card_uuid, amount_cents')
      .eq('invoice_id', invoice_id)
      .eq('kind', 'upcharge');

    if (vErr) {
      return res.status(500).json({ error: 'Failed to read saved upcharges', details: vErr.message });
    }

    const items = (rows || []).map(r => ({
      card_id: r.submission_card_uuid,
      grading_cents: 0,
      upcharge_cents: Number(r.amount_cents) || 0
    }));

    return res.status(200).json({ invoice_id, items });

  } catch (err) {
    console.error('[preview/prefill] error', err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
