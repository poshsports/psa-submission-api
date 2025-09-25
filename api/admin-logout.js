export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const cookieFlags = 'Path=/; SameSite=Lax; Secure';
res.setHeader('Set-Cookie', [
  'psa_admin_session=; Path=/; Max-Age=0; SameSite=Lax; Secure',
  'psa_role=; Path=/; Max-Age=0; SameSite=Lax; Secure'
]);
  return res.status(200).json({ ok: true });
}
