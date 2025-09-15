import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../_util/adminAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Uses your table directly
const CARD_TABLE = "submission_cards";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Admin gate
  const ok = await requireAdmin(req, res);
  if (!ok) return;

  // subs=psa-191,psa-205,...
  const ids = String(req.query.subs || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (!ids.length) return res.status(200).json({ rows: [] });

  // Pull card rows; select * so we’re resilient to column name differences
  const { data, error } = await supabase
    .from(CARD_TABLE)
    .select("*")
    .in("submission_code", ids)   // if your column is submission_id, the fallback in the client handles it
    .order("submission_code", { ascending: true })
    .order("break_number", { ascending: true })  // harmless if column name differs

  if (error) {
    console.error("[cards-preview] error:", error);
    return res.status(500).json({ error: "Failed to read cards", rows: [] });
  }

  return res.status(200).json({ rows: data || [] });
}
