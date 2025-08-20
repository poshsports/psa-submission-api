// /admin/js/groups.js
import { $, debounce, escapeHtml } from './util.js';
import { fetchGroups, fetchGroup, fetchSubmission, logout } from './api.js';
import * as tbl from './table.js';


// ========== Auth & sidebar wiring (standalone Groups page) ==========
async function doLogout(e){
  e?.preventDefault?.();
  try { await logout(); } catch {}
  window.location.replace('/admin'); // leave
}
function ensureSignoutWired(){
  const el = $('sidebar-signout');
  if (!el) return;
  el.addEventListener('click', doLogout);
  el.onclick = doLogout;
}
function wireSidebarNav(){
  $('nav-active')?.addEventListener('click', (e) => { e.preventDefault(); window.location.assign('/admin'); });
  $('nav-groups')?.classList?.add('active');
}

// ========== Local state ==========
let state = {
  status: null,     // 'Draft' | 'ReadyToShip' | 'AtPSA' | 'Returned' | 'Closed' | null
  q: '',
  limit: 20,
  offset: 0,
  hasMore: false,
  view: 'list',     // 'list' | 'detail'
  currentId: null,
  lastItems: [],    // cache last page for quick re-render on back
};
// sequence guard to avoid stale async renders clobbering the UI
let listReqSeq = 0;

// Public entry (idempotent mount)
export function showGroupsView() {
  const root = $('view-groups');
  if (!root) return;

  // Safer than innerHTML='' — removes children + their listeners in one go
  root.replaceChildren();
  root.classList.remove('hide');

  if (state.view === 'detail' && state.currentId) {
    renderDetail(root, state.currentId);
  } else {
    state.view = 'list';
    renderList(root);
  }
}

