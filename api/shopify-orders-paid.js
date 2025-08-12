// /api/shopify-orders-paid.js
export const config = { api: { bodyParser: false } };

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Make sure this is set in Vercel to your eval product's *variant* id
const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || '0');

const nowIso = () => new Date().toISOString();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // --- RAW body (for HMAC) ---
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const rawBody = Buffer.concat(chunks);

  // --- HMAC verify ---
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const sentHmac = req.headers['x-shopify-hmac-sha256'];
  if (!secret || !sentHmac) return res.status(401).send('Missing webhook secret/HMAC');

  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sentHmac));
    if (!ok) return res.status(401).send('HMAC verification failed');
  } catch {
    return res.status(401).send('HMAC verification failed');
  }

  // --- Parse JSON ---
  let order;
  try { order = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).send('Invalid JSON'); }

  // Must include eval variant
  const hasEval = Array.isArray(order?.line_items) &&
    order.line_items.some(li => Number(li.variant_id) === EVAL_VARIANT_ID);

  if (!hasEval) {
    console.log('[orders-paid] Skip — no eval variant', { order: order?.name, id: order?.id });
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Eval quantity
  const evalQty = (order.line_items || []).reduce(
    (acc, li) => acc + (Number(li.variant_id) === EVAL_VARIANT_ID ? Number(li.quantity || 0) : 0),
    0
  );

  // Cart attributes -> order note_attributes
  const attrs = (Array.isArray(order?.note_attributes) ? order.note_attributes : [])
    .reduce((acc, cur) => {
      acc[String(cur?.name || '').toLowerCase()] = String(cur?.value ?? '');
      return acc;
    }, {});

  const submissionId = attrs['psa_submission_id'] || '';
  let basePayload = null;
  if (attrs['psa_payload_b64']) {
    try {
      let decoded = Buffer.from(attrs['psa_payload_b64'], 'base64').toString('utf8');
      try { decoded = decodeURIComponent(decoded); } catch {}
      basePayload = JSON.parse(decoded);
    } catch (e) {
      console.warn('[PSA Webhook] payload_b64 decode failed:', e?.message);
    }
  }

  // Log the essentials right away
  console.log('[orders-paid] incoming', {
    order: order?.name,
    order_id: order?.id,
    submissionId,
    shopify_email: order?.email,
    evalQty,
    attrs_present: Object.keys(attrs)
  });

  if (!submissionId) {
    console.warn('[PSA Webhook] Missing psa_submission_id on order', { order: order?.name });
    return res.status(200).json({ ok: true, missing_submission_id: true });
  }

  // Try to read existing pre-checkout row
  let existing = null;
  try {
    const { data } = await supabase
      .from('psa_submissions')
      .select('id, submission_id, cards, customer_email')
      .eq('submission_id', submissionId)
      .maybeSingle();
    existing = data || null;
  } catch (e) {
    console.warn('[PSA Webhook] select existing failed:', e?.message);
  }

  // Decide source of cards + email
  const cardsFromExisting = Number(existing?.cards) || 0;
  const cardsFromPayload = Number(basePayload?.cards) || 0;
  const cardsToUse = cardsFromExisting > 0 ? cardsFromExisting : cardsFromPayload;

  const emailFromExisting = existing?.customer_email || null;
  const emailFromPayload  = basePayload?.customer_email ? String(basePayload.customer_email) : null;
  const emailFromShopify  = order?.email ? String(order.email) : null;

  const customerEmail = emailFromExisting || emailFromPayload || emailFromShopify || 'unknown@no-email.local';

  // Compact Shopify snapshot
  const shopify = {
    id: order?.id,
    name: order?.name,
    order_number: order?.order_number,
    email: order?.email || null,
    currency: order?.currency || null,
    total_price: order?.total_price || null,
    created_at: order?.created_at || null,
    line_items: (order.line_items || []).map(li => ({
      id: li.id, variant_id: li.variant_id, title: li.title, quantity: li.quantity, price: li.price
    }))
  };

  // If row exists -> UPDATE; else -> INSERT with required columns
  try {
    if (existing) {
      const patch = {
        status: 'submitted_paid',
        submitted_via: 'webhook_orders_paid',
        paid_at_iso: nowIso(),
        evaluation: Number.isFinite(evalQty) ? evalQty : 0,
        cards: Number.isFinite(cardsToUse) ? cardsToUse : 0,
        customer_email: customerEmail,
        shopify
      };

      console.log('[orders-paid] UPDATE', { submissionId, patch });

      const { error } = await supabase
        .from('psa_submissions')
        .update(patch)
        .eq('submission_id', submissionId);

      if (error) throw error;
    } else {
      const insert = {
        submission_id: submissionId,
        status: 'submitted_paid',
        submitted_via: 'webhook_orders_paid',
        submitted_at_iso: nowIso(),
        paid_at_iso: nowIso(),
        evaluation: Number.isFinite(evalQty) ? evalQty : 0,
        cards: Number.isFinite(cardsToUse) ? cardsToUse : 0,
        customer_email: customerEmail,
        shopify
      };

      console.log('[orders-paid] INSERT', { insert });

      const { error } = await supabase
        .from('psa_submissions')
        .insert(insert);

      if (error) throw error;
    }
  } catch (error) {
    console.error('[PSA Webhook] Supabase write error:', error);
    return res.status(500).send('Supabase write failed');
  }

  console.log('[orders-paid] OK', {
    submissionId,
    evalQty,
    cardsToUse,
    email_used: customerEmail
  });

  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
