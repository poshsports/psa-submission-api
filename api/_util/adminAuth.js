// api/_util/adminAuth.js (ESM)
export const ADMIN_COOKIE_NAME = 'psa_admin';   // match your existing admin cookie
export const ADMIN_COOKIE_OK_VALUE = '1';       // set to null to only require presence

export function requireAdmin(req) {
  const val = (req.cookies && req.cookies[ADMIN_COOKIE_NAME]) || null;
  if (!val) return false;
  if (ADMIN_COOKIE_OK_VALUE == null) return true;
  return val === ADMIN_COOKIE_OK_VALUE;
}
