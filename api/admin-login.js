// Minimal passcode login
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }
  let body = {};
  try { body = JSON.parse(req.body || '{}'); } catch {}
  const pass = String(body.pass || '');
  const expected = process.env.ADMIN_PORTAL_PASS || 'psaadmin'; // default works without env

  if (pass !== expected) return res.status(401).json({ ok: false, error: 'invalid_pass' });

  res.setHeader('Set-Cookie', [
    'psa_admin=1; Path=/; Max-Age=604800; SameSite=Lax'  // 7 days
  ]);
  return res.status(200).json({ ok: true });
};
