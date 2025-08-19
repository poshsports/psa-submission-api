// api/debug-cookies.js (ESM)
export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    cookieHeader: req.headers?.cookie || req.headers?.Cookie || null
  });
}
export const config = { runtime: 'nodejs' };
