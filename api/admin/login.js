// /api/admin/login.js  (Vercel Node serverless function)

import { createClient } from '@supabase/supabase-js';

// Use the SAME cookie name the old passcode route used.
// If you’re not sure, open the old /api/admin-login file and copy the name.
// Defaulting to 'psa_admin' here:
const COOKIE_NAME = process.env.ADMIN_COOKIE_NAME || 'psa_admin';

// 1 day
const COOKIE_MAX_AGE = 60 * 60 * 24;

function send(res, status, json, headers = {}) {
  res.statusCode = status;
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(json));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  // Parse JSON body (compatible with Vercel/Node)
  let body = {};
  try {
    if (typeof req.body === 'object' && req.body) {
      body = req.body;
    } else if (typeof req.body === 'string') {
      body = JSON.parse(req.body || '{}');
    } else {
      // raw body
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }
  } catch (e) {
    return send(res, 400, { error: 'Invalid JSON body' });
  }

  const { email, password } = body || {};
  if (!email || !password) {
    return send(res, 400, { error: 'Email and password are required' });
  }

  // Env sanity
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return send(res, 500, { error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env' });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // 1) Sign in with Supabase Auth
    const { data: authData, error: signInErr } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr) {
      return send(res, 401, { error: 'Invalid email or password' });
    }

    // 2) Confirm this user is in your admin table and is active
    const userId = authData.user?.id;
    const { data: adminRow, error: adminErr } = await supabase
      .from('admin_users')
      .select('id, role, is_active')
      .eq('auth_user_id', userId)           // best match by auth id
      .maybeSingle();

    if (adminErr) {
      return send(res, 500, { error: 'Failed to check admin table' });
    }
    if (!adminRow || adminRow.is_active === false) {
      return send(res, 403, { error: 'No access' });
    }

    // 3) Set the same cookie your old passcode route set (keep the app logic unchanged)
    // Simple flag cookie (the app already trusts the presence of this cookie).
    const cookie = [
      `${COOKIE_NAME}=1`,
      `HttpOnly`,
      `Path=/`,
      `SameSite=Lax`,
      `Max-Age=${COOKIE_MAX_AGE}`,
      `Secure`
    ].join('; ');

    res.setHeader('Set-Cookie', cookie);

    return send(res, 200, { ok: true });
  } catch (e) {
    // Surface a readable reason in JSON; your console logs will still show stack traces on Vercel
    return send(res, 500, { error: 'Login handler crashed' });
  }
}
