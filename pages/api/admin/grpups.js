import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // server-only
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const status = (req.query.status as string) || null;
  const q = (req.query.q as string) || null;
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);

  const { data, error } = await supabase.rpc('get_groups_page', {
    p_status: status,
    p_q: q,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json(data);
}
