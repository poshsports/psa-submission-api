// api/ping.js (ESM)
export default function handler(req, res) {
  res.status(200).json({ ok: true, msg: 'pong', method: req.method });
}

// Force Node runtime (valid values: "edge" | "nodejs")
export const config = { runtime: 'nodejs' };
