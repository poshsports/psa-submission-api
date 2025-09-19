// /admin/js/billing.app.js
import { $, debounce } from './util.js';
import * as tbl from './billing.table.js';
import { COLUMNS } from './billing.columns.js';

// --- Draft auto-create on billing list ---
const PREFILL_ENDPOINT       = '/api/admin/billing/preview/prefill';
const PREVIEW_SAVE_ENDPOINT  = '/api/admin/billing/preview/save';
const CARDS_PREVIEW_ENDPOINT = '/api/admin/billing/cards-preview';
const SEND_ENDPOINT          = '/api/admin/billing/send-invoice';

// --- New: invoices list endpoint for Awaiting/Paid tabs ---
const INVOICES_ENDPOINT      = '/api/admin/billing/invoices-list';

// --- Tab helpers ---
const VALID_TABS = new Set(['to-send','awaiting','paid']);
function resolveTab(tabArg) {
  const fromArg = (tabArg || '').trim();
  if (VALID_TABS.has(fromArg)) return fromArg;
  const qs = new URLSearchParams(location.search);
  const fromURL = qs.get('tab') || '';
  return VALID_TABS.has(fromURL) ? fromURL : 'to-send';
}
function showEmpty(message) {
  const el = $('subsEmpty');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hide');
}
function hideEmpty() {
  const el = $('subsEmpty');
  if (!el) return;
  el.classList.add('hide');
}

async function ensureDraftForBundle(b) {
  const email  = (b?.customer_email || '').trim();
  const subIds = (Array.isArray(b?.submissions) ? b.submissions : [])
    .map(s => s?.submission_id)
    .filter(Boolean);

  if (!email || !subIds.length) return;

  // 1) Get all card IDs for these submissions
  let cardIds = [];
  try {
    const qs = new URLSearchParams({ subs: subIds.join(',') }).toString();
    const resp = await fetch(`${CARDS_PREVIEW_ENDPOINT}?${qs}`, { credentials: 'same-origin' });
    const j = await resp.json().catch(() => ({}));
    const rows = Array.isArray(j?.rows) ? j.rows : [];
    cardIds = rows.map(r => r?.id || r?.card_id).filter(Boolean);
  } catch {}
  if (!cardIds.length) return;

  // 2) Ask server for the existing draft (if any) scoped to these subs+email
  let prefill = null;
  try {
    const url = `${PREFILL_ENDPOINT}?subs=${encodeURIComponent(subIds.join(','))}&email=${encodeURIComponent(email)}`;
    prefill = await fetch(url, { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null);
  } catch {}

  const invoiceId = prefill?.invoice_id || null;
  const existingIds = new Set(
    Array.isArray(prefill?.items) ? prefill.items.map(it => String(it.card_id)) : []
  );

  // 3) Create or append
  const toSend = (invoiceId == null)
    ? cardIds
    : cardIds.filter(id => !existingIds.has(String(id)));

  if (!toSend.length) return;

  try {
    await fetch(PREVIEW_SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        customer_email: email,
        invoice_id: invoiceId,          // null => create; value => append
        items: toSend.map(id => ({ card_id: id, upcharge_cents: 0 }))
      })
    });
  } catch {}
}

function ensureDraftsForAll(bundles) {
  // fire-and-forget to avoid blocking table render
  bundles.forEach(b => { ensureDraftForBundle(b); });
}

function openBuilder(bundle) {
  if (!bundle) return;

  const subs = (bundle.submissions || []).map(s => s.submission_id).filter(Boolean);
  const email = (bundle.customer_email || '').trim();
  const groups = (bundle.groups || bundle.group_codes || []).filter(Boolean);

  const qp = new URLSearchParams();
  if (subs.length) qp.set('subs', subs.join(','));
  if (email) qp.set('email', email);
  if (groups.length) qp.set('groups', groups.join(','));

  window.location.href = `/admin/invoice-builder.html?${qp.toString()}`;
}

// ---------- API ----------
async function fetchToBill() {
  try {
    const r = await fetch('/api/admin/billing/to-bill', { credentials: 'same-origin' });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ([]));
    return Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);
  } catch {
    return [];
  }
}

// New: list invoices for Awaiting/Paid
async function fetchInvoices(status /* 'awaiting' | 'paid' */) {
  const qs = new URLSearchParams({ status });
  try {
    const r = await fetch(`${INVOICES_ENDPOINT}?${qs.toString()}`, { credentials: 'same-origin' });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    return [];
  }
}

async function fetchDraftBundleByEmail(email) {
  const url = `/api/admin/billing/to-bill?q=${encodeURIComponent(email)}`;
  try {
    const j = await fetch(url, { credentials: 'same-origin' }).then(r => r.json());
    return j?.items?.[0] || null;
  } catch {
    return null;
  }
}

