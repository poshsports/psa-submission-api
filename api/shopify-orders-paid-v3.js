// v3.5 — accelerated-checkout fallback + optional paid_amount + optional eval_line_subtotal
//        + optional Shopify order keys + optional idempotency guard
// - Fallback: read psa_submission_id / psa_payload_b64 from line_items[].properties when note_attributes are missing.
// - Optional: SAVE_PSA_PAID_AMOUNT=1 -> write paid_amount (whole order total).
// - Optional: SAVE_PSA_EVAL_SUBTOTAL=1 -> write eval_line_subtotal (eval SKU subtotal after discounts).
// - Optional: SAVE_PSA_ORDER_KEYS=1 -> write shopify_order_id, shopify_order_number, shopify_order_name, shop_domain.
// - Optional: ENABLE_PSA_IDEMPOTENCY=1 -> skip duplicate orders/paid for same submission already marked submitted_paid.
// - Keeps v3.1 behavior: raw HMAC, early eval-SKU gate, preserve cards, update→insert, same table/columns.

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } }; // needed for raw HMAC body on Next/Vercel

const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || "0");
const SAVE_PSA_PAID_AMOUNT = process.env.SAVE_PSA_PAID_AMOUNT === "1";
const SAVE_PSA_EVAL_SUBTOTAL = process.env.SAVE_PSA_EVAL_SUBTOTAL === "1";
const SAVE_PSA_ORDER_KEYS = process.env.SAVE_PSA_ORDER_KEYS === "1";
const ENABLE_PSA_IDEMPOTENCY = process.env.ENABLE_PSA_IDEMPOTENCY === "1";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// set ENV DEBUG_PSA_WEBHOOK=1 to see these logs
const DEBUG = process.env.DEBUG_PSA_WEBHOOK === "1";
const dlog = (...a) => DEBUG && console.log("[PSA v3]", ...a);

// Normalize line item properties: Shopify can send array [{name,value}] or object map
function propsToMap(props) {
  const out = {};
  if (!props) return out;
  if (Array.isArray(props)) {
    for (const p of props) {
      if (!p) continue;
      const key = String(p?.name || p?.key || "").toLowerCase().trim();
      if (!key) continue;
      out[key] = String(p?.value ?? "");
    }
  } else if (typeof props === "object") {
    for (const [k, v] of Object.entries(props)) {
      out[String(k).toLowerCase()] = String(v ?? "");
    }
  }
  return out;
}

