// /api/shopify-orders-paid.js
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Variant ID for the evaluation product
const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || '51003437613332');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Set DEBUG_PSA_WEBHOOK=1 in Vercel to see these logs
const DEBUG = process.env.DEBUG_PSA_WEBHOOK === '1';
const dlog = (...a) => DEBUG && console.log('[PSA Webhook]', ...a);

export default async function handler(req, res) {
  console.log('[PSA Webhook] v2 live');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // --- 1) Read RAW body (needed for HMAC) ---
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);

  // --- 2) Verify HMAC ---
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

  // --- 4) Only handle orders that include the eval variant ---
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

  // --- 5) Extract our attributes (submission id + tiny payload) ---
  const noteAttrsArr = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const attrs = noteAttrsArr.reduce((acc, cur) => {
    const k = (cur?.name || '').toLowerCase();
    acc[k] = String(cur?.value ?? '');
    return acc;
  }, {});

  const submissionId = attrs['psa_submission_id'] || '';
  if (!submissionId) {
    console.warn('[PSA Webhook] Missing psa_submission_id on order', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, missing_submission_id: true });
  }

  // Optional: decode tiny payload (may include cards/email)
  let basePayload = null;
  if (attrs['psa_payload_b64']) {
    try {
      let decoded = Buffer.from(attrs['psa_payload_b64'], 'base64').toString('utf8');
      try { decoded = decodeURIComponent(decoded); } catch {}
      basePayload = JSON.parse(decoded);
    } catch (e) {
      console.warn('[PSA Webhook] Failed to decode psa_payload_b64:', e);
    }
  }

  // --- 6) Read existing row to preserve cards + maybe existing email ---
  let cardsToUse = 0;
  let existingEmail = null;
  try {
    const { data: existing } = await supabase
      .from('psa_submissions')
      .select('cards, customer_email')
      .eq('submission_id', submissionId)
      .single();

    if (existing) {
      const fromDbCards = Number(existing.cards);
      if (Number.isFinite(fromDbCards) && fromDbCards > 0) cardsToUse = fromDbCards;
      if (existing.customer_email) existingEmail = existing.customer_email;
    }
  } catch (e) {
    dlog('Could not read existing row; will fall back to payload/order', e?.message);
  }

  // Fall back for cards if we didn't get it from DB
  if (!cardsToUse) {
    const fromPayload = Number(basePayload?.cards);
    if (Number.isFinite(fromPayload) && fromPayload > 0) cardsToUse = fromPayload;
  }

  // --- 7) Resolve customer_email robustly (prevents NOT NULL error) ---
  const customer_email =
    order?.email ||
    order?.customer?.email ||
    order?.contact_email ||
    existingEmail ||
    basePayload?.customer_email ||
    null;

  // --- 8) Minimal Shopify snapshot (not bloated) ---
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

  // --- 9) Upsert to Supabase (conflict on submission_id) ---
  const update = {
    submission_id: submissionId,               // conflict key
    customer_email,                            // <-- REQUIRED (NOT NULL)
    status: 'submitted_paid',
    submitted_via: 'webhook_orders_paid',
    paid_at_iso: new Date().toISOString(),
    evaluation: Number.isFinite(evalQty) ? evalQty : 0,  // purchased eval count
    cards: cardsToUse,                                   // original card count
    shopify
  };

  const { error } = await supabase
    .from('psa_submissions')
    .upsert(update, { onConflict: 'submission_id' });

  if (error) {
    console.error('[PSA Webhook] Supabase upsert error:', error);
    return res.status(500).send('Submit failed');
  }

  console.log('[orders-paid] OK', {
    id: order?.id,
    email: order?.email,
    order: order?.name,
    submissionId,
    evalQty,
    cardsToUse
  });

  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
