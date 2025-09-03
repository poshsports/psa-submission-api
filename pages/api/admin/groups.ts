import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const status =
    typeof req.query.status === 'string' && req.query.status.trim() !== ''
      ? (req.query.status as string)
      : null;

  const q =
    typeof req.query.q === 'string' && req.query.q.trim() !== ''
      ? (req.query.q as string)
      : null;

  const limit = Math.min(200, Number(req.query.limit ?? 50));
  const offset = Number(req.query.offset ?? 0);

  const { data, error } = await supabase.rpc('get_groups_page', {
    p_status: status,
    p_q: q,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}
