// /api/admin/submission.js  (ESM)
// Returns one submission (by submission_id or id) with group fields for the admin drawer.
// When ?full=1 (or true) it also enriches with shipping info AND returns card_info.

import { sb } from '../_util/supabase.js';

// --- helpers ---------------------------------------------------------------
async function safeSelect(promise) {
  try { return await promise; } catch { return { data: null, error: null }; }
}
const isUuid = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ''));

const pick = (...vals) => {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) return v; // JSON addr
  }
  return null;
};

const parseJson = (v) => {
  if (!v) return null;
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
  try { return JSON.parse(String(v)); } catch { return null; }
};

// Build an address object from flat columns if present
function flatToAddress(src) {
  if (!src || typeof src !== 'object') return null;

  const name =
    src.ship_name || src.shipping_name || src.recipient || src.full_name || null;

  const address1 =
    src.ship_addr1 || src.shipping_addr1 || src.address1 || src.line1 || src.street1 || src.street || null;

  const address2 =
    src.ship_addr2 || src.shipping_addr2 || src.address2 || src.line2 || src.street2 || src.unit || src.apt || src.apartment || src.suite || null;

  const city =
    src.ship_city || src.shipping_city || src.city || src.town || src.locality || null;

  const state =
    src.ship_state || src.shipping_state || src.state || src.region || src.province || src.state_code || src.province_code || null;

  const postal_code =
    src.ship_zip || src.shipping_zip || src.postal || src.postal_code || src.postalCode || src.zip || null;

  const country =
    src.ship_country || src.shipping_country || src.country || src.country_code || src.countryCode || null;

  if (name || address1 || address2 || city || state || postal_code || country) {
    return { name, address1, address2, city, state, postal_code, country };
  }
  return null;
}

// Normalize card rows coming from a `cards` table into what the UI expects
function normalizeCardRow(r = {}) {
  const date =
    r.date || r.date_of_break || r.break_date ||
    (r.created_at ? new Date(r.created_at).toISOString().slice(0,10) : '');

  const channel = r.channel || r.break_channel || '';
  const break_no = r.break_no || r.break_number || r.break || '';
  const description = r.description || r.card_description || r.title || r.card || '';

  // keep any grading_service if present
  const grading_service = r.grading_service || '';

  return { date, channel, break_no, break_number: break_no, description, card_description: description, grading_service };
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // cookie gate (set by /api/admin-login)
  const cookie = req.headers.cookie || '';
  const authed = cookie.split(';').some(v => v.trim().startsWith('psa_admin=1'));
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const supabase = sb();

    // Support both ?id= (uuid or psa-###) and ?submission_id=
    const url = new URL(req.url, `http://${req.headers.host}`);
    const idParam = (url.searchParams.get('id') || url.searchParams.get('submission_id') || '').trim();
    const fullParam = String(url.searchParams.get('full') || '').toLowerCase();
    const wantFull = fullParam === '1' || fullParam === 'true';

    if (!idParam) return res.status(400).json({ ok: false, error: 'missing_id' });

    // 1) Base row from the admin VIEW (includes group fields)
    const selectCols = `
      id,
      submission_id,
      created_at,
      customer_email,
      cards,
      evaluation,
      totals,
      status,
      grading_service,
      submitted_at_iso,
      paid_at_iso,
      paid_amount,
      shopify_order_name,
      shop_domain,
      last_updated_at,
      group_id,
      group_code
    `;

    let q = supabase.from('admin_submissions_v').select(selectCols).limit(1);
    q = isUuid(idParam)
      ? q.or(`id.eq.${idParam},submission_id.eq.${idParam}`)
      : q.eq('submission_id', idParam);

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: 'db_error', detail: error.message });
    if (!data || !data.length) return res.status(404).json({ ok: false, error: 'not_found' });

    const item = { ...data[0] };

    // 2) Enrich with shipping + cards when requested
    if (wantFull) {
      // 2a) Pull the full submissions row so we don't miss any flat columns (and card_info/raw)
      let subRow = null;
      {
        let sq = supabase.from('submissions').select('*').limit(1);
        sq = isUuid(idParam)
          ? sq.or(`id.eq.${idParam},submission_id.eq.${idParam}`)
          : sq.eq('submission_id', idParam);
        const { data: sData } = await sq;
        subRow = sData?.[0] || null;
      }

      // 2b) Compute an "effective" shipping from known fields
      let effective = pick(
        subRow?.ship_to,
        subRow?.shipping_address,
        subRow?.shopify_shipping_address,
        subRow?.ship_address,
        subRow?.address,
        subRow?.meta?.ship_to,
        subRow?.meta?.shipping_address
      );

      if (!effective) effective = flatToAddress(subRow);

      if (!effective && (subRow?.id || item.shopify_order_name)) {
        // orders table
        const { data: ord } = await safeSelect(
          supabase
            .from('orders')
            .select('*')
            .or(
              [
                subRow?.id ? `submission_id.eq.${subRow.id}` : null,
                item.shopify_order_name ? `shopify_order_name.eq.${item.shopify_order_name}` : null,
              ].filter(Boolean).join(',')
            )
            .limit(1)
        );
        const o = ord?.[0];
        effective = pick(effective, o?.ship_to, o?.shipping_address, o?.address, flatToAddress(o));
      }

      if (!effective && item.customer_email) {
        const { data: cust } = await safeSelect(
          supabase
            .from('customers')
            .select('*')
            .eq('email', item.customer_email)
            .limit(1)
        );
        const c = cust?.[0];
        effective = pick(effective, c?.shipping_address, c?.default_address, flatToAddress(c));
      }

      if (!effective && subRow?.id) {
        const { data: sa } = await safeSelect(
          supabase
            .from('submissions_addresses')
            .select('address')
            .eq('submission_id', subRow.id)
            .limit(1)
        );
        effective = pick(effective, sa?.[0]?.address);
      }

      if (effective) {
        if (typeof effective === 'string') item.ship_to = effective;
        else item.shipping_address = effective;
      }

      // 2c) ----- Cards: prefer card_info on submissions; else from raw; else cards table -----
      let cardsOut = [];

      // (i) direct column on submissions
      const directCardInfo = parseJson(subRow?.card_info);
      if (Array.isArray(directCardInfo) && directCardInfo.length) {
        cardsOut = directCardInfo;
      }

      // (ii) try raw JSON blob (common in your dataset)
      if (!cardsOut.length && subRow?.raw) {
        const raw = parseJson(subRow.raw);
        const rawCards = parseJson(raw?.card_info);
        if (Array.isArray(rawCards) && rawCards.length) {
          cardsOut = rawCards;
        }
      }

      // (iii) as a fallback, query a `cards` table if present
      if (!cardsOut.length && subRow?.id) {
        const { data: cardRows } = await safeSelect(
          supabase
            .from('cards')
            .select('created_at, date, date_of_break, break_date, channel, break_channel, break_number, break_no, description, card_description, title, grading_service, submission_id')
            .eq('submission_id', subRow.id)
            .order('created_at', { ascending: true })
        );
        if (Array.isArray(cardRows) && cardRows.length) {
          cardsOut = cardRows.map(normalizeCardRow);
        }
      }

      // surface in a name the UI already reads
      if (cardsOut.length) {
        item.card_info = cardsOut;
      }
    }

    return res.status(200).json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server_error', detail: String(e) });
  }
}
