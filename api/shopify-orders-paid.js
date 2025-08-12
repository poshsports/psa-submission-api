// /api/shopify-orders-paid.js
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Prefer configuring this in Vercel as SHOPIFY_EVAL_VARIANT_ID
const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || '51003437613332');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// flip to '1' temporarily if you want extra logs
const DEBUG = process.env.DEBUG_PSA_WEBHOOK === '1';
const dlog = (...a) => DEBUG && console.log('[PSA Webhook]', ...a);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // --- 1) Read RAW body (must be raw for HMAC) ---
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

  // --- 4) Does this order include the eval SKU? ---
  const hasEval = Array.isArray(order?.line_items) &&
    order.line_items.some(li =>
      (EVAL_VARIANT_ID && Number(li.variant_id) === EVAL_VARIANT_ID) ||
      String(li.title || '').toLowerCase().includes('evaluation')
    );

  if (!hasEval) {
    dlog('Order has no eval line item; skipping.', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Also compute evaluation quantity (how many evals purchased)
  const evalQty = (order.line_items || []).reduce((acc, li) => {
    const byVariant = EVAL_VARIANT_ID && Number(li.variant_id) === EVAL_VARIANT_ID;
    const byTitle = (li.title || '').toLowerCase().includes('evaluation');
    return acc + (byVariant || byTitle ? Number(li.quantity || 0) : 0);
  }, 0);

  // --- 5) Read note attributes and extract our ids/payload ---
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

  // Optional: decode small payload if present (may contain cards)
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

  // --- 6) Preserve the original cards count ---
  let cardsToUse = 0;
  try {
    const { data: existing } = await supabase
      .from('psa_submissions')
      .select('cards')
      .eq('submission_id', submissionId)
      .single();

    const fromDb = Number(existing?.cards);
    const fromPayload = Number(basePayload?.cards);
    cardsToUse = Number.isFinite(fromDb) && fromDb > 0
      ? fromDb
      : (Number.isFinite(fromPayload) && fromPayload > 0 ? fromPayload : 0);
  } catch (e) {
    console.warn('[PSA Webhook] Could not read existing cards, falling back to payload', e?.message);
    const fromPayload = Number(basePayload?.cards);
    cardsToUse = Number.isFinite(fromPayload) && fromPayload > 0 ? fromPayload : 0;
  }

  // --- 7) Minimal Shopify snapshot (no bloat) ---
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

  // --- 8) Upsert the minimal set of fields directly to Supabase ---
  const update = {
    submission_id: submissionId,           // key
    status: 'submitted_paid',
    submitted_via: 'webhook_orders_paid',
    paid_at_iso: new Date().toISOString(),
    evaluation: evalQty,                   // how many evals were purchased
    cards: cardsToUse,                     // preserve original card count
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
