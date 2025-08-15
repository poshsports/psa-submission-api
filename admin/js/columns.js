import { fmtDate, fmtCode, fmtNum, fmtMoney } from './util.js';

export const COLUMNS = [
  { key:'created_at',          label:'Created',          sortable:true,  align:'left',  format: fmtDate },
  { key:'submission_id',       label:'Submission',       sortable:true,  align:'left',  format: fmtCode },
  { key:'customer_email',      label:'Email',            sortable:true,  align:'left' },
  { key:'status',              label:'Status',           sortable:true,  align:'left' },
  { key:'cards',               label:'Cards',            sortable:true,  align:'right', format: fmtNum },
  { key:'evaluation',          label:'Evaluation',       sortable:true,  align:'left'  }, // Yes/No
  { key:'grand',               label:'Grand',            sortable:true,  align:'right', format: fmtMoney },
  { key:'grading_service',     label:'Grading Service',  sortable:true,  align:'left' },
  { key:'paid_at_iso',         label:'Paid',             sortable:true,  align:'left',  format: fmtDate },
  { key:'paid_amount',         label:'Paid $',           sortable:true,  align:'right', format: fmtMoney },
  { key:'shopify_order_name',  label:'Order',            sortable:true,  align:'left',  format: fmtCode }
];

export const defaultOrder = COLUMNS.map(c => c.key);
export const defaultHidden = [];
