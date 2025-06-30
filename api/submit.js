export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  const {
    customer_email,
    date,
    cards,
    evaluation,
    address,
    totals,
    status = 'Received'
  } = req.body;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        customer_email,
        date,
        cards,
        evaluation,
        address,
        totals,
        status
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));

    return res.status(200).json({ success: true, submission: data });
  } catch (err) {
    return res.status(500).json({ error: 'Submission failed', details: err.message });
  }
}

