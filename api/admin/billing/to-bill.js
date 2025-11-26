// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Utility: coerce to timestamp (ms) or null
const ts = (v) => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const ok = await requireAdmin(req, res);
  if (!ok) return;

  // Inputs (optional)
  const limit = Math.min(Math.max(Number(req.query.limit) || 800, 1), 2000);
  const q = String(req.query.q || "").trim().toLowerCase();
  const groupFilter = String(req.query.group || "").trim().toLowerCase();
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to   = req.query.to   ? new Date(String(req.query.to))   : null;
  const fromMs = from && !isNaN(from) ? from.getTime() : null;
  const toMs   = to   && !isNaN(to)   ? to.getTime()   : null;

  // ✅ 1) Fetch OPEN invoices — one per row
  const { data: invoices, error: invErr } = await supabase
    .from("billing_invoices")
    .select(`
      id,
      customer_email,
      shopify_customer_id,
      group_code,
      status,
      subtotal_cents,
      shipping_cents,
      total_cents,
      created_at,
      updated_at
    `)
    .in("status", ["pending", "draft"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (invErr) {
    console.error("[to-bill] invErr:", invErr);
    return res.status(500).json({ error: "Failed to read invoices" });
  }

  if (!invoices || invoices.length === 0) {
    return res.status(200).json({ items: [] });
  }

  // ✅ Fetch submission counts
  const invoiceIds = invoices.map((i) => i.id);

  let submissionCounts = {};
  if (invoiceIds.length) {
    const { data: links } = await supabase
      .from("billing_invoice_submissions")
      .select("invoice_id, submission_code")
      .in("invoice_id", invoiceIds);

    if (links && links.length) {
      for (const l of links) {
        submissionCounts[l.invoice_id] =
          (submissionCounts[l.invoice_id] || 0) + 1;
      }
    }
  }

  // ✅ 2) Optional in-memory filters
  let filtered = invoices;

  // Search by email, invoice id, or group code
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [
        r.customer_email,
        r.id,
        r.group_code,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  // Filter by group code
  if (groupFilter) {
    filtered = filtered.filter((r) =>
      String(r.group_code || "").toLowerCase().includes(groupFilter)
    );
  }

  // Filter by date
  if (fromMs != null || toMs != null) {
    filtered = filtered.filter((r) => {
      const t = ts(r.created_at);
      if (t == null) return false;
      if (fromMs != null && t < fromMs) return false;
      if (toMs   != null && t > toMs)   return false;
      return true;
    });
  }

  // ✅ 3) Shape output for UI — ONE ROW PER INVOICE
  const items = filtered.map((inv) => ({
    invoice_id: inv.id,
    customer_email: inv.customer_email,
    group_code: inv.group_code,
    submissions_count: submissionCounts[inv.id] || 0,
    total_cents: inv.total_cents,
    created_at: inv.created_at,
  }));

  return res.status(200).json({ items });
}