// ========== List View ==========
async function renderList(root) {
  root.innerHTML = `
    <div class="topbar">
      <h2 style="margin:0">Groups</h2>
      <div class="note">Read-only (create/add/remove coming later)</div>
    </div>

    <div class="filters" style="display:flex;gap:10px;align-items:center;margin:12px 0 8px">
      <input id="gq" type="text" placeholder="Search code or notes…" value="${escapeHtml(state.q)}" style="min-width:220px">
      <select id="gstatus">
        <option value="">All statuses</option>
        <option ${sel('Draft')}>Draft</option>
        <option ${sel('ReadyToShip')}>ReadyToShip</option>
        <option ${sel('AtPSA')}>AtPSA</option>
        <option ${sel('Returned')}>Returned</option>
        <option ${sel('Closed')}>Closed</option>
      </select>
      <span class="note" id="gcount"></span>
      <div style="flex:1"></div>
      <button id="gprev" class="ghost">Prev</button>
      <button id="gnext" class="ghost">Next</button>
    </div>

    <div class="table-wrap">
      <table class="data-table" id="gtbl" cellspacing="0" cellpadding="0" style="width:100%">
        <thead>
          <tr>
            <th style="width:140px">Code</th>
            <th style="width:140px">Status</th>
            <th style="width:120px">Members</th>
            <th>Notes</th>
            <th style="width:180px">Updated</th>
            <th style="width:180px">Created</th>
          </tr>
        </thead>
        <tbody id="gtbody">
          <tr><td colspan="6" class="note">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  `;

  // Wire filters
  const $q = $('gq');
  const $s = $('gstatus');
  const deb = debounce(() => {
    state.q = $q.value.trim();
    state.offset = 0;
    refreshList();
  }, 250);

  $q?.addEventListener('input', deb);
  $s?.addEventListener('change', () => {
    const v = $s.value.trim();
    state.status = v || null;
    state.offset = 0;
    refreshList();
  });

  $('gprev')?.addEventListener('click', () => {
    if (state.offset <= 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    refreshList();
  });
  $('gnext')?.addEventListener('click', () => {
    if (!state.hasMore) return;
    state.offset = state.offset + state.limit;
    refreshList();
  });

  await refreshList();
}

function sel(v) { return state.status === v ? 'selected' : ''; }

async function refreshList() {
  const mySeq = ++listReqSeq;

  const $body = $('gtbody');
  const $count = $('gcount');
  if ($body) $body.innerHTML = `<tr><td colspan="6" class="note">Loading…</td></tr>`;
  if ($count) $count.textContent = '';

  try {
    const { items, hasMore, limit, offset } = await fetchGroups({
      status: state.status,
      q: state.q,
      limit: state.limit,
      offset: state.offset
    });

    // If a newer request started while this one was in-flight, abort applying it
    if (mySeq !== listReqSeq) return;

    state.hasMore = !!hasMore;
    state.limit = limit;
    state.offset = offset;
    state.lastItems = items || [];

    if (!$body) return;

    if (!items || items.length === 0) {
      $body.innerHTML = `<tr><td colspan="6" class="note">No groups found.</td></tr>`;
      const prev = $('gprev'), next = $('gnext');
      if (prev) prev.disabled = state.offset <= 0;
      if (next) next.disabled = true;
      if ($count) $count.textContent = '';
      return;
    }

    const rows = items.map(row => {
      const code = escapeHtml(row.code || '');
      const status = escapeHtml(row.status || '');
      const notes = escapeHtml(row.notes || '');
      const cnt = Number(row.submission_count || 0);
      const updated = fmtTs(row.updated_at);
      const created = fmtTs(row.created_at);

     return `
  <tr class="clickable" data-code="${code}" title="Open ${code}">
    <td><strong>${code}</strong></td>
    <td>${status}</td>
    <td>${cnt}</td>
    <td>${notes}</td>
    <td>${updated}</td>
    <td>${created}</td>
  </tr>
`;

    }).join('');

    $body.innerHTML = rows;

    const prev = $('gprev'), next = $('gnext');
    if (prev) prev.disabled = state.offset <= 0;
    if (next) next.disabled = !state.hasMore;

    const start = state.offset + 1;
    const end = state.offset + state.lastItems.length + (state.hasMore ? '+' : '');
    if ($count) $count.textContent = `Showing ${start}–${end}`;

    // Row click -> detail
$body.querySelectorAll('tr.clickable').forEach(tr => {
  tr.addEventListener('click', () => {
    const code = tr.getAttribute('data-code');
    if (!code) return;
    state.view = 'detail';
    state.currentId = code;
    const root = $('view-groups');
    if (root) renderDetail(root, code);
  });
});


  } catch (e) {
    if ($body) $body.innerHTML = `<tr><td colspan="6" class="note">Error: ${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
  }
}

function fmtTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString();
  } catch { return String(ts); }
}

// ========== Detail View ==========
async function renderDetail(root, code) {
  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <button id="gback" class="ghost">← Back</button>
      <h2 style="margin:0">Group</h2>
      <span class="note">Read-only</span>
      <div style="flex:1"></div>
      <a id="open-subs" href="/admin/index.html">Open Active submissions</a>
    </div>
    <div id="gdetail">Loading…</div>
  `;

  $('gback')?.addEventListener('click', () => {
    state.view = 'list';
    state.currentId = null;
    renderList(root);
  });

  const $box = $('gdetail');
  try {
    // API expects code (e.g., "GRP-0005")
    const grp = await fetchGroup(code);
    const safe = (v) => escapeHtml(String(v ?? ''));

    const codeOut    = safe(grp?.code);
    const statusOut  = safe(grp?.status);
    const notesOut   = safe(grp?.notes);
    const shippedOut = fmtTs(grp?.shipped_at) || '—';
    const returnedOut= fmtTs(grp?.returned_at) || '—';
    const updatedOut = fmtTs(grp?.updated_at) || '';
    const createdOut = fmtTs(grp?.created_at) || '';

    // Fetch member submissions (full details) and normalize them
    const members = Array.isArray(grp?.members) ? grp.members : [];
    const ids = members
      .map(m => (m?.submission_id ? String(m.submission_id).trim() : ''))
      .filter(Boolean);

    let subRows = [];
    if (ids.length) {
      const uniq = Array.from(new Set(ids));
      const fetched = await Promise.all(uniq.map(id => fetchSubmission(id).catch(() => null)));
      subRows = fetched
        .filter(Boolean)
        .map(r => tbl.normalizeRow(r));
    }

    // Columns to mirror the main Submissions table at a glance
    const COLS = [
      { key: 'created_at',       label: 'Created',        fmt: (r) => fmtTs(r.created_at) },
      { key: 'submission_id',    label: 'Submission',     fmt: (r) => safe(r.submission_id) },
      { key: 'customer_email',   label: 'Email',          fmt: (r) => safe(r.customer_email) },
      { key: 'status',           label: 'Status',         fmt: (r) => safe(r.status) },
      { key: 'cards',            label: 'Cards',          fmt: (r) => String(Number(r.cards||0)) },
      { key: 'evaluation',       label: 'Evaluation',     fmt: (r) => (r.evaluation_bool ? 'Yes' : 'No') },
      { key: 'grand',            label: 'Grand',          fmt: (r) => `$${(Number(r.grand)||0).toLocaleString()}` },
      { key: 'grading_service',  label: 'Grading Service',fmt: (r) => safe(r.grading_service) },
    ];

    const tableHead = `
      <thead>
        <tr>
          ${COLS.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}
        </tr>
      </thead>
    `;

    const tableBody = subRows.length
      ? `<tbody>
          ${subRows.map(r => `
            <tr>
              ${COLS.map(c => `<td>${c.fmt(r)}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>`
      : `<tbody><tr><td colspan="${COLS.length}" class="note">No members.</td></tr></tbody>`;

    if ($box) {
      $box.innerHTML = `
        <div class="card" style="padding:12px;border:1px solid #eee;border-radius:12px;background:#fff;margin-bottom:14px">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
            <div><div class="note">Code</div><div><strong>${codeOut}</strong></div></div>
            <div><div class="note">Status</div><div>${statusOut}</div></div>
            <div><div class="note">Shipped</div><div>${shippedOut}</div></div>
            <div><div class="note">Returned</div><div>${returnedOut}</div></div>
            <div><div class="note">Updated</div><div>${updatedOut}</div></div>
            <div><div class="note">Created</div><div>${createdOut}</div></div>
          </div>
          <div style="margin-top:10px">
            <div class="note">Notes</div>
            <div>${notesOut || '—'}</div>
          </div>
        </div>

        <div class="table-wrap">
          <table class="data-table" cellspacing="0" cellpadding="0" style="width:100%">
            ${tableHead}
            ${tableBody}
          </table>
        </div>
      `;
    }
  } catch (e) {
    if ($box) $box.innerHTML = `<div class="note">Error loading group: ${escapeHtml(e.message || 'Unknown error')}</div>`;
  }
}


// ===== Boot for Groups page =====
function bootGroupsPage(){
  ensureSignoutWired();
  wireSidebarNav();

  const authed = /(?:^|;\s*)psa_admin=/.test(document.cookie);
  const loginEl = document.getElementById('login');
  const shellEl = document.getElementById('shell');

  const authNote = document.getElementById('auth-note');
  if (authNote) authNote.textContent = authed ? 'passcode session' : 'not signed in';
  const authNoteTop = document.getElementById('auth-note-top');
  if (authNoteTop) authNoteTop.textContent = authed ? 'passcode session' : 'not signed in';

  // Groups page is read-only and behind pass cookie the same as /admin
  if (authed) {
    if (loginEl) loginEl.classList.add('hide');
    if (shellEl) shellEl.classList.remove('hide');
    showGroupsView();
  } else {
    // If you want a dedicated login on the groups page, you can redirect or show the same login shell.
    // For now, redirect to /admin for login.
    window.location.replace('/admin');
  }
}

document.addEventListener('DOMContentLoaded', bootGroupsPage);
