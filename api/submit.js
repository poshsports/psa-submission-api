// /api/submit.js
export default async function handler(req, res) {
  // CORS (unchanged)
  res.setHeader('Access-Control-Allow-Origin', 'https://poshsports.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  const {
    // existing fields
    customer_email,
    date,
    cards,
    evaluation,
    address,
    totals,
    status = 'Received',
    card_info,

    // NEW (optional): used to update an existing pending row later
    submission_id
  } = req.body;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    // Build the row we send to Supabase
    const row = {
      customer_email,
      date,
      cards,
      evaluation,
      address,
      totals,
      status,
      card_info
    };

    // If caller provided submission_id, include it so we can upsert on that unique key
    if (submission_id) row.submission_id = submission_id;

    // Prefer header "resolution=merge-duplicates" turns POST into an UPSERT when the table
    // has a UNIQUE constraint (make sure submissions.submission_id is UNIQUE).
    const response = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        // return=representation => send back the inserted/updated row
        // resolution=merge-duplicates => UPSERT on unique keys present in payload
        'Prefer': 'return=representation,resolution=merge-duplicates'
      },
      body: JSON.stringify(row)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));

    return res.status(200).json({ success: true, submission: data });
  } catch (err) {
    return res.status(500).json({ error: 'Submission failed', details: err.message });
  }
}
