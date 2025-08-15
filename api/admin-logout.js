export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'psa_admin=; Path=/; Max-Age=0; SameSite=Lax');
  return res.status(200).json({ ok: true });
}
