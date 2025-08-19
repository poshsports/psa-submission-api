// /admin/js/table.js
import { $, escapeHtml } from './util.js';
import { COLUMNS } from './columns.js';

// ===== table state =====
export let allRows = [];
export let viewRows = [];
export let sortKey = 'created_at';
export let sortDir = 'desc';
export let pageSize = 50;
export let pageIndex = 0;

// expose alias to match callers that use tbl.rows
export { allRows as rows };

// --- paging helpers (ESM-safe) ---
export function setPageIndex(i = 0) {
  pageIndex = Math.max(0, i | 0);
}
export function nextPage() {
  const totalPages = Math.max(1, Math.ceil(viewRows.length / pageSize));
  pageIndex = Math.min(pageIndex + 1, totalPages - 1);
}
export function prevPage() {
  pageIndex = Math.max(0, pageIndex - 1);
}
export function getPageIndex() {
  return pageIndex;
}

export function setSort(key, dir) {
  if (key) sortKey = key;
  if (dir) sortDir = dir;
}
export function setRows(rows) {
  allRows = Array.isArray(rows) ? rows : [];
  pageIndex = 0; // reset paging when data set changes
}
export function getSort() {
  return { sortKey, sortDir };
}

// ===== helpers =====
function parseMs(v){
  if (!v) return null;
  const ms = Date.parse(v);
  if (!Number.isNaN(ms)) return ms;
  // very lenient fallback (e.g., "2024-07-20 13:00:00")
  const ms2 = Date.parse(String(v).replace(' ', 'T'));
  return Number.isNaN(ms2) ? null : ms2;
}

// ===== row normalization (stable shape for table) =====
export function normalizeRow(r){
  const evalAmtNum = Number(
    (r.evaluation ?? 0) ||
    (r.eval_line_sub ?? 0) ||
    (r?.totals?.evaluation ?? 0)
  ) || 0;
  const evalBool = evalAmtNum > 0;

  const created_at =
    r.created_at ||
    r.inserted_at ||
    r.submitted_at_iso ||
    r.submitted_at ||
    '';

  const grading_service = String(
    r.grading_service ?? r.grading_services ?? r.grading_servi ?? r.service ?? r.grading ?? ''
  ).trim();

  const row = {
    submission_id: r.submission_id || r.id || '',
    customer_email: r.customer_email || r.customer_em || r.email || '',
    cards: Number(r.cards ?? (Array.isArray(r.card_info) ? r.card_info.length : 0)) || 0,
    evaluation_bool: evalBool,
    evaluation: evalBool ? 'Yes' : 'No',
    grand: Number(r?.totals?.grand ?? r.grand_total ?? r.total ?? 0) || 0,
    status: r.status || '',
    grading_service,
    created_at,
    paid_at_iso: r.paid_at_iso || '',
    paid_amount: Number(r.paid_amount || 0) || 0,
    shopify_order_name: r.shopify_order_name || ''
  };

  // cache parsed timestamp for filtering/sorting
  row.created_at_ms = parseMs(created_at);
  row.paid_at_ms = parseMs(row.paid_at_iso);

  return row;
}

// ===== header render (no drag here; drag only in Columns panel) =====
export function renderHead(order, hidden){
  const hiddenSet = new Set(hidden || []);
  const head = $('subsHead');

  head.innerHTML = `
    <tr>
      ${order.map(key => {
        const col = COLUMNS.find(c => c.key === key);
        if (!col) return '';
        const caretId = 'car-' + key;

        // inline center + optional hide flag (keeps data-hidden marker)
        const attrs = hiddenSet.has(key)
          ? ' style="text-align:center;vertical-align:middle;display:none" data-hidden="1"'
          : ' style="text-align:center;vertical-align:middle"';

        return (
          '<th class="' + (col.sortable ? 'sortable' : '') + '" data-key="' + key + '"' + attrs + '>' +
            '<span class="th-label">' + escapeHtml(col.label) + '</span>' +
            (col.sortable ? '<span class="caret" id="' + caretId + '"></span>' : '') +
          '</th>'
        );
      }).join('')}
    </tr>
  `;

  // Sorting click handlers
  head.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) sortDir = (sortDir === 'asc') ? 'desc' : 'asc';
      else { sortKey = key; sortDir = 'desc'; }
      applyFilters();
      paintCarets();
    });
  });

  paintCarets();
}

