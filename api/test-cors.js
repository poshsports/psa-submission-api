// /api/test-cors.js
export default function handler(req, res) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin || '';
  const okOrigin = !allowedOrigins.length || allowedOrigins.includes(origin);

  // so caches don't mix different Origin responses
  res.setHeader('Vary', 'Origin');

  // --- Preflight (OPTIONS) ---
  if (req.method === 'OPTIONS') {
    if (!okOrigin) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  // --- Actual request ---
  if (!okOrigin) {
    return res.status(403).json({
      success: false,
      message: `Origin ${origin} not allowed`,
      allowedOrigins
    });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  return res.status(200).json({
    success: true,
    message: 'CORS check passed!',
    method: req.method,
    origin,
    allowedOrigins
  });
}
