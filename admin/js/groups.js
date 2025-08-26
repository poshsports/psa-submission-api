import { $, debounce, escapeHtml } from './util.js';
import { fetchGroups, logout } from './api.js';


// ========== Auth & sidebar wiring (standalone Groups page) ==========
// (unchanged)
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
  limit: 50,        // 50 like Active submissions
  offset: 0,
  hasMore: false,
  total: null,      // new: when API returns total, we use it
  view: 'list',     // 'list' | 'detail'
  currentId: null,
  lastItems: [],    // cache last page for quick re-render on back
};
// sequence guard to avoid stale async renders clobbering the UI
let listReqSeq = 0;

// --- make the groups table area behave like Active submissions ---
function ensureScroller() {
  // target the same wrapper you already render
  const wrap = document.querySelector('#view-groups .table-wrap');
  if (!wrap) return;

  // compute available height from its top to bottom of viewport
  const rect = wrap.getBoundingClientRect();
  const avail = window.innerHeight - rect.top - 16; // a little breathing room
  wrap.style.maxHeight = `${Math.max(160, avail)}px`;
  wrap.style.overflow = 'auto';
  wrap.style.webkitOverflowScrolling = 'touch';

  // allow horizontal scroll if columns overflow
  const tbl = wrap.querySelector('table');
  if (tbl) tbl.style.minWidth = '1000px';
}

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

  ensureScroller();
  window.addEventListener('resize', ensureScroller, { passive: true });

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
    // if we know the total, don't overshoot; otherwise rely on hasMore
    if (state.total != null) {
      if (state.offset + state.limit >= state.total) return;
    } else if (!state.hasMore) {
      return;
    }
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
    const payload = await fetchGroups({
      status: state.status,
      q: state.q,
      limit: state.limit,
      offset: state.offset
    });

    // If a newer request started while this one was in-flight, abort applying it
    if (mySeq !== listReqSeq) return;

    const items = payload?.items || payload?.groups || payload?.data || [];
    const limit = Number(payload?.limit ?? state.limit);
    const offset = Number(payload?.offset ?? state.offset);
    const total = (payload?.total != null ? Number(payload.total) : null);
    const hasMoreFromApi = payload?.hasMore ?? payload?.has_more;

    state.lastItems = Array.isArray(items) ? items : [];
    state.limit = limit;
    state.offset = offset;
    state.total = (total != null && !Number.isNaN(total)) ? total : null;

    // hasMore logic: prefer explicit flag; else infer
    if (hasMoreFromApi != null) {
      state.hasMore = !!hasMoreFromApi;
    } else if (state.total != null) {
      state.hasMore = (state.offset + state.lastItems.length) < state.total;
    } else {
      state.hasMore = state.lastItems.length === state.limit; // heuristic
    }

    if (!$body) return;

    if (!state.lastItems.length) {
      $body.innerHTML = `<tr><td colspan="6" class="note">No groups found.</td></tr>`;
      const prev = $('gprev'), next = $('gnext');
      if (prev) prev.disabled = state.offset <= 0;
      if (next) next.disabled = true;
      if ($count) $count.textContent = '';
      ensureScroller();
      return;
    }

    const rows = state.lastItems.map(row => {
      const id    = String(row.id ?? '').trim();
      const code  = escapeHtml(row.code || '');
      const status = escapeHtml(row.status || '');
      const notes  = escapeHtml(row.notes  || '');
      const cnt = Number(row.submission_count ?? row.members ?? row.member_count ?? 0);
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
    if (next) {
      next.disabled = state.total != null
        ? (state.offset + state.lastItems.length) >= state.total
        : !state.hasMore;
    }

    // Counter text like the submissions page:
    if ($count) {
      const start = state.offset + 1;
      const end = state.offset + state.lastItems.length;
      if (state.total != null) {
        $count.textContent = `Showing ${start}–${end} of ${state.total}`;
      } else {
        // fallback when API doesn’t return total
        $count.textContent = `Showing ${start}–${end}${state.hasMore ? '+' : ''}`;
      }
    }

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

    ensureScroller();
  } catch (e) {
    if ($body) $body.innerHTML = `<tr><td colspan="6" class="note">Error: ${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
    ensureScroller();
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
// (unchanged except for tiny formatting nits)
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

    // --- date-only helper for any ISO/ts value ---
    const toYMD = (val) => {
      if (!val) return '';
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;  // already YYYY-MM-DD
      try { return new Date(s).toISOString().slice(0, 10); } catch { return s.slice(0, 10); }
    };

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

    const CARD_COLS = [
      { label: 'Created',    fmt: (c) => safe(c._created_on || '') },
      { label: 'Submission', fmt: (c) => safe(c.submission_id) },
      {
        label: 'Card',
        fmt: (c) => {
          const desc = (c.card_description && String(c.card_description).trim())
            ? safe(c.card_description) : '';
          if (desc) return desc;
          const bits = [c.year, c.brand, c.set, c.player, c.card_number, c.variation]
            .filter(v => v != null && String(v).trim() !== '')
            .map(v => safe(v));
          return bits.join(' · ') || '—';
        }
      },
      { label: 'Break date',   fmt: (c) => safe(c._break_on || '') },
      { label: 'Break #',      fmt: (c) => safe(c.break_number   || '') },
      { label: 'Break channel',fmt: (c) => safe(c.break_channel  || '') },
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

    // Build rows: prefer cards; if none, fall back to members/submissions only
    const memberOrder = new Map(members.map((m, i) => [String(m.submission_id), i]));

    const rowsData = (Array.isArray(cards) && cards.length > 0)
      // cards come from API; add _created_on if missing
      ? cards.map(r => ({ ...r, _created_on: r._created_on || toYMD(r.created_at) }))
      : members.map(m => {
          const sid = String(m.submission_id || '');
          const sub = subById.get(sid) || {};
          const createdFrom = sub.created_at || m.created_at || null;
          return {
            // shape it like a "card" row so CARD_COLS formats it
            created_at: createdFrom,
            _created_on: toYMD(createdFrom),
            submission_id: sid,
            status: sub.status || '',
            grading_service: sub.grading_service || '',
            year: '',
            brand: '',
            set: '',
            player: '',
            card_number: '',
            variation: '',
            notes: m.note || '',
            card_index: 0
          };
        });

    // Keep rows aligned to member order, then by card_index if present
    rowsData.sort((a, b) => {
      const oa = memberOrder.get(String(a.submission_id)) ?? 0;
      const ob = memberOrder.get(String(b.submission_id)) ?? 0;
      if (oa !== ob) return oa - ob;
      return (a.card_index ?? 0) - (b.card_index ?? 0);
    });

    // Build the table HTML
    const table = `
      <table class="data-table" cellspacing="0" cellpadding="0" style="width:100%">
        <thead><tr>${CARD_COLS.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${
            rowsData.length
              ? rowsData.map(r => `<tr>${CARD_COLS.map(col => `<td>${col.fmt(r)}</td>`).join('')}</tr>`).join('')
              : `<tr><td colspan="${CARD_COLS.length}" class="note">No members.</td></tr>`
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
      ensureScroller();
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
    window.location.replace('/admin');
  }
}

document.addEventListener('DOMContentLoaded', bootGroupsPage);
