// Vercel Node function (ESM default export + robust body parsing)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const pass = String(body.pass || '');
  const expected = process.env.ADMIN_PORTAL_PASS || 'psaadmin';

  if (pass !== expected) {
    return res.status(401).json({ ok: false, error: 'invalid_pass' });
  }

  res.setHeader('Set-Cookie', 'psa_admin=1; Path=/; Max-Age=604800; SameSite=Lax');
  return res.status(200).json({ ok: true });
}
