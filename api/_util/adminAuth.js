// api/_util/adminAuth.js
const ADMIN_COOKIE_NAME = 'psa_admin';   // <- match your existing admin endpoints
const ADMIN_COOKIE_OK_VALUE = '1';       // or set to null to just require presence

exports.requireAdmin = function requireAdmin(req) {
  const val = (req.cookies && req.cookies[ADMIN_COOKIE_NAME]) || null;
  if (!val) return false;
  if (ADMIN_COOKIE_OK_VALUE == null) return true;
  return val === ADMIN_COOKIE_OK_VALUE;
};
