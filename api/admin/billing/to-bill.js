// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Utility: coerce a value to a numeric timestamp (ms) or null
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

  // Admin gate (same as other admin endpoints)
  const ok = await requireAdmin(req, res);
  if (!ok) return; // requireAdmin already sent 401

  // Inputs (optional)
  const limit = Math.min(Math.max(Number(req.query.limit) || 800, 1), 2000);
  const q = String(req.query.q || "").trim().toLowerCase();
  const groupFilter = String(req.query.group || "").trim().toLowerCase();
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  const fromMs = from && !isNaN(from) ? from.getTime() : null;
  const toMs = to && !isNaN(to) ? to.getTime() : null;

  // 1) Pull candidate submissions from the admin view
  const { data: subs, error: subsErr } = await supabase
    .from("admin_submissions_v")
    .select(
      "submission_id, status, customer_email, customer_name, group_code, cards, created_at"
    )
    .eq("status", "received_from_psa")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (subsErr) {
    console.error("[to-bill] subsErr:", subsErr);
    return res.status(500).json({ error: "Failed to read submissions" });
  }

  if (!subs || subs.length === 0) {
    return res.status(200).json({ items: [] });
  }

  // Optional in-memory filters (search / group / date)
  let filtered = subs;

  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [
        r.email,
        r.customer_email,
        r.customer_name,
        r.submission_id,
        r.group_code,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  if (groupFilter) {
    filtered = filtered.filter((r) =>
      String(r.group_code || "").toLowerCase().includes(groupFilter)
    );
  }

  if (fromMs != null || toMs != null) {
    filtered = filtered.filter((r) => {
      const t = ts(r.created_at);
      if (t == null) return false;
      if (fromMs != null && t < fromMs) return false;
      if (toMs != null && t > toMs) return false;
      return true;
    });
  }

  // 2) Work out invoice relationships for these submissions
  const ids = Array.from(
    new Set(filtered.map((r) => r.submission_id).filter(Boolean))
  );

  const exclude = new Set(); // submissions on draft/sent/paid invoices
  const invBySub = new Map(); // submission_id -> pending invoice row

  if (ids.length) {
    const { data: links, error: linkErr } = await supabase
      .from("billing_invoice_submissions")
      .select("invoice_id, submission_code")
      .in("submission_code", ids);

    if (linkErr) {
      console.error("[to-bill] linkErr:", linkErr);
      // fail-safe: treat as no links
    } else if (links && links.length) {
      const invoiceIds = Array.from(
        new Set(links.map((r) => r.invoice_id).filter(Boolean))
      );

      let invMap = new Map();
      if (invoiceIds.length) {
        const { data: invs, error: invErr } = await supabase
          .from("billing_invoices")
          .select("id, status, invoice_url")
          .in("id", invoiceIds);

        if (invErr) {
          console.error("[to-bill] invErr:", invErr);
        } else {
          invMap = new Map((invs || []).map((i) => [i.id, i]));
        }
      }

      for (const l of links) {
        const inv = invMap.get(l.invoice_id);
        if (!inv) continue;
        const st = String(inv.status || "").toLowerCase();

        // Draft/sent/paid => fully billed, never show again
        if (["draft", "sent", "paid"].includes(st)) {
          exclude.add(l.submission_code);
        }

        // Pending => still "To send", but grouped per invoice
        if (st === "pending") {
          invBySub.set(l.submission_code, inv);
        }
      }
    }
  }

  const eligible = filtered.filter((r) => !exclude.has(r.submission_id));

  // 3) Bundle by (invoice_id if pending, else customer_email)
  const bundles = new Map();

  for (const r of eligible) {
    const email = (r.customer_email || r.email || "").trim().toLowerCase();
    if (!email) continue;

    const name = r.customer_name || "";
    const receivedAt = r.created_at || null;
    const inv = invBySub.get(r.submission_id) || null;

    // Key logic:
    // - If there's a pending invoice, group by that invoice (so splits show separately)
    // - Otherwise, group by customer email (so brand-new subs are combined)
    const key = inv ? `inv:${inv.id}` : `cust:${email}`;

    let b = bundles.get(key);
    if (!b) {
      b = {
        key,
        invoice_id: inv ? inv.id : null,
        invoice_status: inv ? inv.status : null,
        invoice_url: inv ? inv.invoice_url || null : null,
        customer_email: email,
        customer_name: name,
        submissions: [],
        groups: new Set(),
        cards: 0,
        _newest: null,
        _oldest: null,
      };
      bundles.set(key, b);
    }

    b.submissions.push({
      submission_id: r.submission_id,
      group_code: r.group_code || null,
      cards: Number(r.cards) || 0,
      returned_at: receivedAt,
    });

    if (r.group_code) b.groups.add(r.group_code);
    b.cards += Number(r.cards) || 0;

    const t = ts(receivedAt);
    if (t != null) {
      if (b._newest == null || t > b._newest) b._newest = t;
      if (b._oldest == null || t < b._oldest) b._oldest = t;
    }
  }

  // 4) Shape output for UI (same shape as before, plus invoice fields)
  const items = Array.from(bundles.values()).map((b) => {
    const submission_ids = (b.submissions || [])
      .map((s) => s.submission_id)
      .filter(Boolean);
    const group_codes = Array.from(b.groups || []);

    return {
      customer_email: b.customer_email,
      customer_name: b.customer_name,
      submissions: b.submissions || [],
      submission_ids,
      groups: group_codes,
      group_codes,
      submissions_count: submission_ids.length,
      groups_count: group_codes.length,
      cards: b.cards,
      returned_newest: b._newest
        ? new Date(b._newest).toISOString()
        : null,
      returned_oldest: b._oldest
        ? new Date(b._oldest).toISOString()
        : null,
      estimated_cents: null,

      // NEW: invoice awareness for the front-end
      invoice_id: b.invoice_id,
      invoice_status: b.invoice_status,
      invoice_url: b.invoice_url,
    };
  });

  return res.status(200).json({ items });
}