async function sendDraftForEmail(email) {
  const em = (email || '').trim();
  if (!em) return { email: em, ok: false, reason: 'no-email' };

  // 1) Load the current bundle for this customer
  const bundle = await fetchDraftBundleByEmail(em);
  if (!bundle) return { email: em, ok: false, reason: 'bundle-not-found' };

  // 2) Ensure the draft exists / is up-to-date (creates or appends new cards)
  await ensureDraftForBundle(bundle);

  // 3) Resolve the invoice id via prefill (email + subs)
  const subIds = (Array.isArray(bundle.submissions) ? bundle.submissions : [])
    .map(s => s?.submission_id)
    .filter(Boolean);

  if (!subIds.length) return { email: em, ok: false, reason: 'no-subs' };

  let invoiceId = null;
  try {
    const url = `${PREFILL_ENDPOINT}?subs=${encodeURIComponent(subIds.join(','))}&email=${encodeURIComponent(em)}`;
    const pre = await fetch(url, { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null);
    invoiceId = pre?.invoice_id || null;
  } catch {}

  if (!invoiceId) return { email: em, ok: false, reason: 'no-invoice' };

  // 4) Send the invoice
  const res = await fetch(SEND_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ invoice_id: invoiceId, customer_email: em })
  });

  return { email: em, ok: res.ok, reason: res.ok ? null : 'send-failed' };
}

async function batchSendSelected() {
  const btn = $('btnBatchSend');
  if (!btn) return;

  const selectedTrs = Array
    .from(document.querySelectorAll('#subsTbody tr[data-id]'))
    .filter(tr => tr.querySelector('input.__selrow')?.checked);

  const emails = selectedTrs.map(extractEmailFromRow).filter(Boolean);
  if (!emails.length) return;

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';

  const results = [];
  for (const email of emails) {
    try {
      results.push(await sendDraftForEmail(email));
    } catch {
      results.push({ email, ok: false, reason: 'unexpected-error' });
    }
  }

  btn.textContent = 'Done';
  setTimeout(() => { window.location.reload(); }, 400);
}

// ---------- Normalization for table rows ----------
function normalizeBundle(b) {
  const subs = Array.isArray(b.submissions) ? b.submissions : [];
  const groups = Array.from(new Set(subs.map(s => s.group_code).filter(Boolean)));
  const cards = subs.reduce((n, s) => n + (Number(s.cards) || 0), 0);

  const returnedNewest = subs.reduce((acc, s) => {
    const t = Date.parse(s.returned_at || s.returned || '');
    if (Number.isNaN(t)) return acc;
    return (acc == null || t > acc) ? t : acc;
  }, null);

  const returnedOldest = subs.reduce((acc, s) => {
    const t = Date.parse(s.returned_at || s.returned || '');
    if (Number.isNaN(t)) return acc;
    return (acc == null || t < acc) ? t : acc;
  }, null);

  const toIso = ms => (ms == null ? null : new Date(ms).toISOString());

  return {
    id: 'cust:' + String(b.customer_email || '').toLowerCase(),
    customer_name: b.customer_name || '',
    customer_email: b.customer_email || '',
    submissions: subs,
    subs_count: subs.length,
    groups,
    cards,
    returned_newest: toIso(returnedNewest),
    returned_oldest: toIso(returnedOldest),
    est_total_cents: b.estimated_cents ?? null,
  };
}

// New: normalize invoice records from invoices-list into the same table shape
function normalizeInvoiceRow(rec) {
  return {
    id: 'inv:' + String(rec.invoice_id || ''),
    customer_name: '', // not needed for now
    customer_email: rec.customer_email || '',
    submissions: Array.isArray(rec.submissions) ? rec.submissions : [],
    subs_count: rec.subs_count ?? (rec.submissions?.length || 0),
    groups: rec.group_code ? [rec.group_code] : [],
    cards: Number(rec.cards || 0),
    // Reuse the "est_total_cents" column to show invoice total
    est_total_cents: (Number.isFinite(rec.total_cents) ? rec.total_cents
                     : Number.isFinite(rec.subtotal_cents) ? rec.subtotal_cents
                     : null),
    // Reuse returned_* columns for date sorting/display
    returned_newest: rec.updated_at || null,
    returned_oldest: rec.created_at || null,
    status: rec.status || '',
  };
}

// ---------- Selection (header checkbox + enabling batch button) ----------
function ensureSelectionColumn() {
  const tbody = $('subsTbody'); if (!tbody) return;
  const header = document.getElementById('__selAll');

  if (!tbody.__selWired) {
    tbody.addEventListener('change', (e) => {
      if (!e.target.closest?.('input.__selrow')) return;
      updateSelAllUI();
    });
    tbody.__selWired = true;
  }

  if (header && !header.__wired) {
    header.addEventListener('change', () => {
      const rows = Array.from(tbody.querySelectorAll('tr[data-id]'));
      rows.forEach(tr => {
        const cb = tr.querySelector('input.__selrow');
        if (cb) cb.checked = header.checked;
      });
      updateSelAllUI();
    });
    header.__wired = true;
  }

  function updateSelAllUI() {
    const rows = Array.from(tbody.querySelectorAll('tr[data-id]'));
    const total = rows.length;
    const checkedCount = rows.reduce((n, tr) => {
      const cb = tr.querySelector('input.__selrow');
      return n + (cb && cb.checked ? 1 : 0);
    }, 0);
    if (header) {
      header.indeterminate = checkedCount > 0 && checkedCount < total;
      header.checked = total > 0 && checkedCount === total;
    }
    const btn = $('btnBatchSend'); if (btn) btn.disabled = true; // coming soon
  }

  setTimeout(updateSelAllUI, 0);
}

