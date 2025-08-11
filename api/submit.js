// ----- helpers -----
function utf8ToB64(str) {
  try { return btoa(unescape(encodeURIComponent(str))); }
  catch { return ''; }
}

// 1) Save base payload locally for the confirmation UI
try {
  sessionStorage.setItem('psaSubmissionPayload', JSON.stringify(payload));
} catch {}

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
    submissionId = j?.submission_id || j?.submission?.[0]?.submission_id || null;
  } else {
    console.warn('Pre-submit to Supabase failed with status', pre.status);
  }
} catch (e) {
  console.warn('Pre-submit to Supabase threw', e);
}

// 2b) Persist id for post-checkout updater
try {
  if (submissionId) sessionStorage.setItem('psaSubmissionId', submissionId);
} catch {}

// 3) Carry the id + (optionally) compact payload through checkout as cart attributes
const payloadWithId = { ...payload, submission_id: submissionId || undefined };

let b64 = '';
try {
  const json = JSON.stringify(payloadWithId);
  const maybeB64 = utf8ToB64(json);
  // Avoid cart attribute truncation risk; only include if small enough
  if (maybeB64 && maybeB64.length < 240) b64 = maybeB64;
} catch { /* ignore */ }

try {
  const res = await fetch('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      attributes: {
        psa_eval: 'true',
        psa_submission_id: submissionId || '',
        // keep optional and compact; your post-checkout script can rely on submission_id instead
        ...(b64 ? { psa_payload_b64: b64 } : {})
      }
    })
  });
  if (!res.ok) console.warn('Cart attributes not accepted', res.status);
} catch (e) {
  console.warn('Failed to set cart attributes for eval payload', e);
}

// 4) Add eval product + go to checkout
const qty = Number(payload?.cards) > 0 ? Number(payload.cards) : 1;
const qtyEl = document.getElementById('evaluation-product-qty');
if (qtyEl) qtyEl.value = String(qty);

const form = document.getElementById('evaluation-charge-form');

// Safety: Ensure action/method/return_to are correct
if (form) {
  form.action = '/cart/add';
  form.method = 'POST';
  const rt = form.querySelector('input[name="return_to"]');
  if (rt) rt.value = '/checkout';
  form.submit();
}

return;
