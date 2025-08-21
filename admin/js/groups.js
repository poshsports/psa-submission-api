// /admin/js/groups.js
import { $, debounce, escapeHtml } from './util.js';
import { fetchGroups, logout } from './api.js';


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
  const id    = String(row.id ?? '').trim();
  const code  = escapeHtml(row.code || '');
  const status = escapeHtml(row.status || '');
  const notes  = escapeHtml(row.notes  || '');
  const cnt    = Number(row.submission_count || 0);
  const updated = fmtTs(row.updated_at);
  const created = fmtTs(row.created_at);

  return `
    <tr class="clickable" data-id="${escapeHtml(id)}" data-code="${code}" title="Open ${code}">
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
    const id   = tr.getAttribute('data-id');
    const code = tr.getAttribute('data-code'); // for display only
    if (!id) return;
    state.view = 'detail';
    state.currentId = id;
    const root = $('view-groups');
    if (root) renderDetail(root, id, code);
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
async function renderDetail(root, id, codeHint) {
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
  // Fetch the group (include all the data we need in one go)
  const res = await fetch(
    `/api/admin/groups/${encodeURIComponent(id)}?include=members,submissions,cards`,
    { credentials: 'same-origin' }
  );
  if (!res.ok) throw new Error('group fetch failed');
  const payload = await res.json();
  if (payload && payload.ok === false) throw new Error(payload.error || 'Group fetch failed');
  const grp = payload?.group ?? payload;

  const safe = (v) => escapeHtml(String(v ?? ''));

  // Header fields
  const codeOut     = safe(grp?.code || codeHint || '');
  const statusOut   = safe(grp?.status || '');
  const notesOut    = safe(grp?.notes || '');
  const shippedOut  = fmtTs(grp?.shipped_at)  || '—';
  const returnedOut = fmtTs(grp?.returned_at) || '—';
  const updatedOut  = fmtTs(grp?.updated_at)  || '—';
  const createdOut  = fmtTs(grp?.created_at)  || '—';

  // Data returned by API
  const members = Array.isArray(grp?.members) ? grp.members : [];
  const submissions = Array.isArray(grp?.submissions) ? grp.submissions : [];
  const cards = Array.isArray(grp?.cards) ? grp.cards : [];

  // Map submissions for quick lookup (status/email/grading_service fallback)
  const subById = new Map(submissions.map(s => [String(s.id), s]));

  // Define card-level columns
  const CARD_COLS = [
    { label: 'Created',    fmt: (c) => fmtTs(c.created_at) },
    { label: 'Submission', fmt: (c) => safe(c.submission_id) },
    {
      label: 'Card',
      fmt: (c) => {
        const bits = [
          c.year, c.brand, c.set, c.player, c.card_number, c.variation
        ]
          .filter(v => v != null && String(v).trim() !== '')
          .map(v => safe(v));
        return bits.join(' · ') || '—';
      }
    },
    {
      label: 'Status',
      fmt: (c) => safe(
        c.status ||
        subById.get(String(c.submission_id))?.status ||
        ''
      )
    },
    {
      label: 'Service',
      fmt: (c) => safe(
        c.grading_service ||
        subById.get(String(c.submission_id))?.grading_service ||
        ''
      )
    },
    { label: 'Notes', fmt: (c) => safe(c.notes || '') },
  ];

  // Keep card list aligned to member order, then by card_index if present
const memberOrder = new Map(members.map((m, i) => [String(m.submission_id), i]));
cards.sort((a, b) => {
  const oa = memberOrder.get(String(a.submission_id)) ?? 0;
  const ob = memberOrder.get(String(b.submission_id)) ?? 0;
  if (oa !== ob) return oa - ob;
  return (a.card_index ?? 0) - (b.card_index ?? 0);
});

  // Build the table HTML for cards
  const table = `
    <table class="data-table" cellspacing="0" cellpadding="0" style="width:100%">
      <thead><tr>${CARD_COLS.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${
          cards.length
            ? cards.map(c => `<tr>${CARD_COLS.map(col => `<td>${col.fmt(c)}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${CARD_COLS.length}" class="note">No Cards.</td></tr>`
        }
      </tbody>
    </table>
  `;

  // Render
  if ($box) {
    $box.innerHTML = `
      <div class="card" style="padding:12px;border:1px solid #eee;border-radius:12px;background:#fff;margin-bottom:14px">
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
          <div><div class="note">Code</div><div><strong>${codeOut}</strong></div></div>
          <div><div class="note">Status</div><div>${statusOut || '—'}</div></div>
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
        ${table}
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
