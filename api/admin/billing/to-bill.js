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

  const ok = await requireAdmin(req, res);
  if (!ok) return; // 401 already sent

  // Inputs (optional)
  const limit = Math.min(Math.max(Number(req.query.limit) || 800, 1), 2000);
  const q = String(req.query.q || "").trim().toLowerCase();
  const groupFilter = String(req.query.group || "").trim().toLowerCase();
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to   = req.query.to   ? new Date(String(req.query.to))   : null;
  const fromMs = from && !isNaN(from) ? from.getTime() : null;
  const toMs   = to   && !isNaN(to)   ? to.getTime()   : null;

  // 1) Pull candidate submissions from the admin view
  //    Only those received from PSA.
  const { data: subs, error: subsErr } = await supabase
    .from("admin_submissions_v")
    .select("submission_id, status, customer_email, group_code, cards, created_at")
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

  // 2) Optional in-memory filters (search / group / date)
  let filtered = subs;

  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [
        r.customer_email,
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
      if (toMs   != null && t > toMs)   return false;
      return true;
    });
  }

  // 3) Invoice awareness: exclude subs already on open invoices
  const ids = Array.from(new Set(filtered.map((r) => r.submission_id))).filter(Boolean);
  const exclude = new Set();

  if (ids.length) {
    const { data: links, error: linkErr } = await supabase
      .from("billing_invoice_submissions")
      .select("invoice_id, submission_code")
      .in("submission_code", ids);

    if (linkErr) {
      console.error("[to-bill] linkErr:", linkErr);
      // fail-safe: if this errors, we just won't exclude anything
    } else if (links && links.length) {
      const invoiceIds = Array.from(
        new Set(links.map((r) => r.invoice_id))
      ).filter(Boolean);

      if (invoiceIds.length) {
        const { data: invs, error: invErr } = await supabase
          .from("billing_invoices")
          .select("id, status")
          .in("id", invoiceIds);

        if (invErr) {
          console.error("[to-bill] invErr:", invErr);
        } else {
          // ✅ Treat pending + draft (and sent/paid) as "open for our purposes"
          const openStatuses = new Set(["pending", "draft", "sent", "paid"]);
          const open = new Set(
            (invs || [])
              .filter((inv) =>
                openStatuses.has(String(inv.status || "").toLowerCase())
              )
              .map((inv) => inv.id)
          );

          for (const l of links) {
            if (open.has(l.invoice_id)) {
              exclude.add(l.submission_code);
            }
          }
        }
      }
    }
  }

  const eligible = filtered.filter((r) => !exclude.has(r.submission_id));

  // 4) Bundle by customer_email (same as old behavior)
  const bundles = new Map(); // key = customer_email (lower)

  for (const r of eligible) {
    const email = (r.customer_email || "").trim().toLowerCase();
    if (!email) continue; // need an anchor to invoice

    const receivedAt = r.created_at || null;

    let b = bundles.get(email);
    if (!b) {
      b = {
        customer_email: email,
        customer_name: "", // not used right now
        submissions: [],
        groups: new Set(),
        cards: 0,
        _newest: null,
        _oldest: null,
      };
      bundles.set(email, b);
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

  // 5) Shape output for the UI (same structure as before)
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
      returned_newest: b._newest ? new Date(b._newest).toISOString() : null,
      returned_oldest: b._oldest ? new Date(b._oldest).toISOString() : null,
      estimated_cents: null, // filled in by addServerEstimates on the client
    };
  });

  return res.status(200).json({ items });
}
