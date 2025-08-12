// /api/proxy/ping.js
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send('pong');
}
