// /admin/js/billing.app.js
import { $, debounce } from './util.js';
import * as tbl from './billing.table.js';
import { COLUMNS } from './billing.columns.js';

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

async function fetchDraftBundleByEmail(email) {
  const url = `/api/admin/billing/to-bill?q=${encodeURIComponent(email)}`;
  try {
    const j = await fetch(url, { credentials: 'same-origin' }).then(r => r.json());
    return j?.items?.[0] || null;
  } catch {
    return null;
  }
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

// ---------- Selection (header checkbox + enabling batch button) ----------
function ensureSelectionColumn() {
  const tbody = $('subsTbody'); if (!tbody) return;
  const header = document.getElementById('__selAll');

  // guard so we don't rewire on every render
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
    const btn = $('btnBatchSend'); if (btn) btn.disabled = checkedCount === 0;
  }

  // initial pass
  // (slight delay to allow DOM to finish painting when table re-renders)
  setTimeout(() => {
    const rows = Array.from(tbody.querySelectorAll('tr[data-id]'));
    const anyChecked = rows.some(tr => tr.querySelector('input.__selrow:checked'));
    const btn = $('btnBatchSend'); if (btn) btn.disabled = !anyChecked;
  }, 0);
}

// ---------- UI wiring ----------
function wireCoreUI() {
  // search
  const q = $('q');
  if (q) q.addEventListener('input', debounce(() => tbl.applyFilters(), 150));

  // pagination
  $('prev-page')?.addEventListener('click', () => { tbl.prevPage(); tbl.renderTable(); ensureSelectionColumn(); });
  $('next-page')?.addEventListener('click', () => { tbl.nextPage(); tbl.renderTable(); ensureSelectionColumn(); });

  // after each render, re-sync selection + (re)attach table event listeners
  window.addEventListener('psa:table-rendered', () => {
    ensureSelectionColumn();
    delegateTableClicks();
  });
}

// Delegate all clicks inside the table body once
function delegateTableClicks() {
  const tbody = $('subsTbody'); if (!tbody) return;
  if (tbody.__clickWired) return;

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="draft"]');
    const tr = e.target.closest('tr[data-id]');

    // Prefer explicit button click
    if (btn) {
      const explicitEmail = (btn.getAttribute('data-email') || '').trim();
      // fallback to the row id
      const email = explicitEmail || extractEmailFromRow(tr);
      if (!email) return;
      btn.disabled = true;
      try { await openPreviewForEmail(email); } finally { btn.disabled = false; }
      return;
    }

    // Row click (ignore clicks on controls/links)
    if (tr) {
      const isInteractive = e.target.closest('button, a, input, select, textarea, label');
      if (isInteractive) return;
      const email = extractEmailFromRow(tr);
      if (!email) return;
      await openPreviewForEmail(email);
    }
  });

  tbody.__clickWired = true;
}

function extractEmailFromRow(tr) {
  if (!tr) return '';
  // rows use id like "cust:someone@example.com"
  const id = String(tr.dataset.id || '');
  if (id.startsWith('cust:')) return id.slice(5);
  // last resort: look for the Customer cell text
  const emailCell = tr.querySelector('td[data-col="customer"]') || tr.cells?.[1];
  return (emailCell?.textContent || '').trim();
}

async function openPreviewForEmail(email) {
  const item = await fetchDraftBundleByEmail(email);
  if (item) {
    // global overlay helper from billing.html
    window.psaOpenDraftPreview?.(item);
  } else {
    alert('Nothing to bill for this customer yet.');
  }
}

// ---------- Entry ----------
export async function showBillingView() {
  // render header
  tbl.renderHead(COLUMNS.map(c => c.key), []);

  // load data
  let rows = await fetchToBill();
  if (!Array.isArray(rows)) rows = [];
  const normalized = rows.map(normalizeBundle).map(tbl.normalizeRow);

  // feed table
  tbl.setRows(normalized);
  tbl.applyFilters();
  tbl.renderTable();

  // wire UI
  wireCoreUI();
}
