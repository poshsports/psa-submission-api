// /api/shopify-orders-paid.js
export const config = { api: { bodyParser: false } };

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || '0');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEBUG = process.env.DEBUG_PSA_WEBHOOK === '1';
const dlog = (...a) => DEBUG && console.log('[PSA Webhook]', ...a);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // --- 1) Read RAW body (needed for HMAC) ---
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

  dlog('order', { id: order?.id, name: order?.name, email: order?.email });

  // --- 4) Does this order include the eval SKU? ---
  const hasEval = Array.isArray(order?.line_items) &&
    order.line_items.some(li => Number(li.variant_id) === EVAL_VARIANT_ID);

  if (!hasEval) {
    dlog('No eval line item; skipping.', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Compute evaluation quantity by variant id
  const evalQty = (order.line_items || []).reduce((acc, li) => {
    return acc + (Number(li.variant_id) === EVAL_VARIANT_ID ? Number(li.quantity || 0) : 0);
  }, 0);

  // --- 5) Extract note attributes (cart attributes) ---
  const noteAttrsArr = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const attrs = noteAttrsArr.reduce((acc, cur) => {
    const k = String(cur?.name || '').toLowerCase();
    acc[k] = String(cur?.value ?? '');
    return acc;
  }, {});
  const submissionId = attrs['psa_submission_id'] || '';

  if (!submissionId) {
    console.warn('[PSA Webhook] Missing psa_submission_id', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, missing_submission_id: true });
  }

  // Optional: decode small carry payload
  let basePayload = null;
  if (attrs['psa_payload_b64']) {
    try {
      let decoded = Buffer.from(attrs['psa_payload_b64'], 'base64').toString('utf8');
      try { decoded = decodeURIComponent(decoded); } catch {}
      basePayload = JSON.parse(decoded);
    } catch (e) {
      console.warn('[PSA Webhook] Failed to decode psa_payload_b64:', e?.message);
    }
  }

  // --- 6) Read existing row to preserve cards + customer_email ---
  let cardsToUse = 0;
  let existingEmail = null;

  try {
    const { data: existing } = await supabase
      .from('psa_submissions')
      .select('cards, customer_email')
      .eq('submission_id', submissionId)
      .single();

    cardsToUse = Number(existing?.cards) > 0
      ? Number(existing.cards)
      : (Number(basePayload?.cards) > 0 ? Number(basePayload.cards) : 0);

    existingEmail = existing?.customer_email || null;
  } catch (e) {
    dlog('No existing row; will fall back to payload/email', e?.message);
    cardsToUse = Number(basePayload?.cards) > 0 ? Number(basePayload.cards) : 0;
  }

  // 🔑 always provide a non-null customer_email (table requires NOT NULL)
  const customerEmail =
    existingEmail ||
    (basePayload?.customer_email ? String(basePayload.customer_email) : null) ||
    (order?.email ? String(order.email) : null);

  if (!customerEmail) {
    // If this ever happens (POS order without email), you can default to a placeholder
    // but let's log loudly so we know.
    console.warn('[PSA Webhook] Missing customerEmail; will still try with placeholder');
  }

  // --- 7) Minimal Shopify snapshot ---
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

  // --- 8) Upsert (update if exists, else insert with required fields) ---
  const update = {
    submission_id: submissionId,
    status: 'submitted_paid',
    submitted_via: 'webhook_orders_paid',
    paid_at_iso: new Date().toISOString(),
    evaluation: Number.isFinite(evalQty) ? evalQty : 0,
    cards: Number.isFinite(cardsToUse) ? cardsToUse : 0,
    customer_email: customerEmail || 'unknown@no-email.local', // safety
    shopify
  };

  dlog('upsert update', {
    submission_id: update.submission_id,
    cards: update.cards,
    evaluation: update.evaluation,
    customer_email: update.customer_email
  });

  const { error } = await supabase
    .from('psa_submissions')
    .upsert(update, { onConflict: 'submission_id' });

  if (error) {
    console.error('[PSA Webhook] Supabase upsert error:', error);
    return res.status(500).send('Submit failed');
  }

  console.log('[orders-paid] OK', {
    submissionId,
    order: order?.name,
    evalQty,
    cardsToUse,
    email: customerEmail
  });

  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
