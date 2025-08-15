// GET /api/admin/submissions
// Reads from Supabase table `psa_submissions` (or SUBMISSIONS_TABLE if you set it)
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Cookie gate (set by /api/admin-login)
  const cookie = req.headers.cookie || '';
  const authed = cookie.split(';').some(v => v.trim().startsWith('psa_admin=1'));
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const URL =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!URL || !KEY) {
    return res.status(500).json({ ok: false, error: 'missing_supabase_env' });
  }

  // Your real table name
  const TABLE = process.env.SUBMISSIONS_TABLE || 'psa_submissions';

  // Use select=* to avoid column-name errors while we normalize on the server
  const endpoint =
    `${URL.replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(TABLE)}` +
    `?select=*&limit=50`;

  try {
    const r = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: 'count=exact'
      }
    });

    const txt = await r.text();
    let rows = [];
    try { rows = JSON.parse(txt); } catch {}

    if (!r.ok) {
      // Surface PostgREST detail so we can see problems quickly
      return res.status(r.status).json({ ok: false, error: 'supabase_error', detail: txt });
    }

    // Normalize to the fields the admin table expects
    const items = (Array.isArray(rows) ? rows : []).map((row) => {
      const totals =
        row.totals ??
        { grand: row.grand_total ?? row.total ?? row.total_amount ?? null };

      return {
        submission_id:
          row.submission_id ?? row.id ?? row.uuid ?? row.submissionId ?? null,
        customer_email:
          row.customer_email ?? row.email ?? (row.customer && row.customer.email) ?? null,
        cards:
          row.cards ?? row.card_count ?? (Array.isArray(row.card_info) ? row.card_info.length : null),
        totals,
        status:
          row.status ?? row.current_status ?? row.state ?? null,
        created_at:
          row.created_at ?? row.inserted_at ?? row.submitted_at_iso ?? row.createdAt ?? null,
        last_updated_at:
          row.last_updated_at ?? row.updated_at ?? row.updated_at_iso ?? row.updatedAt ?? null,
        // keep a copy of the raw row for future mapping if we need it
        _raw: row
      };
    });

    return res.status(200).json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'fetch_failed', detail: String(e) });
  }
}
