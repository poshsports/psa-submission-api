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

  // 1) Fetch OPEN (to-send) invoices.
  //    We use "pending" here – "sent/paid" live in the other tabs.
  const { data: invoices, error: invErr } = await supabase
    .from("billing_invoices")
    .select(`
      id,
      status,
      group_code,
      shopify_customer_id,
      subtotal_cents,
      shipping_cents,
      discount_cents,
      tax_cents,
      total_cents,
      created_at,
      updated_at
    `)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (invErr) {
    console.error("[to-bill] invErr:", invErr);
    return res.status(500).json({ error: "Failed to read invoices" });
  }

  if (!invoices || invoices.length === 0) {
    return res.status(200).json({ items: [] });
  }

  const invoiceIds = invoices.map((i) => i.id);

  // 2) Get submission links for those invoices
  const linksByInvoice = new Map(); // invoice_id -> [submission_code]

  let allSubmissionCodes = [];
  if (invoiceIds.length) {
    const { data: links, error: linkErr } = await supabase
      .from("billing_invoice_submissions")
      .select("invoice_id, submission_code")
      .in("invoice_id", invoiceIds);

    if (linkErr) {
      console.error("[to-bill] linkErr:", linkErr);
      // If this fails, nothing to show – we don't want phantom invoices
      return res.status(200).json({ items: [] });
    }

    for (const l of links || []) {
      if (!l.invoice_id || !l.submission_code) continue;
      if (!linksByInvoice.has(l.invoice_id)) {
        linksByInvoice.set(l.invoice_id, []);
      }
      linksByInvoice.get(l.invoice_id).push(l.submission_code);
      allSubmissionCodes.push(l.submission_code);
    }
  }

  allSubmissionCodes = Array.from(new Set(allSubmissionCodes));
  if (!allSubmissionCodes.length) {
    // No invoices actually attached to submissions -> nothing to send
    return res.status(200).json({ items: [] });
  }

  // 3) Pull submission details from admin_submissions_v
  const { data: subs, error: subsErr } = await supabase
    .from("admin_submissions_v")
    .select("submission_id, customer_email, group_code, cards, created_at")
    .in("submission_id", allSubmissionCodes);

  if (subsErr) {
    console.error("[to-bill] subsErr:", subsErr);
    return res.status(500).json({ error: "Failed to read submissions" });
  }

  const subById = new Map();
  for (const s of subs || []) {
    if (!s.submission_id) continue;
    subById.set(s.submission_id, s);
  }

  // 4) Build bundles: ONE bundle per invoice (matches old shape)
  let bundles = [];

  for (const inv of invoices) {
    const codes = linksByInvoice.get(inv.id) || [];
    const subRecords = codes
      .map((code) => subById.get(code))
      .filter(Boolean);

    // Skip invoices that somehow have no valid submissions
    if (!subRecords.length) continue;

    const bundle = {
      invoice_id: inv.id,
      customer_email: subRecords[0].customer_email || "",
      customer_name: "", // not used currently
      submissions: [],
      groups: new Set(),
      cards: 0,
      _newest: null,
      _oldest: null,
      estimated_cents: inv.total_cents ?? null,
    };

    for (const s of subRecords) {
      const t = ts(s.created_at);

      bundle.submissions.push({
        submission_id: s.submission_id,
        group_code: s.group_code,
        cards: Number(s.cards) || 0,
        returned_at: s.created_at,
      });

      if (s.group_code) bundle.groups.add(s.group_code);
      bundle.cards += Number(s.cards) || 0;

      if (t != null) {
        if (bundle._newest == null || t > bundle._newest) bundle._newest = t;
        if (bundle._oldest == null || t < bundle._oldest) bundle._oldest = t;
      }
    }

    bundles.push(bundle);
  }

  // 5) Apply in-memory filters (search, group, date) on the bundles
  let filtered = bundles;

  if (q) {
    filtered = filtered.filter((b) => {
      const hay = [
        b.customer_email,
        ...b.submissions.map((s) => s.submission_id),
        ...Array.from(b.groups || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  if (groupFilter) {
    filtered = filtered.filter((b) =>
      Array.from(b.groups || []).some((g) =>
        String(g || "").toLowerCase().includes(groupFilter)
      )
    );
  }

  if (fromMs != null || toMs != null) {
    filtered = filtered.filter((b) => {
      const t = b._newest;
      if (t == null) return false;
      if (fromMs != null && t < fromMs) return false;
      if (toMs   != null && t > toMs)   return false;
      return true;
    });
  }

  // 6) Shape response exactly like the old endpoint
  const items = filtered.map((b) => {
    const submission_ids = (b.submissions || []).map((s) => s.submission_id);
    const group_codes = Array.from(b.groups || []);

    return {
      invoice_id: b.invoice_id,      // extra field (ignored by current UI, but handy)
      customer_email: b.customer_email,
      customer_name: b.customer_name,
      submissions: b.submissions || [],
      submission_ids,
      groups: b.groups,
      group_codes,
      submissions_count: submission_ids.length,
      groups_count: group_codes.length,
      cards: b.cards,
      returned_newest: b._newest ? new Date(b._newest).toISOString() : null,
      returned_oldest: b._oldest ? new Date(b._oldest).toISOString() : null,
      estimated_cents: b.estimated_cents,
    };
  });

  return res.status(200).json({ items });
}
