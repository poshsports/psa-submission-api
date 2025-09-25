// /api/admin/users/invite.js
import { sb } from '../../_util/supabase.js';
import { requireAdmin } from '../../_util/adminAuth.js';

function originFrom(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
    const ok = await requireAdmin(req, res); if (!ok) return;

    const { email, name, role } = await readBody(req);
    const em = String(email || '').trim().toLowerCase();
    const nm = String(name || '').trim();
    const rl = ['owner','manager','staff'].includes(String(role || '').trim()) ? role : 'staff';
    if (!em) return res.status(400).json({ error: 'email is required' });

    const client = sb();

    // Try to send a Supabase invite (password setup link)
    let authUserId = null;
    try {
      const invite = await client.auth.admin.inviteUserByEmail(em, {
        data: { name: nm, role: rl },
        redirectTo: `${originFrom(req)}/admin`
      });
      if (invite?.data?.user?.id) authUserId = invite.data.user.id;
    } catch (e) {
      // If the user already exists in Auth, we still proceed to upsert admin_users.
      // Supabase throws an error we can safely ignore for this case.
    }

    // Upsert into our admin_users table
    const { error: upErr } = await client
      .from('admin_users')
      .upsert({ email: em, name: nm, role: rl, is_active: true, auth_user_id: authUserId }, { onConflict: 'email' });

    if (upErr) return res.status(500).json({ error: 'Failed to save admin user', details: upErr.message });

    return res.status(200).json({ ok: true, invited: true, email: em });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
