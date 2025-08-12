// api/test-cors.js
export default function handler(req, res) {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

  const origin = req.headers.origin || '';

  if (allowedOrigins.length && !allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    return res.status(403).json({ 
      success: false,
      message: `Origin ${origin} not allowed`,
      allowedOrigins
    });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.json({ 
    success: true, 
    message: 'CORS check passed!',
    origin,
    allowedOrigins
  });
}
