// /admin/js/billing.columns.js
import { fmtDate, fmtMoney, escapeHtml } from './util.js';

export const COLUMNS = [
  { key:'customer',    label:'Customer',    sortable:true,  align:'left',
    format: (val, row) => {
      const name = escapeHtml(row.customer_name || '');
      const email = escapeHtml(row.customer_email || '');
      return `${name ? name + ' • ' : ''}<code>${email}</code>`;
    }
  },
  { key:'subs_count',  label:'Submissions', sortable:true,  align:'right',
    format: (v, row) => String(row.submissions?.length || v || 0)
  },
  { key:'groups',      label:'Groups',      sortable:false, align:'left',
    format: (v, row) => {
      const gs = Array.isArray(row.groups) ? row.groups : [];
      if (!gs.length) return '';
      return gs.map(g => `<span class="chip">${escapeHtml(String(g))}</span>`).join(' ');
    }
  },
  { key:'cards',       label:'Cards',       sortable:true,  align:'right' },
  { key:'returned',    label:'Returned',    sortable:true,  align:'left',
    format: (v, row) => fmtDate(row.returned_newest || row.returned || v)
  },
  { key:'age_days',    label:'Age (days)',  sortable:true,  align:'right' },
  { key:'est_total',   label:'Est. Total',  sortable:true,  align:'right',
    format: (v, row) => (row.est_total_cents != null ? fmtMoney(row.est_total_cents/100) : '<span class="muted">Preview</span>')
  },
  { key:'actions',     label:'Actions',     sortable:false, align:'left',
    format: (v, row) => {
      const cid = encodeURIComponent(row.customer_email || '');
      const dataSubs = encodeURIComponent((row.submissions||[]).map(s => s.submission_id).join(','));
      const disabled = (row.submissions||[]).length ? '' : ' disabled';
      return `
        <div class="row" style="gap:6px;justify-content:flex-start">
          <button class="btn" data-act="preview" data-cid="${cid}" data-subs="${dataSubs}">Preview</button>
          <button class="btn" data-act="create" data-cid="${cid}" data-subs="${dataSubs}"${disabled}>Create Draft</button>
          <button class="btn" data-act="send" data-cid="${cid}" data-subs="${dataSubs}" disabled>Send</button>
          <button class="btn" data-act="snooze" data-cid="${cid}" data-subs="${dataSubs}">Snooze</button>
        </div>`;
    }
  }
];

export const defaultOrder = COLUMNS.map(c => c.key);
export const defaultHidden = [];
