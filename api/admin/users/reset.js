// /api/admin/users/reset.js
import { sb } from '../../_util/supabase.js';
import { requireAdmin } from '../../_util/adminAuth.js';

const json = (res, s, p) => (res.status(s).setHeader('Content-Type','application/json'), res.end(JSON.stringify(p)));
const readBody = async (req) => {
  const chunks = []; for await (const ch of req) chunks.push(Buffer.from(ch));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
};
const origin = (req) => `${req.headers['x-forwarded-proto']||'https'}://${req.headers['x-forwarded-host']||req.headers.host}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
 const ok = await requireAdmin(req, res);
if (!ok) return; // 401 already sent by helper

  const { email } = await readBody(req);
  if (!email) return json(res, 400, { error: 'email is required' });

  const client = sb();
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: origin(req) + '/admin/reset'   // adjust to your reset flow route
  });
  if (error) return json(res, 400, { error: 'Failed to send reset', details: error.message });

  return json(res, 200, { ok: true });
}
