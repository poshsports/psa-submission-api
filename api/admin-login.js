// Vercel Node function (ESM)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Robust body parse
  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const pass = String(body.pass || '');
  const expected = process.env.ADMIN_PORTAL_PASS || 'psaadmin';

  if (pass !== expected) {
    return res.status(401).json({ ok: false, error: 'invalid_pass' });
  }

  // Set a secure cookie for 7 days. Path=/ so it's visible to /admin and APIs.
  // SameSite=Lax is fine here; add Secure so modern Chrome accepts it.
  const cookie = [
    'psa_admin=1',
    'Path=/',           // available on all paths
    'Max-Age=604800',   // 7 days in seconds
    'SameSite=Lax',
    'Secure'            // required on HTTPS for many browsers
  ].join('; ');

  // Avoid any edge caching weirdness
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Set-Cookie', cookie);

  return res.status(200).json({ ok: true });
}