// ---------- Robust click delegation (buttons & row) ----------
function installGlobalDelegates() {
  if (document.__psaBillingClicksWired) return;
  document.__psaBillingClicksWired = true;

  document.addEventListener('click', async (e) => {
    const tbody = $('subsTbody');
    if (!tbody) return;
    const insideTable = e.target.closest('#subsTbody, #subsTbody *');
    if (!insideTable) return;

    // Prefer explicit "Create Draft" button
    const draftBtn =
      e.target.closest('[data-action="draft"]') ||
      e.target.closest('.js-open-draft'); // legacy

    if (draftBtn) {
      // legacy button may carry a data-bundle with JSON
      const bundleJson = draftBtn.getAttribute('data-bundle');
      const explicitEmail = (draftBtn.getAttribute('data-email') || '').trim();

      if (bundleJson) {
        try {
          const bundle = JSON.parse(bundleJson);
          openBuilder(bundle);
          return;
        } catch {}
      }

      const tr = draftBtn.closest('tr[data-id]');
      const email = explicitEmail || extractEmailFromRow(tr);
      if (!email) return;
      draftBtn.disabled = true;
      try { const item = await fetchDraftBundleByEmail(email); if (item) openBuilder(item); }
      finally { draftBtn.disabled = false; }
      return;
    }

    // Row click (ignore controls)
    const tr = e.target.closest('tr[data-id]');
    if (tr) {
      const isInteractive = e.target.closest('button, a, input, select, textarea, label');
      if (isInteractive) return;
      const email = extractEmailFromRow(tr);
      if (!email) return;
      const item = await fetchDraftBundleByEmail(email);
      if (item) openBuilder(item);
    }
  });
}

function extractEmailFromRow(tr) {
  if (!tr) return '';
  const id = String(tr.dataset.id || '');
  if (id.startsWith('cust:')) return id.slice(5);

  // Fallbacks: try to find a "customer" cell or the second cell
  const byDataCol = tr.querySelector('td[data-col="customer"]');
  if (byDataCol) return (byDataCol.textContent || '').trim();

  const cells = tr.querySelectorAll('td');
  if (cells.length) return (cells[1]?.textContent || cells[0]?.textContent || '').trim();

  return '';
}

// ---------- Core UI wiring ----------
function wireCoreUI() {
  const q = $('q');
  if (q) q.addEventListener('input', debounce(() => tbl.applyFilters(), 150));

  $('prev-page')?.addEventListener('click', () => { tbl.prevPage(); tbl.renderTable(); ensureSelectionColumn(); });
  $('next-page')?.addEventListener('click', () => { tbl.nextPage(); tbl.renderTable(); ensureSelectionColumn(); });

  window.addEventListener('psa:table-rendered', () => {
    ensureSelectionColumn();
  });

  installGlobalDelegates();
}

// ---------- Entry ----------
export async function showBillingView(tabArg) {
  const tab = resolveTab(tabArg); // 'to-send' | 'awaiting' | 'paid'

  // Always render the header so columns/layout are stable
  tbl.renderHead(COLUMNS.map(c => c.key), []);

  if (tab !== 'to-send') {
    let rows = await fetchInvoices(tab); // awaiting | paid
    const normalized = rows.map(normalizeInvoiceRow).map(tbl.normalizeRow);

    tbl.setRows(normalized);
    tbl.applyFilters();
    tbl.renderTable();
    ensureSelectionColumn();

    if (!normalized.length) {
      showEmpty(tab === 'awaiting'
        ? 'No invoices awaiting payment.'
        : 'No paid invoices yet.'
      );
    } else {
      hideEmpty();
    }

    // Keep the "Create & Send" bulk button disabled (coming soon)
    const btn = $('btnBatchSend');
    if (btn) { btn.disabled = true; btn.title = 'Coming soon'; }

    wireCoreUI();
    return;
  }

  // --- Existing "To send" behavior (unchanged) ---
  let rows = await fetchToBill();
  if (!Array.isArray(rows)) rows = [];
  const normalized = rows.map(normalizeBundle).map(tbl.normalizeRow);

  // Auto-create drafts for any customers that don't have one yet
  ensureDraftsForAll(rows);

  tbl.setRows(normalized);
  tbl.applyFilters();
  tbl.renderTable();
  ensureSelectionColumn();
  hideEmpty();

  wireCoreUI();
}
