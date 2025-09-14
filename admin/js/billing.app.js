// /admin/js/billing.app.js
import { $, debounce } from './util.js';
import * as tbl from './billing.table.js';
import { COLUMNS } from './billing.columns.js';

// minimal API helper (safe no-op if endpoint isn't there yet)
async function fetchToBill(){
  try {
    const r = await fetch('/api/admin/billing/to-bill', { credentials: 'same-origin' });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ([]));
    return Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);
  } catch { return []; }
}

function normalizeBundle(b){
  const subs = Array.isArray(b.submissions) ? b.submissions : [];
  const groups = Array.from(new Set(subs.map(s => s.group_code).filter(Boolean)));
  const cards = subs.reduce((n, s) => n + (Number(s.cards)||0), 0);
  const returnedNewest = subs.reduce((acc, s) => {
    const t = Date.parse(s.returned_at || s.returned || ''); if (Number.isNaN(t)) return acc;
    return (acc == null || t > acc) ? t : acc;
  }, null);
  const returnedOldest = subs.reduce((acc, s) => {
    const t = Date.parse(s.returned_at || s.returned || ''); if (Number.isNaN(t)) return acc;
    return (acc == null || t < acc) ? t : acc;
  }, null);
  const toIso = ms => (ms==null ? null : new Date(ms).toISOString());

  return {
    id: 'cust:' + String(b.customer_email||'').toLowerCase(),
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

function ensureSelectionColumn(){
  const tbody = $('subsTbody'); if (!tbody) return;
  const header = document.getElementById('__selAll');
  const getVisibleRows = () => Array.from(tbody.querySelectorAll('tr[data-id]'));
  const updateSelAllUI = () => {
    const rows = getVisibleRows();
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
  };

  // wire per-row checkboxes
  tbody.addEventListener('change', (e) => {
    const cb = e.target.closest?.('input.__selrow');
    if (!cb) return;
    updateSelAllUI();
  });

  // wire header master checkbox
  if (header && !header.__wired) {
    header.addEventListener('change', () => {
      const rows = getVisibleRows();
      rows.forEach(tr => {
        const cb = tr.querySelector('input.__selrow');
        if (cb) cb.checked = header.checked;
      });
      updateSelAllUI();
    });
    header.__wired = true;
  }

  // update initial
  updateSelAllUI();
}

function wireCoreUI(){
  // search
  const deb = debounce(() => tbl.applyFilters(), 150);
  const q = $('q'); if (q) q.addEventListener('input', deb);

  // pagination
  $('prev-page')?.addEventListener('click', () => { tbl.prevPage(); tbl.renderTable(); ensureSelectionColumn(); });
  $('next-page')?.addEventListener('click', () => { tbl.nextPage(); tbl.renderTable(); ensureSelectionColumn(); });

  // table rendered hook → re-sync selection UI + wire action buttons
  window.addEventListener('psa:table-rendered', () => {
    ensureSelectionColumn();
    wireActionButtons();
  });
}

function wireActionButtons(){
  const tbody = $('subsTbody'); if (!tbody) return;

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const act = btn.getAttribute('data-act');
      const cid = decodeURIComponent(btn.getAttribute('data-cid') || '');
      const subsCsv = decodeURIComponent(btn.getAttribute('data-subs') || '');
      const submission_ids = subsCsv ? subsCsv.split(',').filter(Boolean) : [];
      if (act === 'preview') return doPreview(submission_ids);
      if (act === 'create')  return doCreateDraft(submission_ids);
      if (act === 'send')    return doSend(btn);
      if (act === 'snooze')  return doSnooze(submission_ids);
    }, { once: true });
  });
}

async function doPreview(submission_ids){
  // Placeholder: call preview endpoint (to be implemented)
  alert('Preview not wired yet. ' + submission_ids.join(', '));
}

async function doCreateDraft(submission_ids){
  alert('Create Draft not wired yet. ' + submission_ids.join(', '));
}

async function doSend(btn){
  alert('Send not wired yet.');
}

async function doSnooze(submission_ids){
  alert('Snooze not wired yet.');
}

export async function showBillingView(){
  // Render header
  tbl.renderHead(COLUMNS.map(c => c.key), []);

  // initial data fetch
  let rows = await fetchToBill();
  if (!Array.isArray(rows)) rows = [];
  const normalized = rows.map(normalizeBundle).map(tbl.normalizeRow);

  tbl.setRows(normalized);
  tbl.applyFilters();
  tbl.renderTable();

  wireCoreUI();
}
