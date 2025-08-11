// /api/shopify-orders-paid.js
const crypto = require('crypto');

const EVAL_VARIANT_ID = '51003437613332';               // your eval variant
const SUPABASE_ENDPOINT = process.env.SUPABASE_SUBMIT_URL
  || 'https://psa-submission-api.vercel.app/api/submit'; // reuse your existing submit endpoint
const DEBUG = process.env.DEBUG_PSA_WEBHOOK === '1';

function log(...a){ if (DEBUG) console.log('[PSA Webhook]', ...a); }

function readRawBody(req){
  return new Promise((resolve, reject)=>{
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyHmac(raw, header, secret){
  if (!header || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(digest, 'utf8'));
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    console.error('Failed to read raw body', e);
    return res.status(400).send('Bad Request');
  }

  if (!verifyHmac(raw, hmacHeader, secret)) {
    console.warn('HMAC verification failed');
    return res.status(401).send('Unauthorized');
  }

  let order;
  try { order = JSON.parse(raw); }
  catch { return res.status(400).send('Invalid JSON'); }

  const hasEvalLine = Array.isArray(order.line_items) &&
    order.line_items.some(li => String(li.variant_id) === EVAL_VARIANT_ID);

  if (!hasEvalLine) {
    log('Order has no eval line item; ignoring.');
    return res.status(200).json({ ok: true, skipped: true });
  }

  const noteAttrs = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const attrs = noteAttrs.reduce((acc, cur) => {
    acc[(cur.name || '').toLowerCase()] = String(cur.value || '');
    return acc;
  }, {});

  let basePayload = null;
  if (attrs['psa_payload_b64']) {
    try {
      const json = decodeURIComponent(escape(Buffer.from(attrs['psa_payload_b64'], 'base64').toString('utf8')));
      basePayload = JSON.parse(json);
    } catch (e) {
      console.warn('Failed to decode psa_payload_b64:', e);
    }
  }

  if (!basePayload) {
    basePayload = {
      customer_email: order.email || '',
      cards: 0,
      evaluation: true,
      status: 'pending_payment_fallback',
      card_info: [],
    };
  }

  const finalPayload = {
    ...basePayload,
    status: 'paid',
    submitted_via: 'webhook_orders_paid',
    submitted_at_iso: new Date().toISOString(),
    shopify: {
      id: order.id,
      name: order.name,
      order_number: order.order_number,
      email: order.email,
      currency: order.currency,
      total_price: order.total_price,
      created_at: order.created_at,
      note_attributes: noteAttrs,
      line_items: order.line_items,
    },
  };

  try {
    const resp = await fetch(SUPABASE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalPayload),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('Submit endpoint returned', resp.status, txt);
      return res.status(500).send('Submit failed');
    }
  } catch (e) {
    console.error('Submit request error', e);
    return res.status(500).send('Submit error');
  }

  log('Submission stored for order', order.name);
  return res.status(200).json({ ok: true });
};
