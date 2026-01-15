// /api/proxy/submission-detail.js (ESM)
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const { SHOPIFY_API_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// App Proxy signature check
function verifyProxyHmac(query = {}) {
  const { signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === signature;
}

// Fallback: derive a service string from card_info if the column is empty (older rows)
function deriveServiceFromCards(cardInfo) {
  const items = Array.isArray(cardInfo) ? cardInfo : [];
  const vals = [];
  for (const o of items) {
    const v =
      o?.psa_grading ||
      o?.grading_service ||
      o?.service_level ||
      o?.service ||
      o?.tier ||
      o?.level;
    if (v) vals.push(String(v).trim());
  }
  if (!vals.length) return null;
  const uniq = [...new Set(vals)];
  return uniq.length === 1 ? uniq[0] : `Mixed: ${uniq.slice(0,3).join(', ')}${uniq.length>3 ? '…' : ''}`;
}

export default async function handler(req, res) {
    const allowedOrigins = [
    'https://poshsports.com',
    'https://www.poshsports.com',
    'https://poshsports.myshopify.com'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');

    // simple health check
    if (req.query.ping) {
      return res.status(200).json({ ok: true, where: '/api/proxy/submission-detail', query: req.query });
    }

    const devBypass = process.env.NODE_ENV !== 'production' && req.query.dev_skip_sig === '1';
    if (!devBypass && !verifyProxyHmac(req.query)) {
      return res.status(403).json({ ok: false, error: 'invalid_signature' });
    }

    // Accept either your friendly submission_id or the row uuid id
    const sid = String(req.query.sid || req.query.id || req.query.submission_id || '').trim();
    if (!sid) return res.status(400).json({ ok: false, error: 'missing_id' });

    // must belong to the logged-in customer
    const customerIdRaw =
      req.query.logged_in_customer_id ||
      req.headers['x-shopify-customer-id'] ||
      req.headers['x-shopify-logged-in-customer-id'];
    const customerIdNum = Number(customerIdRaw);
    if (!Number.isFinite(customerIdNum)) {
      return res.status(401).json({ ok: false, error: 'not_logged_in' });
    }

    // fetch one record — include grading_service in the selection
    const base = supabase
      .from('psa_submissions')
      .select(`
        id,
        submission_id,
        created_at,
        submitted_at_iso,
        status,
        cards,
        evaluation,
        totals,
        address,
        card_info,
        paid_at_iso,
        paid_amount,
        shopify_customer_id,
        grading_service
      `)
      .eq('shopify_customer_id', customerIdNum)
      .limit(1);

    // Match by id or submission_id if sid looks like a UUID; else only submission_id
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sid);
    const q = isUuid
      ? base.or(`id.eq.${sid},submission_id.eq.${sid}`)
      : base.eq('submission_id', sid);

    const { data, error } = await q;

    if (error) {
      console.error('Supabase single query error:', error);
      return res.status(500).json({ ok: false, error: 'db_error' });
    }
    if (!data || !data.length) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const r = data[0];
    const display_id = r.submission_id || r.id;
    const created_at = r.submitted_at_iso || r.created_at;

    // Prefer column; fall back to deriving from card_info for legacy rows
    const service = r.grading_service || deriveServiceFromCards(r.card_info) || null;

    // --- Hybrid cards loader ---
    let cards = Array.isArray(r.card_info) ? r.card_info : [];

       try {
const { data: rows, error: rowsErr } = await supabase
  .from('submission_cards')
  .select(`
    break_date,
    break_channel,
    break_number,
    card_description,
    grading_service,
    service_price_cents,
    upcharge_cents
  `)
  .in('submission_id', [r.id, r.submission_id])   // <-- UUID FK, not psa-### code
  .order('card_index', { ascending: true });


      if (!rowsErr && rows && rows.length) {
        cards = rows.map(o => ({
          break_date: o.break_date,
          break_channel: o.break_channel,
          break_number: o.break_number,
          card_description: o.card_description,
          grading_service: o.grading_service || null,
          service_price_cents: o.service_price_cents || 0,
          upcharge_cents: o.upcharge_cents || 0
        }));
      }
    } catch (_) {
      // silent fallback to r.card_info
    }


    return res.status(200).json({
      ok: true,
      submission: {
        id: r.id,
        display_id,
        created_at,
        status: r.status || 'received',
        cards: r.cards ?? 0,
        evaluation: r.evaluation ?? 0,
        totals: r.totals || {},
        address: r.address || null,
        card_info: cards,
        paid_at_iso: r.paid_at_iso || null,
        paid_amount: r.paid_amount || null,
        grading_service: service
      }
    });

  } catch (e) {
    console.error('proxy/submission-detail error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
