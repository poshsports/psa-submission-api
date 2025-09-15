// /api/admin/billing/cards-for.js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/*
  Returns per-card rows for the given submissions.
  Query param:
    ?subs=psa-191,psa-205,psa-206  (comma-separated submission codes/ids)

  IMPORTANT: If your cards view/table name differs, change TABLE below to the one
  that backs the Group detail “Cards” grid (it typically includes these columns).
*/
const TABLE = "admin_submissions_v"; // adjust if your view/table has a different name

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const ok = await requireAdmin(req, res);
  if (!ok) return;

  const raw = String(req.query.subs || "").trim();
  const subs = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 200);

  if (!subs.length) {
    return res.status(200).json({ items: [] });
  }

  // Select the fields we need; alias to a stable shape.
  const { data, error } = await supabase
    .from(TABLE)
    .select(`
      submission_code,
      submission_id,
      break_date,       -- date or timestamp
      break_channel,    -- text
      break_num,        -- integer / text number
      card_description  -- text
    `)
    .in("submission_code", subs)
    .order("submission_code", { ascending: true })
    .order("break_num", { ascending: true });

  if (error) {
    console.error("[cards-for] err:", error);
    return res.status(500).json({ error: "Failed to read cards" });
  }

  // Normalize keys to a single, predictable payload
  const items = (data || []).map(r => ({
    submission_id: r.submission_code || r.submission_id || "",
    break_date: r.break_date ?? null,
    break_channel: r.break_channel ?? "",
    break_num: r.break_num ?? null,
    card_description: r.card_description ?? "",
  }));

  return res.status(200).json({ items });
}
