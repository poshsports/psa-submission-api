// v3.2 — accelerated-checkout fallback + optional paid_amount (env-gated)
// - Fallback: read psa_submission_id / psa_payload_b64 from line_items[].properties
//   when note_attributes are missing (Shop Pay / Apple Pay cases).
// - Optional: SAVE_PSA_PAID_AMOUNT=1 to persist a numeric paid_amount; otherwise skipped.
// - Keeps v3.1 behavior: raw HMAC, early eval-SKU gate, preserve cards, update→insert, same table/columns.

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } }; // needed for raw HMAC body on Next/Vercel

const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || "0");
const SAVE_PSA_PAID_AMOUNT = process.env.SAVE_PSA_PAID_AMOUNT === "1";

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

// Extract a best-effort paid amount from order totals
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

export default async function handler(req, res) {
  console.log("[PSA VERSION] v3.2 handler start");

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

  // --- 7) email (required by DB) — keep your behavior; add customer.email as mild fallback
  let customerEmail = (order?.email || order?.customer?.email || basePayload?.customer_email || "").trim();
  if (!customerEmail) customerEmail = "unknown@no-email.local"; // prevents NOT NULL violation
  dlog("email", customerEmail);

  // --- 8) small Shopify snapshot (unchanged fields; keep email and price present)
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

  // Optional paid_amount (env-gated to avoid breaking if column not ready)
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
    // not found -> INSERT (rare, but handles cases where pre-submit never ran)
    const toInsert = { submission_id: submissionId, ...common };
    const { error: insErr } = await supabase.from("psa_submissions").insert(toInsert);
    if (insErr) {
      console.error("[PSA v3] Supabase insert error:", insErr);
      return res.status(500).send("Insert failed");
    }
    dlog("inserted new row", submissionId);
  } else {
    dlog("updated existing row", { submissionId, updatedCount });
  }

  console.log("[PSA v3] OK", { order: order?.name, submissionId, evalQty, cardsToUse });
  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
