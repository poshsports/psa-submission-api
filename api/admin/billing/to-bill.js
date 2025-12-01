// /api/admin/billing/to-bill.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Pick the best "received from PSA" timestamp as a string
function pickReceivedAt(row) {
  return row.last_updated_at || row.created_at || null;
}

// Compare two date strings safely using Date.parse
function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (Number.isNaN(na)) return false;
  if (Number.isNaN(nb)) return true;
  return na > nb;
}
function isOlder(a, b) {
  if (!a) return false;
  if (!b) return true;
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (Number.isNaN(na)) return false;
  if (Number.isNaN(nb)) return true;
  return na < nb;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const ok = await requireAdmin(req, res);
  if (!ok) return;

  // we only really have a "to-send" tab right now, but keep this
  const tab = (req.query.tab || "to-send").toString();

  // -------------------------------------------------------
  // 1) PENDING INVOICES → one bundle per invoice
  // -------------------------------------------------------
  let invoiceBundles = [];
  let invoiceAttachedSubIds = new Set();

  try {
    // NOTE: billing_invoices DOES NOT have customer_email.
    // We derive the email from linked submissions instead.
    const { data: invoices, error: invErr } = await supabase
      .from("billing_invoices")
      .select(`
        id,
        status,
        group_code,
        subtotal_cents,
        shipping_cents,
        discount_cents,
        tax_cents,
        total_cents,
        created_at
      `)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (invErr) {
      console.warn("[to-bill] invoice read failed, skipping invoice mode:", invErr);
    }

    if (Array.isArray(invoices) && invoices.length > 0) {
      const invoiceIds = invoices.map((i) => i.id);

      const { data: links, error: linkErr } = await supabase
        .from("billing_invoice_submissions")
        .select("invoice_id, submission_code")
        .in("invoice_id", invoiceIds);

      if (linkErr) {
        console.error("[to-bill] linkErr (invoice mode):", linkErr);
      } else if (Array.isArray(links) && links.length > 0) {
        const subCodes = [...new Set(links.map((l) => l.submission_code))];

        const { data: subs, error: subsErr } = await supabase
          .from("admin_submissions_v")
          .select(
            "submission_id, customer_email, group_code, cards, created_at, last_updated_at, status"
          )
          .in("submission_id", subCodes);

        if (subsErr) {
          console.error("[to-bill] subsErr (invoice mode):", subsErr);
        } else {
          const byId = new Map();
          for (const s of subs || []) {
            byId.set(s.submission_id, s);
          }

          // mark which submissions are already attached to a pending invoice
          invoiceAttachedSubIds = new Set(subCodes.filter(Boolean));

          const map = new Map(); // invoice_id -> bundle

          for (const inv of invoices) {
            map.set(inv.id, {
              invoice_id: inv.id,
              customer_email: null, // we’ll fill from subs
              submissions: [],
              submission_ids: [],
              groupsSet: new Set(),
              cards: 0,
              returned_newest: null,
              returned_oldest: null,
              estimated_cents:
                inv.total_cents ??
                (inv.subtotal_cents ?? 0) +
                  (inv.shipping_cents ?? 0) -
                  (inv.discount_cents ?? 0) +
                  (inv.tax_cents ?? 0),
              is_split:
                typeof inv.group_code === "string" &&
                inv.group_code.includes("-SPLIT-"),
            });
          }

          for (const l of links) {
            const bundle = map.get(l.invoice_id);
            const s = byId.get(l.submission_code);
            if (!bundle || !s) continue;

            bundle.submission_ids.push(s.submission_id);
            bundle.submissions.push({
              submission_id: s.submission_id,
              group_code: s.group_code,
              cards: s.cards,
              created_at: s.created_at,
              last_updated_at: s.last_updated_at,
              status: s.status,
            });

            if (!bundle.customer_email && s.customer_email) {
              bundle.customer_email = s.customer_email;
            }

            if (s.group_code) bundle.groupsSet.add(s.group_code);
            bundle.cards += Number(s.cards) || 0;

            const dt = pickReceivedAt(s);
            if (dt) {
              if (isNewer(dt, bundle.returned_newest)) bundle.returned_newest = dt;
              if (isOlder(dt, bundle.returned_oldest)) bundle.returned_oldest = dt;
            }
          }

          invoiceBundles = [...map.values()].map((b) => ({
            invoice_id: b.invoice_id,
            customer_email: b.customer_email || "", // <- for Customer column
            submissions: b.submissions,
            submission_ids: b.submission_ids,
            groups: Array.from(b.groupsSet),
            group_codes: Array.from(b.groupsSet),
            cards: b.cards,
            returned_newest: b.returned_newest,
            returned_oldest: b.returned_oldest,
            estimated_cents: b.estimated_cents,
            is_split: b.is_split,
          }));
        }
      }
    }
  } catch (err) {
    console.warn("[to-bill] unexpected invoice mode error:", err);
  }

      // -------------------------------------------------------
    // 2) RAW SUBMISSIONS (no pending invoice yet)
    //    → GROUPED PURELY BY EMAIL (ONE ROW PER EMAIL)
    // -------------------------------------------------------
    let emailBundles = [];

    try {
      const { data: submissions, error: subErr } = await supabase
        .from("admin_submissions_v")
        .select(
          "submission_id, customer_email, group_code, cards, created_at, last_updated_at, status"
        )
        .eq("status", "received_from_psa");

      if (subErr) {
        console.error("[to-bill] subsErr (combined mode):", subErr);
        return res.status(500).json({ error: "Failed to read submissions" });
      }

      if (!submissions || submissions.length === 0) {
        return res.status(200).json({ items: invoiceBundles });
      }

      const grouped = new Map(); // email → bundle

      for (const s of submissions) {
        if (invoiceAttachedSubIds.has(s.submission_id)) continue;

        const email = (s.customer_email || "").trim();

        if (!grouped.has(email)) {
          grouped.set(email, {
            customer_email: email,
            submissions: [],
            submission_ids: [],
            groupsSet: new Set(),
            cards: 0,
            returned_newest: null,
            returned_oldest: null,
            is_split: false,
          });
        }

        const b = grouped.get(email);

        b.submission_ids.push(s.submission_id);
        b.submissions.push({
          submission_id: s.submission_id,
          group_code: s.group_code,
          cards: s.cards,
          created_at: s.created_at,
          last_updated_at: s.last_updated_at,
          status: s.status,
        });

        if (s.group_code) b.groupsSet.add(s.group_code);
        b.cards += Number(s.cards) || 0;

        const dt = pickReceivedAt(s);
        if (dt) {
          if (isNewer(dt, b.returned_newest)) b.returned_newest = dt;
          if (isOlder(dt, b.returned_oldest)) b.returned_oldest = dt;
        }
      }

      // Convert map → ONE bundle per email
      emailBundles = [...grouped.values()].map((b) => ({
        invoice_id: null,
        customer_email: b.customer_email,
        submissions: b.submissions,
        submission_ids: b.submission_ids,
        groups: Array.from(b.groupsSet),
        group_codes: Array.from(b.groupsSet),
        cards: b.cards,
        returned_newest: b.returned_newest,
        returned_oldest: b.returned_oldest,
        estimated_cents: null,
        is_split: false,
      }));

    } catch (err) {
      console.error("[to-bill] unexpected combined-mode error:", err);
      return res.status(200).json({ items: invoiceBundles });
    }


  // -------------------------------------------------------
  // 3) FINAL RESULT
  //    - Pending invoice rows (already split)
  //    - PLUS one row per email for all remaining subs
  // -------------------------------------------------------
  const items = [...invoiceBundles, ...emailBundles];

  return res.status(200).json({ items });
}
