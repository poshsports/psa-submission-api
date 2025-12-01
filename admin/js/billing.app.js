// /admin/js/billing.app.js
import { $, debounce } from './util.js';
import * as tbl from './billing.table.js';
import { COLUMNS } from './billing.columns.js';

// --- Draft auto-create on billing list ---
const PREFILL_ENDPOINT       = '/api/admin/billing/preview/prefill';
const PREVIEW_SAVE_ENDPOINT  = '/api/admin/billing/preview/save';
const CARDS_PREVIEW_ENDPOINT = '/api/admin/billing/cards-preview';
const SEND_ENDPOINT          = '/api/admin/billing/send-invoice';
// Match Invoice Builder's flat shipping for estimates
const SHIPPING_FLAT_CENTS = 500; // $5.00


// read-only views need a little state
let CURRENT_TAB = 'to-send';
const URL_BY_ROWID = new Map(); // key: 'inv:<invoice_id>' -> value: invoice_url


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
function extractNormalizedShipTo(bundle) {
  if (!bundle?.submissions?.length) return null;

  const sub = bundle.submissions[0];
let raw = null;

try {
  raw =
    typeof sub.address === 'string' ? JSON.parse(sub.address) :
    sub.address ? sub.address :
    typeof sub.raw === 'string' ? JSON.parse(sub.raw).address :
    sub.raw?.address ||
    null;
} catch {}


  if (!raw) return null;

  return {
    name:   (raw.name   || '').trim(),
    line1:  (raw.street || raw.line1 || '').trim(),
    line2:  (raw.address2 || raw.line2 || '').trim(),
    city:   (raw.city   || '').trim(),
    region: (raw.state  || raw.region || '').trim(),
    postal: (raw.zip    || raw.postal || '').trim(),
    country:(raw.country || 'US').trim()
  };
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
    const shipTo = extractNormalizedShipTo(b);
const qp = new URLSearchParams({
  subs: subIds.join(','),
  email
});
if (shipTo) qp.set('ship_to', JSON.stringify(shipTo));

const url = `${PREFILL_ENDPOINT}?${qp.toString()}`;

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
    invoice_id: invoiceId,
    items: toSend.map(id => ({ card_id: id, upcharge_cents: 0 })),
    ship_to: extractNormalizedShipTo(b)
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

  const subs = (bundle.submissions || [])
    .map(s => s.submission_id)
    .filter(Boolean);

  const email = (bundle.customer_email || '').trim();
  const rawGroups = bundle.groups || bundle.group_codes || [];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter(Boolean)
    : [rawGroups].filter(Boolean);

  // --- NEW: normalize the bundle's ship_to address ---
  function normalizeShipToFromBundle(b) {
    if (!b || !b.ship_to) return null;
    const a = b.ship_to;
    const obj = {
      name   : a.name   || a.contact || a.full_name || '',
      line1  : a.line1  || a.address1 || a.addr1 || a.street || '',
      line2  : a.line2  || a.address2 || a.addr2 || '',
      city   : a.city   || '',
      region : a.region || a.state || a.province || '',
      postal : a.postal || a.zip || a.postal_code || '',
      country: a.country || 'US'
    };
    const any = Object.values(obj).some(Boolean);
    return any ? obj : null;
  }

  const qp = new URLSearchParams();
  if (subs.length) qp.set('subs', subs.join(','));
  if (email) qp.set('email', email);
  if (groups.length) qp.set('groups', groups.join(','));

  // --- NEW: embed normalized address if present ---
  const shipTo = normalizeShipToFromBundle(bundle);
  if (shipTo) {
    qp.set('ship_to', JSON.stringify(shipTo));
  }

  // Navigate
  window.location.href = `/admin/invoice-builder.html?${qp.toString()}`;
}


