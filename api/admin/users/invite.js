// /api/admin/users/invite.js
import { sb } from '../../_util/supabase.js';
import { requireAdmin, requireOwner } from '../../_util/adminAuth.js';
import { createClient } from '@supabase/supabase-js';
const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); // SERVICE ROLE

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
    const me = await requireOwner(req, res);
if (!me) return;

    const { email, name, role } = await readBody(req);
    const em = String(email || '').trim().toLowerCase();
    const nm = String(name || '').trim();
    const rl = ['owner','manager','staff'].includes(String(role || '').trim()) ? role : 'staff';
    if (!em) return res.status(400).json({ error: 'email is required' });

    const client = sb(); // keep for DB writes

    let authUserId = null;
    const invite = await adminClient.auth.admin.inviteUserByEmail(em, {
      data: { name: nm, role: rl },
      redirectTo: `${originFrom(req)}/admin`
    });

    if (invite.error) {
      // If the user already exists in Auth, inviteUserByEmail returns an error.
      // We’ll try to fetch the existing auth user by querying auth.users and continue.
      const { data: existing, error: exErr } = await adminClient
        .from('auth.users')
        .select('id')
        .eq('email', em)
        .maybeSingle();

      if (!existing?.id) {
        // Bubble the actual error so you can see it in the UI/logs
        return res.status(400).json({ error: 'Invite failed', details: invite.error.message });
      }
      authUserId = existing.id; // user already exists, proceed to upsert admin_users
    } else {
      authUserId = invite?.data?.user?.id || null;
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
