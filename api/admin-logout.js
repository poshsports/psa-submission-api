// Clear admin cookie
module.exports = async (_req, res) => {
  res.setHeader('Set-Cookie', [
    'psa_admin=; Path=/; Max-Age=0; SameSite=Lax'
  ]);
  return res.status(200).json({ ok: true });
};
