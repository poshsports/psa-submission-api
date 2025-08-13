// lib/getSubmissionsByCustomer.js
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Fetch all submissions for a given Shopify customer id (numeric).
 */
async function getSubmissionsByCustomer(shopifyCustomerId) {
  const { data, error } = await supabase
    .from('psa_submissions')
    .select(`
      submission_id,
      created_at,
      submitted_at_iso,
      cards,
      card_count,
      quantity,
      items,
      status,
      totals,
      grading_total,
      amount_cents,
      total,
      number,
      submission_no,
      id,
      ref,
      code,
      shopify_customer_id
    `)
    .eq('shopify_customer_id', shopifyCustomerId)
    // prefer submitted_at_iso if you set it on insert
    .order('submitted_at_iso', { ascending: false });

  if (error) throw error;
  return data || [];
}

module.exports = { getSubmissionsByCustomer };