// ---------- API ----------
async function fetchToBill(tab = 'to-send') {
  try {
    const qs = new URLSearchParams({ tab });
    const r = await fetch(`/api/admin/billing/to-bill?${qs}`, { credentials: 'same-origin' });
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

async function addServerEstimates(bundles = []) {
  const out = [];

  for (const b of bundles) {
    const email = (b?.customer_email || '').trim();
    const subs  = (Array.isArray(b?.submissions) ? b.submissions : [])
      .map(s => s?.submission_id)
      .filter(Boolean);

    if (!email || !subs.length) { out.push(b); continue; }

    // --- STEP 1: call prefill to get invoice id ---
    let pre = null;
    try {
const shipTo = extractNormalizedShipTo(b);
const qp = new URLSearchParams({
  subs: subs.join(','),
  email
});
if (shipTo) qp.set('ship_to', JSON.stringify(shipTo));

const url = `${PREFILL_ENDPOINT}?${qp.toString()}`;
pre = await fetch(url, { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null);

      console.log('[addServerEstimates]', email, '→ prefill:', pre);
    } catch (err) {
      console.warn('[addServerEstimates] prefill failed:', err);
    }

    // --- STEP 2: if we already have total_cents, use it directly ---
    if (Number.isFinite(Number(pre?.total_cents)) && Number(pre.total_cents) > 0) {
      b.estimated_cents = Number(pre.total_cents);
      out.push(b);
      continue;
    }

       // --- STEP 3: otherwise fetch /api/admin/billing/cards-preview to compute manually ---
    let total = 0;
    try {
      const qs = new URLSearchParams({ subs: subs.join(',') }).toString();
      const resp = await fetch(`${CARDS_PREVIEW_ENDPOINT}?${qs}`, { credentials: 'same-origin' });
      const j = await resp.json().catch(() => ({}));
      console.log('[addServerEstimates] cards-preview payload for', email, j);
      console.table(j?.rows || []);


      const rows = Array.isArray(j?.rows) ? j.rows : [];

      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

// Match cards-preview output fields
const gradeKeys = ['grading_amount','grading_service_cents','grading_cents','unit_cents','price_cents','service_cents'];


      for (const row of rows) {
        const g = gradeKeys.map(k => num(row?.[k])).find(n => n > 0) || 0;
// upcharge field name in cards-preview is upcharge_amount
const u = num(row?.upcharge_amount ?? row?.upcharge_cents ?? row?.upcharge);
total += g + u;

      }

      // If the API exposes a roll-up, prefer it
      const rollup = num(j?.subtotal_cents) || num(j?.totals?.subtotal_cents);
      if (rollup > 0 && rollup !== total) total = rollup;

      // Add flat shipping if anything is billable and no shipping was included
      const shippingFromRows =
        rows.reduce((s, r) => s + num(r?.shipping_cents), 0) ||
        num(j?.shipping_cents) || num(j?.totals?.shipping_cents);

      if (total > 0 && shippingFromRows === 0) {
        total += SHIPPING_FLAT_CENTS; // $5.00
      }
    } catch (err) {
      console.warn('[addServerEstimates] cards-preview failed:', err);
    }

    // Hard fallback if cards-preview had nothing: use prefill items’ upcharges (+$5)
    if (total <= 0) {
      const items = Array.isArray(pre?.items) ? pre.items : [];
      const upcharges = items.reduce((s, it) => s + (Number(it?.upcharge_cents) || 0), 0);
      if (upcharges > 0) total = upcharges + SHIPPING_FLAT_CENTS;
    }

    b.estimated_cents = total > 0 ? total : null;
    console.log('[addServerEstimates] → computed cents:', b.estimated_cents, 'for', email);

    out.push(b);
  }

  return out;
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
    let shipTo = null;
if (bundle?.submissions?.length) {
  shipTo = extractNormalizedShipTo(bundle);
}

const qp = new URLSearchParams({
  subs: subIds.join(','),
  email: em
});
if (shipTo) qp.set('ship_to', JSON.stringify(shipTo));

const url = `${PREFILL_ENDPOINT}?${qp.toString()}`;

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

  // FIXED: use actual existing fields from admin_submissions_v
  // We use last_updated_at → created_at (same fallback as API)
  const returnedNewest = subs.reduce((acc, s) => {
    const t = Date.parse(s.last_updated_at || s.created_at || '');
    if (Number.isNaN(t)) return acc;
    return (acc == null || t > acc) ? t : acc;
  }, null);

  const returnedOldest = subs.reduce((acc, s) => {
    const t = Date.parse(s.last_updated_at || s.created_at || '');
    if (Number.isNaN(t)) return acc;
    return (acc == null || t < acc) ? t : acc;
  }, null);

  const toIso = ms => (ms == null ? null : new Date(ms).toISOString());

  const clientEstimate = estimateRowTotalCents(subs);

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
    est_total_cents: (b.estimated_cents ?? clientEstimate ?? null),
    est_total:       (b.estimated_cents ?? clientEstimate ?? null),

    // Split detection stays the same
    is_split: (b.group_codes || groups).some(g =>
      String(g || '').toLowerCase().includes('split')
    ),
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
function normalizeInvoiceRecord(rec) {
  // rec is returned by /api/admin/billing/to-bill?tab=awaiting|paid
  // Expected fields: invoice_id, invoice_url, customer_email, customer_name,
  // total_cents, groups[], submissions_count/cards_count (optional)
  return {
    id: 'inv:' + String(rec.invoice_id || ''),
    customer_name: rec.customer_name || '',
    customer_email: rec.customer_email || '',
    submissions: [],                      // not used in these tabs
    subs_count: Number(rec.submissions_count || rec.cards_count || 0),
    groups: Array.isArray(rec.groups) ? rec.groups : [],
    cards: Number(rec.cards_count || 0),
    returned_newest: null,
    returned_oldest: null,
    est_total_cents: Number.isFinite(rec.total_cents) ? rec.total_cents : null,
    est_total:       Number.isFinite(rec.total_cents) ? rec.total_cents : null,
    __invoice_url: rec.invoice_url || null, // carry url for click-open
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
  const tr = draftBtn.closest('tr[data-id]');
  if (!tr) return;

  const rowId = String(tr.dataset.id || '');

  // -------- INVOICE-BASED ROW --------
  if (rowId.startsWith('inv:')) {
    const invoiceId = rowId.slice(4);
    draftBtn.disabled = true;
    try {
      const resp = await fetch('/api/admin/billing/create-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ invoice_ids: [invoiceId] })
      });

      const j = await resp.json().catch(() => null);

      if (resp.ok && j?.created?.length) {
        const url = j.created[0].invoice_url;
        if (url) window.open(url, '_blank');
      } else {
        alert('Failed to create draft: ' + (j?.error || 'Unknown error'));
      }
    } finally {
      draftBtn.disabled = false;
    }
    return;
  }

  // -------- LEGACY CUSTOMER-BUNDLE ROW (to-send tab) --------
  const email = extractEmailFromRow(tr);
  if (!email) return;
  draftBtn.disabled = true;
  try {
    const item = await fetchDraftBundleByEmail(email);
    if (item) openBuilder(item);
  } finally {
    draftBtn.disabled = false;
  }
  return;
}


// Row click (ignore controls)
const tr = e.target.closest('tr[data-id]');
if (tr) {
  const isInteractive = e.target.closest('button, a, input, select, textarea, label');
  if (isInteractive) return;

  if (CURRENT_TAB === 'to-send') {
    const email = extractEmailFromRow(tr);
    if (!email) return;
    const item = await fetchDraftBundleByEmail(email);
    if (item) openBuilder(item);
  } else {
    // read-only: open Shopify customer-facing invoice
    const rowId = String(tr.dataset.id || '');
    const url = URL_BY_ROWID.get(rowId);
    if (url) window.open(url, '_blank');
  }
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
// --- Estimate helpers (client-side fallback for "To send")
function estimateCentsForServiceName(name = '') {
  const s = String(name).toLowerCase();

  // match by keywords in your PSA service labels
  if (s.includes('regular'))        return 8500; // $85
  if (s.includes('value - $35') ||
      s.includes('value—$35')   ||  // tolerate different hyphens
      s.includes('value $35'))      return 3500; // $35
  if (s.includes('value bulk') ||
      s.includes('bulk - $28') ||
      s.includes('bulk—$28')  ||
      s.includes('$28/card'))       return 2800; // $28

  return 0; // unknown service → 0
}

function estimateRowTotalCents(subs = []) {
  let total = 0;
  for (const s of subs) {
    const service =
      s?.grading_service || s?.psa_grading || s?.service || '';
    const rate = estimateCentsForServiceName(service);
    const qty  = Number(s?.cards || 0);
    total += rate * (Number.isFinite(qty) ? qty : 0);
  }
  return total > 0 ? total : null;
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
  CURRENT_TAB = tab;

  // Always render the header so columns/layout are stable
  tbl.renderHead(COLUMNS.map(c => c.key), []);

if (tab !== 'to-send') {
  // Read-only lists from the backend
  let recs = await fetchInvoices(tab);
  if (!Array.isArray(recs)) recs = [];

  // normalize and remember urls for click-open
  URL_BY_ROWID.clear();
  const normalized = recs.map(normalizeInvoiceRecord).map(tbl.normalizeRow);
recs.forEach((r) => {
  const rowId = 'inv:' + String(r.invoice_id || '');
  const url = r.view_url || r.invoice_url || null;
  if (url) URL_BY_ROWID.set(rowId, url);
});

  tbl.setRows(normalized);
  tbl.applyFilters();
  tbl.renderTable();
  ensureSelectionColumn();

if (normalized.length === 0) {
  showEmpty(tab === 'awaiting'
    ? 'No invoices awaiting payment.'
    : 'No paid invoices yet.'
  );
} else {
  hideEmpty();
}
  // Keep bulk button disabled in read-only tabs
  const btn = $('btnBatchSend');
  if (btn) { btn.disabled = true; btn.title = 'Coming soon'; }

  wireCoreUI();
  return;
}

  let rows = await fetchToBill();
  if (!Array.isArray(rows)) rows = [];

  // If rows already come from invoices (have invoice_id / estimated_cents),
  // skip extra prefill/cards-preview calls.
  const isInvoiceMode = rows.some(r => r.invoice_id);
  if (!isInvoiceMode) {
    rows = await addServerEstimates(rows);
  }

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
