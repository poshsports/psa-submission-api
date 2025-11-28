// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

  // Read tab, default to "to-send"
  const tab = (req.query.tab || "to-send").toString();

  // =====================================================
  // 1) INVOICE-BASED MODE (only if invoice query succeeds)
  // =====================================================
  let invoices = [];
  try {
    const { data, error } = await supabase
      .from("billing_invoices")
      .select(`
        id,
        status,
        customer_email,
        subtotal_cents,
        total_cents,
        metadata,
        created_at
      `)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      invoices = data;
    } else if (error) {
      console.warn("[to-bill] invoice read failed, falling back to submissions:", error);
      invoices = [];
    }
  } catch (err) {
    console.warn("[to-bill] unexpected invoice read error, falling back:", err);
    invoices = [];
  }

  // If we *successfully* loaded some pending invoices, return invoice bundles.
  if (invoices.length > 0) {
    const invoiceIds = invoices.map((i) => i.id);

    const { data: links, error: linkErr } = await supabase
      .from("billing_invoice_submissions")
      .select("invoice_id, submission_code")
      .in("invoice_id", invoiceIds);

    if (linkErr) {
      console.error("[to-bill] linkErr (invoice mode):", linkErr);
      // even if this fails, it's safer to fall back than 500
      return res.status(200).json({ items: [] });
    }

    // Build bundles keyed by invoice
    const map = new Map();
    for (const inv of invoices) {
      map.set(inv.id, {
        invoice_id: inv.id,
        customer_email: inv.customer_email,
        submissions: [],
        submission_ids: [],
        groups: new Set(),
        cards: 0,
        returned_newest: null,
        returned_oldest: null,
        estimated_cents: inv.total_cents,
        is_split: inv.metadata?.is_split === true,
      });
    }

    // Fetch submission info for those invoice-linked subs
    const codes = links.map((l) => l.submission_code);
    const { data: subs } = await supabase
      .from("admin_submissions_v")
      .select("submission_id, group_code, cards, created_at")
      .in("submission_id", codes);

    const byId = new Map();
    for (const s of subs || []) byId.set(s.submission_id, s);

    for (const l of links) {
      const b = map.get(l.invoice_id);
      const s = byId.get(l.submission_code);
      if (!b || !s) continue;

      b.submission_ids.push(s.submission_id);
      b.submissions.push({
        submission_id: s.submission_id,
        group_code: s.group_code,
        cards: s.cards,
      });

      b.cards += Number(s.cards) || 0;
      if (s.group_code) b.groups.add(s.group_code);

      const t = ts(s.created_at);
      if (t != null) {
        if (!b.returned_newest || t > b.returned_newest) b.returned_newest = t;
        if (!b.returned_oldest || t < b.returned_oldest) b.returned_oldest = t;
      }
    }

    const items = [...map.values()].map((b) => ({
      ...b,
      group_codes: Array.from(b.groups),
      groups: b.groups,
    }));

    return res.status(200).json({ items });
  }

  // ===========================================================
  // 2) NO PENDING INVOICES OR INVOICE READ FAILED:
  //    ORIGINAL "RECEIVED_FROM_PSA" COMBINED MODE
  // ===========================================================
  const { data: submissions, error: subErr } = await supabase
    .from("admin_submissions_v")
    .select("submission_id, customer_email, group_code, cards, created_at, last_updated_at, status")
    .eq("status", "received_from_psa"); // ORIGINAL LOGIC

  if (subErr) {
    console.error("[to-bill] subsErr:", subErr);
    return res.status(500).json({ error: "Failed to read submissions" });
  }

  if (!submissions || submissions.length === 0) {
    return res.status(200).json({ items: [] });
  }

  // Group by customer_email (your original behavior)
  const grouped = new Map();

  for (const s of submissions) {
    if (!grouped.has(s.customer_email)) {
      grouped.set(s.customer_email, {
        customer_email: s.customer_email,
        submissions: [],
        submission_ids: [],
        groups: new Set(),
        cards: 0,
        returned_newest: null,
        returned_oldest: null,
        is_split: false, // combined mode
      });
    }

    const b = grouped.get(s.customer_email);
    b.submission_ids.push(s.submission_id);
    b.submissions.push(s);

    if (s.group_code) b.groups.add(s.group_code);
    b.cards += Number(s.cards) || 0;

    // Normalized timestamp of when the sub was received from PSA
const t = ts(
  s.returned_at ||          // future-proof: if we add returned_at later
  s.last_updated_at ||      // your current source of truth
  s.created_at              // final fallback
);
    if (t != null) {
      if (!b.returned_newest || t > b.returned_newest) b.returned_newest = t;
      if (!b.returned_oldest || t < b.returned_oldest) b.returned_oldest = t;
    }
  }

  const items = [...grouped.values()].map((b) => ({
    ...b,
    group_codes: Array.from(b.groups),
    groups: b.groups,
  }));

  return res.status(200).json({ items });
}
