// api/_util/adminAuth.js (ESM)
export const ADMIN_COOKIE_NAME = 'psa_admin';   // keep as-is
export const ADMIN_COOKIE_OK_VALUE = '1';       // set to null to only require presence

function parseCookieHeader(h) {
  if (!h) return {};
  // supports "cookie" or "Cookie"
  const raw = Array.isArray(h) ? h.join(';') : String(h);
  return Object.fromEntries(
    raw.split(';')
       .map(s => s.trim())
       .filter(Boolean)
       .map(kv => {
         const idx = kv.indexOf('=');
         return idx === -1 ? [kv, ''] : [kv.slice(0, idx), kv.slice(idx + 1)];
       })
  );
}

export function requireAdmin(req) {
  // Prefer parsed cookies if present; fall back to header parsing
  const byProp = (req.cookies && req.cookies[ADMIN_COOKIE_NAME]) || null;
  if (byProp) {
    if (ADMIN_COOKIE_OK_VALUE == null) return true;
    return byProp === ADMIN_COOKIE_OK_VALUE;
  }

  const cookies = parseCookieHeader(req.headers?.cookie || req.headers?.Cookie);
  const val = cookies[ADMIN_COOKIE_NAME] || null;
  if (!val) return false;
  if (ADMIN_COOKIE_OK_VALUE == null) return true;
  return val === ADMIN_COOKIE_OK_VALUE;
}
