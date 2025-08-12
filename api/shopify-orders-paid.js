// /api/shopify-orders-paid.js
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || '51003437613332');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// flip to '1' if you want extra logs
const DEBUG = process.env.DEBUG_PSA_WEBHOOK === '1';
const dlog = (...a) => DEBUG && console.log('[PSA Webhook]', ...a);

// helpers
function getAttr(order, key) {
  const arr = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const found = arr.find(a => (a.name || a.key) === key);
  return found ? String(found.value ?? '') : '';
}
function decodeB64ToJson(s) {
  try {
    if (!s) return null;
    let dec = Buffer.from(s, 'base64').toString('utf8');
    try { dec = decodeURIComponent(dec); } catch {}
    return JSON.parse(dec);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // --- 1) Read RAW body (must be raw for HMAC) ---
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const rawBody = Buffer.concat(chunks);

  // --- 2) HMAC verify ---
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[PSA Webhook] Missing SHOPIFY_WEBHOOK_SECRET');
    return res.status(500).send('Missing webhook secret');
  }
  const sentHmac = req.headers['x-shopify-hmac-sha256'];
  if (!sentHmac) return res.status(401).send('Missing HMAC');

  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sentHmac));
    if (!ok) return res.status(401).send('HMAC verification failed');
  } catch {
    return res.status(401).send('HMAC verification failed');
  }

  // --- 3) Parse JSON only after verification ---
  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  // --- 4) Does this order include the eval SKU? (ID ONLY) ---
  const hasEval = Array.isArray(order?.line_items) &&
    order.line_items.some(li => Number(li.variant_id) === EVAL_VARIANT_ID);

  if (!hasEval) {
    dlog('Order has no eval line item; skipping.', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Compute evaluation quantity strictly by variant id
  const evalQty = (order.line_items || []).reduce((acc, li) => {
    return acc + (Number(li.variant_id) === EVAL_VARIANT_ID ? Number(li.quantity || 0) : 0);
  }, 0);

  // --- 5) Note attributes ---
  const submissionId = getAttr(order, 'psa_submission_id');
  if (!submissionId) {
    console.warn('[PSA Webhook] Missing psa_submission_id on order', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, missing_submission_id: true });
  }
  const smallPayload = decodeB64ToJson(getAttr(order, 'psa_payload_b64')) || {};

  // --- 6) Load existing pre-checkout row (source of truth) ---
  const { data: existing, error: fetchErr } = await supabase
    .from('psa_submissions')
    .select('*')
    .eq('submission_id', submissionId)
    .maybeSingle();

  if (fetchErr) {
    console.warn('[PSA Webhook] Could not fetch existing row:', fetchErr.message);
  }

  // Preserve original cards
  const cardsToUse = Number.isFinite(existing?.cards) && existing.cards > 0
    ? Number(existing.cards)
    : (Number.isFinite(smallPayload?.cards) && smallPayload.cards > 0 ? Number(smallPayload.cards) : 0);

  // MUST have a customer_email (DB NOT NULL)
  const customer_email =
    existing?.customer_email ||
    smallPayload?.customer_email ||
    order?.email ||
    order?.customer?.email ||
    order?.contact_email ||
    null;

  if (!customer_email) {
    console.warn('[PSA Webhook] Missing customer_email even after fallbacks', {
      order: order?.name, id: order?.id, submissionId
    });
    // ACK so Shopify stops retrying; we can reprocess manually if needed
    return res.status(200).send('missing email');
  }

  // Map shipping address if we need to fill gaps
  const ship = order?.shipping_address || {};
  const addrFromOrder = ship?.address1 ? {
    street: ship.address1 + (ship.address2 ? ` ${ship.address2}` : ''),
    city:   ship.city || '',
    state:  ship.province_code || ship.province || '',
    zip:    ship.zip || '',
  } : null;

  // Minimal Shopify snapshot (no bloat)
  const shopify = {
    id: order?.id,
    name: order?.name,
    order_number: order?.order_number,
    email: order?.email,
    currency: order?.currency,
    total_price: order?.total_price,
    created_at: order?.created_at,
    line_items: (order.line_items || []).map(li => ({
      id: li.id,
      variant_id: li.variant_id,
      title: li.title,
      quantity: li.quantity,
      price: li.price
    }))
  };

  // --- 7) Build update doc (don’t null-out good data) ---
  const updateDoc = {
    customer_email,
    status: 'submitted',                           // unify with non-eval flow
    submitted_via: 'webhook_orders_paid',
    submitted_at_iso: new Date().toISOString(),
    paid_at_iso: order?.processed_at || new Date().toISOString(),
    evaluation: Number(evalQty) || 0,
    cards: cardsToUse,
    shopify,
    ...(existing?.totals ? { totals: existing.totals } :
       smallPayload?.totals ? { totals: smallPayload.totals } : {}),
    ...(existing?.card_info ? { card_info: existing.card_info } :
       smallPayload?.card_info ? { card_info: smallPayload.card_info } : {}),
    ...(existing?.address ? { address: existing.address } :
       addrFromOrder ? { address: addrFromOrder } : {})
  };

  // --- 8) Prefer UPDATE by submission_id (idempotent) ---
  const { data: upd, error: updErr } = await supabase
    .from('psa_submissions')
    .update(updateDoc)
    .eq('submission_id', submissionId)
    .select('id')
    .maybeSingle();

  if (updErr) {
    console.error('[PSA Webhook] Update error:', updErr);
    // ACK to stop retries; you’ll see this in logs
    return res.status(200).send('update err (ack)');
  }

  // If no row existed (rare), INSERT with required fields
  if (!upd) {
    const insertDoc = { ...updateDoc, submission_id: submissionId };
    const { error: insErr } = await supabase
      .from('psa_submissions')
      .insert([insertDoc]);

    if (insErr) {
      console.error('[PSA Webhook] Insert error:', insErr);
      return res.status(200).send('insert err (ack)');
    }
  }

  console.log('[orders-paid] OK', {
    id: order?.id,
    email: customer_email,
    order: order?.name,
    submissionId,
    evalQty,
    cardsToUse
  });

  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