export function paintCarets(){
  document.querySelectorAll('#subsHead .caret').forEach(el => el.textContent = '');
  const el = document.getElementById('car-' + sortKey);
  if (el) el.textContent = sortDir === 'asc' ? '▲' : '▼';
}
function getSelectedStatuses() {
  const sel = $('fStatus');
  if (!sel) return [];
  // collect selected <option>s, normalize, and ignore any "all"
  return Array.from(sel.selectedOptions || [])
    .map(o => String(o.value || '').trim().toLowerCase())
    .filter(v => v && v !== 'all');
}
// ===== core: filter + sort + paginate =====
export function applyFilter

  // determine visible columns from header
  const ths = Array.from(document.querySelectorAll('#subsHead th[data-key]'))
    .filter(th => th.style.display !== 'none');
  const visibleKeys = ths.map(th => th.dataset.key);

  // filter (search + status + evaluation + service + date)
  viewRows = allRows.filter(r => {
    if (q) {
      const matchText =
        (r.customer_email && r.customer_email.toLowerCase().includes(q)) ||
        (r.submission_id && String(r.submission_id).toLowerCase().includes(q));
      if (!matchText) return false;
    }

  if (statuses.length) {
    const st = String(r.status || '').trim().toLowerCase();
    if (!statuses.includes(st)) return false;
  }


    if (evalFilter) {
      if (evalFilter === 'yes' && !r.evaluation_bool) return false;
      if (evalFilter === 'no'  &&  r.evaluation_bool) return false;
    }

    if (fService) {
      if ((r.grading_service || '') !== fService) return false;
    }

    if (fromMs != null || toMs != null) {
      const ts = r.created_at_ms ?? parseMs(r.created_at);
      if (ts != null) {
        if (fromMs != null && ts < fromMs) return false;
        if (toMs   != null && ts > toMs)   return false;
      }
    }

    return true;
  });

  // sort
  const dir = sortDir === 'asc' ? 1 : -1;
  viewRows.sort((a, b) => {
    if (sortKey === 'evaluation') {
      return ((a.evaluation_bool ? 1 : 0) - (b.evaluation_bool ? 1 : 0)) * dir;
    }
    if (['cards', 'grand', 'paid_amount'].includes(sortKey)) {
      return (Number(a[sortKey]) - Number(b[sortKey])) * dir;
    }
    if (sortKey === 'created_at') {
      const na = a.created_at_ms ?? parseMs(a.created_at) ?? 0;
      const nb = b.created_at_ms ?? parseMs(b.created_at) ?? 0;
      return (na - nb) * dir;
    }
    if (sortKey === 'paid_at_iso') {
      const na = a.paid_at_ms ?? parseMs(a.paid_at_iso) ?? 0;
      const nb = b.paid_at_ms ?? parseMs(b.paid_at_iso) ?? 0;
      return (na - nb) * dir;
    }
    return String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')) * dir;
  });

  // clamp page index and render
  pageIndex = Math.min(pageIndex, Math.floor(Math.max(0, viewRows.length - 1) / pageSize));
  renderTable(visibleKeys);
}

/* ---------- NEW: row click/keyboard wiring ---------- */
function openDetailsFor(id, friendly) {
  if (!id) return;
  // Preferred: a global provided by admin.app.js
  if (typeof window.__openAdminDetails === 'function') {
    window.__openAdminDetails(id, friendly);
    return;
  }
  // Fallback: fire a custom event other code can listen for
  try {
    window.dispatchEvent(new CustomEvent('psa:open-details', {
      detail: { id, friendly }
    }));
  } catch (e) {
    console.warn('[psa-admin] No details opener wired; id =', id);
  }
}

