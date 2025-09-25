export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const cookieFlags = 'Path=/; SameSite=Lax; Secure';
res.setHeader('Set-Cookie', [
  `psa_admin=; ${cookieFlags}; Max-Age=0`,
  `psa_admin_session=; ${cookieFlags}; HttpOnly; Max-Age=0`,
]);
  return res.status(200).json({ ok: true });
}
