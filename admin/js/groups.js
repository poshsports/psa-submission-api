// /admin/js/groups.js
import { $, escapeHtml } from './util.js';
import { fetchGroups, fetchGroup } from './api.js';

function fmt(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function ensureContainer() {
  let root = $('view-groups');
  if (!root) {
    root = document.createElement('div');
    root.id = 'view-groups';
    root.style.padding = '12px';
    document.body.appendChild(root);
  }
  return root;
}

/* ---------------- Drawer ---------------- */
function ensureGroupDrawer() {
  if ($('group-backdrop')) return;

  const back = document.createElement('div');
  back.id = 'group-backdrop';
  back.className = 'details-backdrop'; // reuse existing styles
  back.setAttribute('aria-hidden','true');
  back.innerHTML = `
    <div class="details-panel" role="dialog" aria-modal="true" aria-labelledby="group-title">
      <div class="details-head">
        <div id="group-title" class="sheet-title">Group</div>
        <button id="group-close" class="btn" type="button">Close</button>
      </div>
      <div id="group-body" class="details-body">
        <div class="loading">Loading…</div>
      </div>
      <div class="details-foot">
        <div></div>
        <button id="group-close-2" class="btn" type="button">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(back);

  const panel = back.querySelector('.details-panel');
  $('group-close')?.addEventListener('click', closeGroupDrawer);
  $('group-close-2')?.addEventListener('click', closeGroupDrawer);
  back.addEventListener('mousedown', (e) => { if (!panel.contains(e.target)) closeGroupDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGroupDrawer(); });
}

function openGroupDrawer() {
  ensureGroupDrawer();
  const back = $('group-backdrop');
  back.classList.add('show');
  back.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('group-close')?.focus({ preventScroll: true });
}

function closeGroupDrawer() {
  const back = $('group-backdrop');
  if (!back) return;
  back.classList.remove('show');
  back.setAttribute('aria-hidden','true');
  document.body.style.overflow = '';
}

/* ------------- Detail render ------------- */
function renderGroupHeader(g) {
  return `
    <div class="info-grid">
      <div class="info"><div class="info-label">Code</div><div class="info-value"><span class="pill">${escapeHtml(g.code)}</span></div></div>
      <div class="info"><div class="info-label">Status</div><div class="info-value"><span class="pill">${escapeHtml(g.status)}</span></div></div>
      <div class="info"><div class="info-label">Count</div><div class="info-value">${Number(g.submission_count||0)}</div></div>
      <div class="info"><div class="info-label">Shipped</div><div class="info-value">${escapeHtml(fmt(g.shipped_at))}</div></div>
      <div class="info"><div class="info-label">Returned</div><div class="info-value">${escapeHtml(fmt(g.returned_at))}</div></div>
      <div class="info"><div class="info-label">Updated</div><div class="info-value">${escapeHtml(fmt(g.updated_at))}</div></div>
      <div class="info span-2"><div class="info-label">Notes</div><div class="info-value">${escapeHtml(g.notes || '')}</div></div>
    </div>
  `;
}

function renderMembers(members) {
  if (!Array.isArray(members) || !members.length) {
    return `<div style="margin-top:12px;color:#64748b">No members in this group.</div>`;
  }
  const rows = members.map(m => `
    <tr>
      <td style="padding:6px 10px;text-align:right;width:70px">${m.position}</td>
      <td style="padding:6px 10px"><code>${escapeHtml(String(m.submission_id).toLowerCase())}</code></td>
    </tr>
  `).join('');
  return `
    <h3 class="sheet-subhead" style="margin:14px 0 6px">Members (${members.length})</h3>
    <div style="overflow:auto;border:1px solid #eee;border-radius:8px;background:#fff">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead style="background:#fafafa;border-bottom:1px solid #eee">
          <tr>
            <th style="text-align:right;padding:8px 10px">#</th>
            <th style="text-align:left;padding:8px 10px">Submission</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function openGroupDetail(id) {
  openGroupDrawer();
  const title = $('group-title');
  const body  = $('group-body');
  if (title) title.textContent = `Group ${id.slice(0,8)}`;
  if (body)  body.innerHTML = `<div class="loading">Loading…</div>`;

  try {
    const r = await fetchGroup(id);
    if (r?.notFound) {
      body.innerHTML = `<div class="error">Group not found.</div>`;
      return;
    }
    const g = r?.group || {};
    if (title && g.code) title.textContent = `Group ${g.code}`;
    body.innerHTML = renderGroupHeader(g) + renderMembers(g.members || []);
  } catch (e) {
    body.innerHTML = `<div class="error">Failed to load: ${escapeHtml(e?.message || 'error')}</div>`;
  }
}

/* ------------- List view ------------- */
export async function showGroupsView() {
  const root = ensureContainer();
  root.innerHTML = `<div>Loading groups…</div>`;

  let resp;
  try {
    resp = await fetchGroups({ limit: 50, offset: 0 });
  } catch (e) {
    root.innerHTML = `<div style="color:#b91c1c">Failed to load groups: ${escapeHtml(e?.message || 'error')}</div>`;
    return;
  }

  const items = Array.isArray(resp?.items) ? resp.items : [];
  if (!items.length) {
    root.innerHTML = `<div>No groups yet.</div>`;
    return;
  }

  const rows = items.map(g => `
    <tr data-id="${escapeHtml(g.id)}" class="grp-row" style="cursor:pointer">
      <td style="padding:8px 10px">${escapeHtml(g.code || '')}</td>
      <td style="padding:8px 10px">${escapeHtml(g.status || '')}</td>
      <td style="padding:8px 10px;text-align:right">${Number.isFinite(g.submission_count) ? g.submission_count : ''}</td>
      <td style="padding:8px 10px">${fmt(g.shipped_at)}</td>
      <td style="padding:8px 10px">${fmt(g.returned_at)}</td>
      <td style="padding:8px 10px">${fmt(g.updated_at)}</td>
      <td style="padding:8px 10px;color:#64748b">${escapeHtml(g.notes || '')}</td>
    </tr>
  `).join('');

  root.innerHTML = `
    <h2 style="margin:0 0 10px">Groups</h2>
    <div class="note" style="margin:0 0 12px;color:#64748b">Read-only. Click a row to see members.</div>
    <div style="overflow:auto;border:1px solid #eee;border-radius:8px;background:#fff">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead style="background:#fafafa;border-bottom:1px solid #eee">
          <tr>
            <th style="text-align:left;padding:8px 10px">Code</th>
            <th style="text-align:left;padding:8px 10px">Status</th>
            <th style="text-align:right;padding:8px 10px">Count</th>
            <th style="text-align:left;padding:8px 10px">Shipped</th>
            <th style="text-align:left;padding:8px 10px">Returned</th>
            <th style="text-align:left;padding:8px 10px">Updated</th>
            <th style="text-align:left;padding:8px 10px">Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  root.querySelectorAll('tr.grp-row').forEach(tr => {
    tr.addEventListener('click', () => openGroupDetail(tr.getAttribute('data-id')));
  });
}