function wireRowOpenHandlers(tbody) {
  if (!tbody) return;

  // prevent stacking handlers on re-render
  if (tbody.__rowClick) tbody.removeEventListener('click', tbody.__rowClick);
  if (tbody.__rowKey)   tbody.removeEventListener('keydown', tbody.__rowKey);

  const onClick = (e) => {
    const tr = e.target.closest('tr.rowlink');
    if (!tr || tr.closest('table') !== tbody.closest('table')) return;

    // ignore clicks on interactive children if you add any later
    const tag = (e.target.tagName || '').toLowerCase();
    if (['a','button','input','select','textarea','label'].includes(tag)) return;

    const id = tr.getAttribute('data-id');
    const friendly = tr.querySelector('td:nth-child(2)')?.textContent?.trim() || id;
    openDetailsFor(id, friendly);
  };

  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const tr = e.target.closest('tr.rowlink');
      if (!tr) return;
      e.preventDefault();
      const id = tr.getAttribute('data-id');
      const friendly = tr.querySelector('td:nth-child(2)')?.textContent?.trim() || id;
      openDetailsFor(id, friendly);
    }
  };

  tbody.addEventListener('click', onClick);
  tbody.addEventListener('keydown', onKey);
  tbody.__rowClick = onClick;
  tbody.__rowKey   = onKey;
}
/* ---------- END NEW ---------- */

export function renderTable(visibleKeys){
  const body = $('subsTbody');
  const emptyEl = $('subsEmpty');

  // If the table body isn't mounted yet, safely bail (e.g., mid-login transition)
  if (!body) {
    const total0 = viewRows.length;
    const start0 = pageIndex * pageSize;
    const end0   = Math.min(start0 + pageSize, total0);
    const pageRange0 = $('page-range');
    if (pageRange0) pageRange0.textContent = total0 ? `${start0 + 1}–${end0} of ${total0}` : '0–0 of 0';
    const pill0 = $('countPill');
    if (pill0) pill0.textContent = String(viewRows.length);
    return;
  }

  if (!viewRows.length) {
    body.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hide');
  } else {
    if (emptyEl) emptyEl.classList.add('hide');
  }

  const colMap = new Map(COLUMNS.map(c => [c.key, c]));

  // paging
  const start = pageIndex * pageSize;
  const end = Math.min(start + pageSize, viewRows.length);
  const rows = viewRows.slice(start, end);

  body.innerHTML = rows.map(r => {
    const id = String(r.submission_id || r.id || '').trim();
    return `
      <tr
        class="rowlink"
        data-id="${escapeHtml(id)}"
        tabindex="0"
        role="button"
        aria-label="Open details for submission ${escapeHtml(id)}"
      >
        ${visibleKeys.map(key => {
          const col = colMap.get(key);
          const val = r[key];
          const out = col?.format ? col.format(val) : escapeHtml(String(val ?? ''));
          return `<td style="text-align:center;vertical-align:middle">${out}</td>`;
        }).join('')}
      </tr>
    `;
  }).join('');

  // 🔌 attach row open handlers after every render
  wireRowOpenHandlers(body);

  // pagination UI (null-safe)
  const total = viewRows.length;
  const pageRange = $('page-range');
  if (pageRange) pageRange.textContent = `${total ? (start + 1) : 0}–${end} of ${total}`;
  const prevBtn = $('prev-page');
  if (prevBtn) prevBtn.disabled = pageIndex === 0;
  const nextBtn = $('next-page');
  if (nextBtn) nextBtn.disabled = end >= total;

  // update count pill
  const pill = $('countPill');
  if (pill) pill.textContent = String(total);
}