// Extract a best-effort paid amount from order totals (entire order)
function extractPaidAmount(order) {
  const candidates = [
    order?.total_price,
    order?.current_total_price,
    order?.total_price_set?.shop_money?.amount,
    order?.current_total_price_set?.shop_money?.amount,
    order?.total_price_set?.presentment_money?.amount
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Compute subtotal for the evaluation line(s) after discounts (price*qty minus discounts).
// This is item-level only (no tax/shipping); sums all eval variant occurrences.
function computeEvalLineSubtotal(lineItems, evalVariantId) {
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const sumDiscountAllocations = (li) => {
    if (!Array.isArray(li?.discount_allocations)) return 0;
    let s = 0;
    for (const da of li.discount_allocations) {
      s += toNum(da?.amount)
        || toNum(da?.amount_set?.shop_money?.amount)
        || toNum(da?.amount_set?.presentment_money?.amount);
    }
    return s;
  };

  let total = 0;

  for (const li of Array.isArray(lineItems) ? lineItems : []) {
    if (Number(li?.variant_id) !== evalVariantId) continue;

    const qty = toNum(li?.quantity || 0);

    // Prefer discounted unit price if present
    const discountedUnit =
      toNum(li?.discounted_price) ||
      toNum(li?.discounted_price_set?.shop_money?.amount) ||
      0;

    if (discountedUnit > 0) {
      total += discountedUnit * qty;
      continue;
    }

    // Fallback: use regular unit price minus total discounts
    const unit =
      toNum(li?.price) ||
      toNum(li?.price_set?.shop_money?.amount) ||
      0;

    const gross = unit * qty;

    // total_discount fields; fallback to allocations sum
    const totalDiscount =
      toNum(li?.total_discount) ||
      toNum(li?.total_discount_set?.shop_money?.amount) ||
      sumDiscountAllocations(li);

    const net = Math.max(0, gross - totalDiscount);
    total += net;
  }

  // Round to cents to avoid floating noise
  return Math.round(total * 100) / 100;
}

export default async function handler(req, res) {
  console.log("[PSA VERSION] v3.5 handler start");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  // --- 1) raw body for HMAC
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);

  // --- 2) HMAC verify
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[PSA v3] Missing SHOPIFY_WEBHOOK_SECRET");
    return res.status(500).send("Missing webhook secret");
  }
  const sentHmac = req.headers["x-shopify-hmac-sha256"];
  if (!sentHmac) return res.status(401).send("Missing HMAC");

  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sentHmac));
    if (!ok) return res.status(401).send("HMAC verification failed");
  } catch {
    return res.status(401).send("HMAC verification failed");
  }

  // --- 3) parse JSON
  let order;
  try {
    order = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }
  dlog("received", { id: order?.id, name: order?.name });

  // Precompute keys we may use (even if we don't persist them)
  const shopDomain = String(req.headers["x-shopify-shop-domain"] || "");
  const orderIdStr = order?.id != null ? String(order.id) : null; // keep as string to avoid JS safe-int issues
  const orderNumber = order?.order_number ?? null;
  const orderName = order?.name ?? null;

  // --- 4) only care if eval variant is in the order (unchanged behavior)
  if (!Number.isFinite(EVAL_VARIANT_ID) || EVAL_VARIANT_ID <= 0) {
    console.warn("[PSA v3] Missing/invalid SHOPIFY_EVAL_VARIANT_ID; skipping.");
    return res.status(200).json({ ok: true, skipped: true, reason: "no_eval_id" });
  }

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const hasEval = lineItems.some(li => Number(li.variant_id) === EVAL_VARIANT_ID);
  if (!hasEval) {
    dlog("no eval sku, skipping", { id: order?.id, name: order?.name });
    return res.status(200).json({ ok: true, skipped: true });
  }
  const evalQty = lineItems.reduce(
    (acc, li) => acc + (Number(li.variant_id) === EVAL_VARIANT_ID ? Number(li.quantity || 0) : 0),
    0
  );

  // Compute the eval-only subtotal (after discounts, before tax/shipping)
  const evalLineSubtotal = computeEvalLineSubtotal(lineItems, EVAL_VARIANT_ID);

  // --- 5) pull our attributes (primary: note_attributes; fallback: line_items.properties)
  const noteAttrs = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const attrs = noteAttrs.reduce((acc, cur) => {
    const k = String(cur?.name || "").toLowerCase().trim();
    acc[k] = String(cur?.value ?? "");
    return acc;
  }, {});
  dlog("attrs", attrs);

  let submissionId = attrs["psa_submission_id"] || "";

  // Fallback for accelerated checkout: scan line_items[].properties **only if missing**
  let fallbackPayloadB64 = "";
  if (!submissionId && lineItems.length) {
    for (const li of lineItems) {
      const m = propsToMap(li?.properties);
      if (!submissionId && m["psa_submission_id"]) {
        submissionId = m["psa_submission_id"];
        dlog("found submission_id via line_items.properties fallback");
      }
      if (!fallbackPayloadB64 && m["psa_payload_b64"]) {
        fallbackPayloadB64 = m["psa_payload_b64"];
      }
      if (submissionId && fallbackPayloadB64) break;
    }
  }

  if (!submissionId) {
    console.warn("[PSA v3] Missing psa_submission_id on order", { id: order?.id, name: order?.name });
    return res.status(200).json({ ok: true, missing_submission_id: true });
  }

  // --- 5.5) Idempotency guard (optional)
  if (ENABLE_PSA_IDEMPOTENCY) {
    try {
      const { data: idem } = await supabase
        .from("psa_submissions")
        .select("status, shopify_order_id, paid_at_iso")
        .eq("submission_id", submissionId)
        .maybeSingle();

      if (idem && idem.status === "submitted_paid") {
        // If we already marked this submission paid, short-circuit.
        // We treat it as idempotent if either no stored order id yet OR it matches the incoming one.
        if (!idem.shopify_order_id || (orderIdStr && String(idem.shopify_order_id) === orderIdStr)) {
          dlog("idempotency: already submitted_paid; skipping duplicate orders/paid", {
            submissionId,
            existing_order_id: idem.shopify_order_id,
            incoming_order_id: orderIdStr
          });
          return res.status(200).json({ ok: true, idempotent: true, submission_id: submissionId });
        }
      }
    } catch (e) {
      dlog("idempotency check error (non-fatal):", e?.message);
      // continue normally if the check fails
    }
  }

  // Optional tiny payload (may have cards/email)
  let basePayload = null;
  const rawPayloadB64 = attrs["psa_payload_b64"] || fallbackPayloadB64 || "";
  if (rawPayloadB64) {
    try {
      // be tolerant: base64 may contain URL-safe alphabet or have been URI-encoded pre-encode
      let b64 = rawPayloadB64.replace(/ /g, "+"); // just in case
      let decoded = Buffer.from(b64, "base64").toString("utf8");
      try { decoded = decodeURIComponent(decoded); } catch {}
      basePayload = JSON.parse(decoded);
      dlog("decoded psa_payload_b64");
    } catch (e) {
      console.warn("[PSA v3] Failed to decode psa_payload_b64:", e?.message);
    }
  }

  // --- 6) figure out original cards (preserve existing if present)
  let cardsToUse = 0;
  try {
    const { data: existing } = await supabase
      .from("psa_submissions")
      .select("cards")
      .eq("submission_id", submissionId)
      .maybeSingle();
    const fromDb = Number(existing?.cards);
    const fromPayload = Number(basePayload?.cards);
    cardsToUse = Number.isFinite(fromDb) && fromDb > 0
      ? fromDb
      : (Number.isFinite(fromPayload) && fromPayload > 0 ? fromPayload : 0);
  } catch {
    const fromPayload = Number(basePayload?.cards);
    cardsToUse = Number.isFinite(fromPayload) && fromPayload > 0 ? fromPayload : 0;
  }

  // --- 7) email (required by DB)
  let customerEmail = (order?.email || order?.customer?.email || basePayload?.customer_email || "").trim();
  if (!customerEmail) customerEmail = "unknown@no-email.local"; // prevents NOT NULL violation
  dlog("email", customerEmail);

  // --- 8) small Shopify snapshot (unchanged fields)
  const shopify = {
    id: order?.id,
    name: order?.name,
    order_number: order?.order_number,
    email: order?.email,
    currency: order?.currency,
    total_price: order?.total_price,
    created_at: order?.created_at,
    line_items: lineItems.map(li => ({
      id: li.id,
      variant_id: li.variant_id,
      title: li.title,
      quantity: li.quantity,
      price: li.price
    }))
  };

  // Optional paid_amount (env-gated)
  const paidAmount = SAVE_PSA_PAID_AMOUNT ? extractPaidAmount(order) : null;

  // --- 9) update first, then insert if not found (unchanged pattern)
  const common = {
    customer_email: customerEmail,
    evaluation: Number.isFinite(evalQty) ? evalQty : 0,
    cards: cardsToUse,
    status: "submitted_paid",
    submitted_via: "webhook_orders_paid",
    paid_at_iso: new Date().toISOString(),
    shopify
  };
  if (SAVE_PSA_PAID_AMOUNT && Number.isFinite(paidAmount)) {
    common.paid_amount = paidAmount;
  }
  if (SAVE_PSA_EVAL_SUBTOTAL && Number.isFinite(evalLineSubtotal)) {
    common.eval_line_subtotal = evalLineSubtotal;
  }
  if (SAVE_PSA_ORDER_KEYS) {
    if (orderIdStr) common.shopify_order_id = orderIdStr;
    if (orderNumber != null) common.shopify_order_number = orderNumber;
    if (orderName != null) common.shopify_order_name = orderName;
    if (shopDomain) common.shop_domain = shopDomain;
  }

  // try UPDATE
  const { data: updRows, error: updErr } = await supabase
    .from("psa_submissions")
    .update(common)
    .eq("submission_id", submissionId)
    .select("id");

  if (updErr) {
    console.error("[PSA v3] Supabase update error:", updErr);
    return res.status(500).send("Update failed");
  }

  const updatedCount = Array.isArray(updRows) ? updRows.length : 0;

if (updatedCount === 0) {
  // No pre-submit row found. Do NOT insert (avoids address NOT NULL issues).
  dlog("no pre-submit row found; skipping insert", { submissionId, order: order?.name });
  return res.status(200).json({ ok: true, updated: 0, not_found: true, submission_id: submissionId });
} else {
  dlog("updated existing row", { submissionId, updatedCount });
}


  console.log("[PSA v3] OK", { order: order?.name, submissionId, evalQty, cardsToUse });
  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
