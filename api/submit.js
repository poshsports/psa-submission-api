// 1) Save base payload locally for the confirmation UI
try { sessionStorage.setItem('psaSubmissionPayload', JSON.stringify(payload)); } catch {}

// 2) PRE-SUBMIT to Supabase and capture submission_id
let submissionId = null;
try {
  const pre = await fetch('https://psa-submission-api.vercel.app/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      status: 'pending_payment',
      submitted_via: 'form_precheckout',
      submitted_at_iso: new Date().toISOString()
    })
  });
  if (pre.ok) {
    const j = await pre.json().catch(() => ({}));
    submissionId = j.submission_id || j?.submission?.[0]?.submission_id || null;
  } else {
    console.warn('Pre-submit to Supabase failed with status', pre.status);
  }
} catch (e) {
  console.warn('Pre-submit to Supabase threw', e);
}

// 3) Carry the id + payload through checkout as order attributes
const payloadWithId = { ...payload, submission_id: submissionId || undefined };
let b64 = '';
try { b64 = utf8ToB64(JSON.stringify(payloadWithId)); } catch {}

try {
  await fetch('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      attributes: {
        psa_eval: 'true',
        psa_submission_id: submissionId || '',    // <-- IMPORTANT
        psa_payload_b64: b64
      }
    })
  });
} catch (e) {
  console.warn('Failed to set cart attributes for eval payload', e);
}

// 4) Add eval product + go to checkout (unchanged below)
document.getElementById('evaluation-product-qty').value = qty;
const form = document.getElementById('evaluation-charge-form');
form.action = '/cart/add';
form.method = 'POST';
form.querySelector('input[name="return_to"]').value = "/checkout";
form.submit();
return;
