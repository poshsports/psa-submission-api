// /admin/js/billing.app.js
import { $, debounce } from './util.js';
import * as tbl from './billing.table.js';
import { COLUMNS } from './billing.columns.js';

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
          // the attribute was HTML-escaped in markup; browser gives raw string back
          const bundle = JSON.parse(bundleJson);
          openBuilder(bundle);
          return;
        } catch {
          // fallback to email fetch if JSON parse fails
        }
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
    // global delegate is already installed, no need to rewire
  });

  installGlobalDelegates();
}

// ---------- Entry ----------
export async function showBillingView() {
  // Header + initial render
  tbl.renderHead(COLUMNS.map(c => c.key), []);

  let rows = await fetchToBill();
  if (!Array.isArray(rows)) rows = [];
  const normalized = rows.map(normalizeBundle).map(tbl.normalizeRow);

  tbl.setRows(normalized);
  tbl.applyFilters();
  tbl.renderTable();
  ensureSelectionColumn();

  wireCoreUI();
}
