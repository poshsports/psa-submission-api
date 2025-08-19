// api/ping.js
module.exports = (req, res) => {
  res.status(200).json({ ok: true, msg: 'pong', method: req.method });
};

// Force Node runtime (not Edge)
module.exports.config = { runtime: 'nodejs18.x' };
