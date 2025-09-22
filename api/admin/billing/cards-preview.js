// /api/admin/billing/cards-preview.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Admin gate (same pattern as your other admin endpoints)
  const ok = await requireAdmin(req, res);
  if (!ok) return; // 401 already sent by requireAdmin

  // subs=psa-191,psa-205,...
  const raw = String(req.query.subs || "").trim();
  const ids = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (!ids.length) {
    // Nothing to fetch; return empty set to keep the client happy
    return res.status(200).json({ rows: [] });
  }

  // Pull per-card rows for those submissions.
  // Using card_index (int4) for stable ordering inside each submission.
  const { data, error } = await supabase
    .from("submission_cards")
    .select("id, submission_id, break_date, break_channel, break_number, card_description, card_index, grading_service")
    .in("submission_id", ids)
    .order("submission_id", { ascending: true })
    .order("card_index", { ascending: true }); // secondary, per-sub ordering

  if (error) {
    console.error("[cards-preview] supabase error:", error);
    return res.status(500).json({ error: "Failed to read submission cards" });
  }

  // Return rows as-is; client normalizer already accepts these exact names
  return res.status(200).json({ rows: data || [] });
}
