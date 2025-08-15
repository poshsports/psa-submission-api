// GET /api/admin/submissions
// Returns latest submissions from Supabase (server-side, requires psa_admin cookie)
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Simple cookie gate (we already set this via /api/admin-login)
  const cookie = req.headers.cookie || '';
  const authed = cookie.split(';').some(v => v.trim().startsWith('psa_admin=1'));
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // Supabase REST
  const URL =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL; // fallbacks if you used NEXT_PUBLIC before
  const KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY; // support either var name

  if (!URL || !KEY) {
    return res.status(500).json({ ok: false, error: 'missing_supabase_env' });
  }

  // Select only what we need; adjust limit as you like
  const endpoint =
    `${URL.replace(/\/+$/, '')}/rest/v1/submissions` +
    `?select=submission_id,customer_email,cards,totals,status,created_at,last_updated_at` +
    `&order=created_at.desc&limit=50`;

  try {
    const r = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: 'count=exact'
      }
    });

    const text = await r.text();
    let data = [];
    try { data = JSON.parse(text); } catch { /* leave data as [] on parse issues */ }

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: 'supabase_error', detail: text });
    }

    return res.status(200).json({ ok: true, items: Array.isArray(data) ? data : [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'fetch_failed', detail: String(e) });
  }
}
