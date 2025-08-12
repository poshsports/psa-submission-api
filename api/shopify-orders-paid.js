// v3 — writes customer_email and never uses upsert
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } }; // safe even if not Next.js

const EVAL_VARIANT_ID = Number(process.env.SHOPIFY_EVAL_VARIANT_ID || "0");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// set ENV DEBUG_PSA_WEBHOOK=1 to see these logs
const DEBUG = process.env.DEBUG_PSA_WEBHOOK === "1";
const dlog = (...a) => DEBUG && console.log("[PSA v3]", ...a);

export default async function handler(req, res) {
  console.log('[PSA VERSION] v3.1');
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

  // --- 4) only care if eval variant is in the order
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

  // --- 5) pull our attributes
  const noteAttrs = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  const attrs = noteAttrs.reduce((acc, cur) => {
    const k = String(cur?.name || "").toLowerCase();
    acc[k] = String(cur?.value ?? "");
    return acc;
  }, {});
  const submissionId = attrs["psa_submission_id"] || "";
  dlog("attrs", attrs);

  if (!submissionId) {
    console.warn("[PSA v3] Missing psa_submission_id on order", { id: order?.id, name: order?.name });
    return res.status(200).json({ ok: true, missing_submission_id: true });
  }

  // Optional tiny payload (may have cards/email)
  let basePayload = null;
  if (attrs["psa_payload_b64"]) {
    try {
      let decoded = Buffer.from(attrs["psa_payload_b64"], "base64").toString("utf8");
      try { decoded = decodeURIComponent(decoded); } catch {}
      basePayload = JSON.parse(decoded);
    } catch (e) {
      console.warn("[PSA v3] Failed to decode psa_payload_b64:", e?.message);
    }
  }

  // --- 6) figure out original cards
  let cardsToUse = 0;
  try {
    const { data: existing } = await supabase
      .from("psa_submissions")
      .select("cards")
      .eq("submission_id", submissionId)
      .single();
    const fromDb = Number(existing?.cards);
    const fromPayload = Number(basePayload?.cards);
    cardsToUse = Number.isFinite(fromDb) && fromDb > 0 ? fromDb :
                 (Number.isFinite(fromPayload) && fromPayload > 0 ? fromPayload : 0);
  } catch (e) {
    const fromPayload = Number(basePayload?.cards);
    cardsToUse = Number.isFinite(fromPayload) && fromPayload > 0 ? fromPayload : 0;
  }

  // --- 7) email (required by DB)
  let customerEmail = (order?.email || basePayload?.customer_email || "").trim();
  if (!customerEmail) customerEmail = "unknown@no-email.local"; // prevents NOT NULL violation
  dlog("email", customerEmail);

  // --- 8) small Shopify snapshot
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

  // --- 9) update first, then insert if not found
  const common = {
    customer_email: customerEmail,
    evaluation: Number.isFinite(evalQty) ? evalQty : 0,
    cards: cardsToUse,
    status: "submitted_paid",
    submitted_via: "webhook_orders_paid",
    paid_at_iso: new Date().toISOString(),
    shopify
  };

  // try UPDATE
  const { data: updated, error: updErr } = await supabase
    .from("psa_submissions")
    .update(common)
    .eq("submission_id", submissionId)
    .select("id")
    .maybeSingle();

  if (updErr) {
    console.error("[PSA v3] Supabase update error:", updErr);
    return res.status(500).send("Update failed");
  }

  if (!updated) {
    // not found -> INSERT
    const toInsert = { submission_id: submissionId, ...common };
    const { error: insErr } = await supabase.from("psa_submissions").insert(toInsert);
    if (insErr) {
      console.error("[PSA v3] Supabase insert error:", insErr);
      return res.status(500).send("Insert failed");
    }
    dlog("inserted new row", submissionId);
  } else {
    dlog("updated existing row", submissionId);
  }

  console.log("[PSA v3] OK", { order: order?.name, submissionId, evalQty, cardsToUse });
  return res.status(200).json({ ok: true, updated_submission_id: submissionId });
}
