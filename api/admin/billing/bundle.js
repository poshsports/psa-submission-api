// /api/admin/billing/bundle.js
import { sb } from '../../../_util/supabase.js';
import { requireAdmin } from '../../../_util/adminAuth.js';

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

// Normalize address JSON → ship_to object
function normalizeShipToFromAddress(addr) {
  if (!addr) return null;

  let raw = addr;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;

  const name   = String(raw.name   || raw.full_name || raw.contact || '').trim();
  const line1  = String(raw.street || raw.line1 || raw.address1 || '').trim();
  const line2  = String(raw.address2 || raw.line2 || '').trim();
  const city   = String(raw.city   || '').trim();
  const region = String(raw.state  || raw.region || '').trim();
  const postal = String(raw.zip    || raw.postal || '').trim();
  const country= String(raw.country || 'US').trim();

  if (!line1 && !city && !postal) return null;

  return { name, line1, line2, city, region, postal, country };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (!requireAdmin(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    const subsRaw = String(req.query.subs || '').trim();
    if (!subsRaw) {
      return json(res, 400, { error: 'Missing subs query param' });
    }

    const submissionCodes = subsRaw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!submissionCodes.length) {
      return json(res, 400, { error: 'No valid submission codes' });
    }

    const client = sb();

    /* -----------------------------------------
       1) Load submissions (email + address)
       ----------------------------------------- */

    // ⚠️ If your column names differ, tweak the select() list.
    const { data: subs, error: subsErr } = await client
      .from('psa_submissions')
      .select('submission_id, customer_email, address, shopify_customer_id')
      .in('submission_id', submissionCodes);

    if (subsErr) {
      console.error('[bundle] subsErr:', subsErr);
      return json(res, 500, { error: 'Failed to load submissions' });
    }

    if (!subs || !subs.length) {
      // Nothing found — return a safe empty bundle
      return json(res, 200, {
        customer_email: null,
        submission_ids: submissionCodes,
        groups: [],
        ship_to: null,
        invoice_id: null,
        shopify_customer_id: null
      });
    }

    const primary = subs[0];
    const email = String(primary.customer_email || '').trim().toLowerCase();
    const ship_to = normalizeShipToFromAddress(primary.address);
    const shopify_customer_id = primary.shopify_customer_id || null;

    /* -----------------------------------------
       2) Load groups for these submissions
       ----------------------------------------- */

    let groups = [];
    try {
      // ⚠️ Adjust column names if needed:
      //  - if your linking column is `submission_code` instead of `submission_id`,
      //    change .select(...) and .in(...) accordingly.
      const { data: gRows, error: gErr } = await client
        .from('group_submissions')
        .select('submission_id, groups(code)')
        .in('submission_id', submissionCodes);

      if (!gErr && Array.isArray(gRows)) {
        const set = new Set();
        for (const row of gRows) {
          const code =
            row.groups?.code || // if using a foreign key join
            row.group_code ||   // if you stored the code directly
            null;
          if (code) set.add(code);
        }
        groups = [...set];
      } else if (gErr) {
        console.warn('[bundle] group_submissions error:', gErr);
      }
    } catch (err) {
      console.warn('[bundle] groups lookup failed:', err);
    }

    /* -----------------------------------------
       3) Try to find an existing invoice_id
       ----------------------------------------- */

    let invoice_id = null;
    try {
      const { data: links, error: linkErr } = await client
        .from('billing_invoice_submissions')
        .select('invoice_id')
        .in('submission_code', submissionCodes)
        .order('created_at', { ascending: false })
        .limit(1);

      if (!linkErr && links && links.length) {
        invoice_id = links[0].invoice_id;
      } else if (linkErr) {
        console.warn('[bundle] invoice link error:', linkErr);
      }
    } catch (err) {
      console.warn('[bundle] invoice_id lookup failed:', err);
    }

    /* -----------------------------------------
       4) Return canonical bundle
       ----------------------------------------- */

    return json(res, 200, {
      customer_email: email || null,
      submission_ids: submissionCodes,
      groups,
      ship_to,
      invoice_id: invoice_id || null,
      shopify_customer_id
    });

  } catch (err) {
    console.error('[bundle] fatal error:', err);
    return json(res, 500, { error: err?.message || String(err) });
  }
}
