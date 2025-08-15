// DOM + helpers
export const $ = (id) => document.getElementById(id);
export const show = (id) => $(id).classList.remove('hide');
export const hide = (id) => $(id).classList.add('hide');
export const hasCookie = (name) => document.cookie.split(';').some(v => v.trim().startsWith(name + '='));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// formatters
export function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function fmtDate(iso){ try { if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return ''; return d.toLocaleString(); } catch { return ''; } }
export function fmtMoney(n){ return `$${(Number(n)||0).toLocaleString()}`; }
export function fmtNum(n){ return `${Number(n)||0}`; }
export function fmtCode(s){ const str = String(s ?? ''); return str ? `<code>${escapeHtml(str)}</code>` : ''; }
