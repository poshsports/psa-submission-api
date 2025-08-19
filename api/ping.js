// api/ping.js (ESM)
export default function handler(req, res) {
  res.status(200).json({ ok: true, msg: 'pong', method: req.method });
}

// Force Node runtime (not Edge)
export const config = { runtime: 'nodejs18.x' };
