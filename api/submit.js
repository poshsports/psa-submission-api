// submit.js (reference, full file)

// ---- config ----
const API_URL = 'https://psa-submission-api.vercel.app/api/submit';

// ---- helpers ----
function utf8ToB64(str) {
  try { return btoa(unescape(encodeURIComponent(str))); }
  catch { return ''; }
}
function nowIso() { return new Date().toISOString(); }

// If your project already has a payload builder, delete this and call psaSubmit(payload) instead.
function buildPsaPayloadFromForm() {
  // Minimal example — keep your existing builder if you already have one
  const qty = Number(document.querySelector('#psaQuantity')?.value || 0);
  const evaluation = !!document.querySelector('#evaluateCards')?.checked;
  const email = (document.querySelector('#customerEmail')?.value || '').trim();

  // NOTE: Keep your real structure (address, card_info, totals, etc.)
  return {
    cards: qty,
    evaluation,
    customer_email: email,
    // ...include your existing fields here
  };
}

// ---- main entry (choose one) ----
// A) If you already have your own submit handler, just call: psaSubmit(payload)
// B) If you want this file to wire the form submit, keep this listener:
(function wireFormIfPresent() {
  const form = document.querySelector('#psaForm');
  if (!form) return; // your project may wire elsewhere

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // If you have your own validation, run it here and return on failure.
    // assume valid:
    const payload = buildPsaPayloadFromForm();

    try {
      await psaSubmit(payload);
    } catch (err) {
      console.error('PSA submit failed', err);
      alert('Unexpected error submitting PSA form.');
    }
  });
})();

// ---- core flow (call this with your existing payload) ----
async function psaSubmit(payload) {
  // 1) Save base payload locally for the confirmation UI
  try { sessionStorage.setItem('psaSubmissionPayload', JSON.stringify(payload)); } catch {}

  // 2) PRE-SUBMIT to Supabase and capture submission_id
  let submissionId = null;
  try {
    const pre = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        status: 'pending_payment',
        submitted_via: 'form_precheckout',
        submitted_at_iso: nowIso()
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
  try { if (submissionId) sessionStorage.setItem('psaSubmissionId', submissionId); } catch {}

  // If evaluation selected → Shopify checkout path; else → direct submit
  if (payload.evaluation === true) {
    await goToCheckoutWithEvalProduct(payload, submissionId);
    return; // IMPORTANT: stop here; final Supabase update happens post-checkout
  }

  // No evaluation → final submit straight to Supabase + redirect
  await finalSubmitNoEval(payload, submissionId);
}

// ---- eval checkout path ----
async function goToCheckoutWithEvalProduct(payload, submissionId) {
  // 3) Carry the id + tiny payload through checkout as cart attributes
  const payloadWithId = { ...payload, submission_id: submissionId || undefined };
  let b64 = '';
  try {
    const json = JSON.stringify(payloadWithId);
    const maybeB64 = utf8ToB64(json);
    if (maybeB64 && maybeB64.length < 240) b64 = maybeB64; // avoid attr size issues
  } catch {}

  try {
    const res = await fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributes: {
          psa_eval: 'true',
          psa_submission_id: submissionId || '',
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
  if (!form) {
    alert('Evaluation form missing. Please refresh and try again.');
    return;
  }
  form.action = '/cart/add';
  form.method = 'POST';
  const rt = form.querySelector('input[name="return_to"]');
  if (rt) rt.value = '/checkout';
  form.submit();
}

// ---- no-eval direct submit ----
async function finalSubmitNoEval(payload, preId) {
  try {
    const finalRes = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        status: 'submitted',
        submitted_via: 'form_no_payment',
        submitted_at_iso: nowIso(),
        pre_submission_id: preId || null
      })
    });

    if (finalRes.ok) {
      window.location.href = '/pages/psa-confirmation';
    } else {
      console.error('Final submit failed', finalRes.status);
      alert('Error submitting PSA form — please try again.');
    }
  } catch (e) {
    console.error('Final submit error', e);
    alert('Unexpected error submitting PSA form.');
  }
}

// Optionally expose psaSubmit if you prefer calling it from your existing code:
window.psaSubmit = psaSubmit;
