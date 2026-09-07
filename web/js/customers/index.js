// ─── Customers ────────────────────────────────────────────────────────────────
// Customers list page (topbar overflow menu, column manager, bulk actions,
// one filter bar with a "More filters" disclosure, view chips, CSV export) and
// the per-customer detail view (profile, custom fields, risk indicators,
// activity timeline, notes, related tickets). Customer merge / un-merge
// bookkeeping lives at the bottom: tickets reassign with a stamp so the
// reversal can restore them, and primary-record backfill is undoable.
//
// Click/change/input/mousedown handlers route through
// core/event-delegation.js. Drag-to-reorder on the column headers uses
// module-internal document-level listeners at the bottom of this file
// (scoped via `closest('th[draggable="true"]')`; coexists with
// widget-shell's drag dispatcher because the selectors disambiguate).
// Pure-style onmouseover/onmouseout hover effects stay inline (PR #105
// rule).
//
// External reaches (interim, via window): escAttr, escHtml, isAdmin —
// all still in app.js. openTicket, showManageFieldsModal,
// showCSVModal and showNewCustomerModal are direct ES imports. The
// customers↔customers/modals.js import cycle is GONE: modals.js used to
// import refreshCustTable from here, but creating a customer moves the KPI
// bar and the "N of M" total as well as the rows, so it calls renderPage
// instead. The dependency is now one-way (this module imports the openers).

import { CUSTOMERS, CUSTOM_FIELDS, TICKETS } from '../core/data.js';
import { CUSTOMER_SELECTED, CUSTOMER_SELECTED_IDS, CUST_COLUMNS, CUST_DRAG_COL, SESSION, setCustColumns, setCustDragCol, setCustomerSelected } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { logTicketEvent } from '../core/activity-log.js';
import { showModal, closeModal, showDangerConfirm } from '../core/modal.js';
import { getProfileAreaRows, areaIsHalf } from '../layouts/index.js';
import { registerActions, registerChangeActions, registerInputActions, registerMousedownActions } from '../core/event-delegation.js';
import { openTicket } from '../tickets/detail.js';
import { showNewTicketModal } from '../tickets/new-ticket.js';
import { showManageFieldsModal } from '../custom-fields/index.js';
import { showCSVModal, showNewCustomerModal } from './modals.js';
import { matchesContact, applyContacts } from './contacts.js';
import { renderDetailsCard, attachPinObserver, detachPinObserver } from './details-card.js';
import { apiPost, apiPut, apiDelete, getBrandId } from '../core/api-client.js';
import { mapCustomerNote } from '../core/bootstrap.js';
import { showToast } from '../core/toast.js';
import { startPresence } from '../core/presence.js';
import { playerLookupActive, renderPlayerLookupView } from './player-lookup.js';
import { refreshCustomerAccount } from './account-refresh.js';

// ─── Customer table column state ─────────────────────────────────────────────

function getCustColumns() {
  const customCols = CUSTOM_FIELDS.map(f=>({id:'cf_'+f.id,label:f.label,fixed:false,isCustom:true,cfId:f.id}));
  customCols.forEach(cc=>{
    if(!CUST_COLUMNS.find(c=>c.id===cc.id)) CUST_COLUMNS.push({...cc,visible:false});
  });
  setCustColumns(CUST_COLUMNS.filter(c=>!c.isCustom||CUSTOM_FIELDS.find(f=>'cf_'+f.id===c.id)));
  return CUST_COLUMNS;
}

function custCellValue(c, colId) {
  if(colId==='id') return `<td class="bold">${c.id}</td>`;
  if(colId==='name') return `<td style="font-weight:500;color:var(--ink)">${window.escHtml(c.first)} ${window.escHtml(c.last)}</td>`;
  if(colId==='username') return `<td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${window.escHtml(c.username)}</td>`;
  if(colId==='brand') return `<td>${window.escHtml(c.brand)}</td>`;
  if(colId==='vip') return `<td><span class="vip-badge vip-${c.vip.toLowerCase()}">${window.escHtml(c.vip)}</span></td>`;
  if(colId==='jurisdiction') return `<td style="font-family:'DM Mono',monospace;font-size:11px">${window.escHtml(c.jurisdiction)}</td>`;
  if(colId==='consent') return `<td><span class="tag ${c.consent?'tag-resolved':'tag-gdpr'}">${c.consent?'Yes':'No'}</span></td>`;
  if(colId.startsWith('cf_')) { const cfId=colId.slice(3); return `<td style="font-size:12px;color:var(--ink2)">${window.escHtml(c.custom?.[cfId]||'—')}</td>`; }
  return '<td>—</td>';
}

function buildCustRows(list) {
  const cols = getCustColumns().filter(c=>c.visible);
  return list.map(c => {
    const checked = CUSTOMER_SELECTED_IDS.has(c.id);
    return `<tr data-action="cust.openProfile" data-cust-id="${window.escAttr(c.id)}" style="cursor:pointer${checked?';background:var(--purple-lt)':''}">
      <td style="width:32px;padding-right:0" data-action="">
        <input type="checkbox" ${checked?'checked':''} data-change-action="cust.toggleSelected" data-cust-id="${window.escAttr(c.id)}" style="cursor:pointer;accent-color:var(--purple)" />
      </td>
      ${cols.map(col=>custCellValue(c,col.id)).join('')}
    </tr>`;
  }).join('');
}

function buildCustHeaders() {
  const cols = getCustColumns().filter(c=>c.visible);
  const ids = applyCustFilters().map(c => c.id);
  const allSelected = ids.length > 0 && ids.every(id => CUSTOMER_SELECTED_IDS.has(id));
  const checkboxHeader = `<th style="width:32px;padding-right:0" data-action="">
    <input type="checkbox" ${allSelected?'checked':''} data-change-action="cust.toggleAll" style="cursor:pointer;accent-color:var(--purple)" title="Select all in view"/>
  </th>`;
  return checkboxHeader + cols.map((col,i)=>`<th draggable="true" data-col-idx="${i}" style="cursor:grab;user-select:none;white-space:nowrap" title="Drag to reorder">${col.label} <span style="opacity:.3;font-size:10px">⠿</span></th>`).join('');
}

function dropCustCol(targetIdx) {
  const vis = getCustColumns().filter(c=>c.visible);
  const all = getCustColumns();
  if(CUST_DRAG_COL===null||CUST_DRAG_COL===targetIdx) return;
  const src=vis[CUST_DRAG_COL], tgt=vis[targetIdx];
  if(!src||!tgt||src.fixed||tgt.fixed) return;
  const si=all.indexOf(src), ti=all.indexOf(tgt);
  all.splice(si,1); all.splice(ti,0,src);
  setCustDragCol(null);
  refreshCustTable(applyCustFilters());
}

// The grouped table body. Both the full render and the incremental refresh
// call this — they used to carry byte-identical copies, each with its own
// hardcoded colspan="20" against a table with a single-digit column count —
// and the count keeps changing, which is the point. The
// span is derived from the visible column list now (+1 for the select-all
// checkbox column, which buildCustHeaders writes by hand), so adding, hiding
// or reordering a column can't leave a group header spanning the wrong width.
function buildCustTableBody(list) {
  const span = getCustColumns().filter(c => c.visible).length + 1;
  const groups = groupCustomersBy(list, CUST_GROUP_BY);
  const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="${span}" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)">${window.escHtml(key)}</td></tr>`;
  return groups.map(g =>
    (g.key !== null ? groupHeader(`${g.key} · ${g.items.length}`) : '') + buildCustRows(g.items)
  ).join('');
}

export function refreshCustTable(list) {
  const thead = document.getElementById('cust-thead');
  const tbody = document.getElementById('cust-tbody');
  if (thead) thead.innerHTML = buildCustHeaders();
  if (tbody) tbody.innerHTML = buildCustTableBody(list);
}

function showColumnPanel() {
  const cols=getCustColumns();
  showModal('Manage columns', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Toggle columns on/off. Drag column headers in the table to reorder.</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${cols.map((col,i)=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);background:var(--off2)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;font-weight:500;color:var(--ink)">${window.escHtml(col.label)}</span>
            ${col.isCustom?`<span style="font-size:10px;color:var(--purple);background:var(--purple-lt);padding:1px 6px;border-radius:3px">Custom</span>`:''}
            ${col.fixed?`<span style="font-size:10px;color:var(--ink3)">(always shown)</span>`:''}
          </div>
          <label class="toggle">
            <input type="checkbox" ${col.visible?'checked':''} ${col.fixed?'disabled':''} data-change-action="cust.toggleCol" data-col-idx="${i}">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('')}
    </div>
  `, null, null);
}

let CUST_QUERY = '';
let CUST_VIP_FILTER = 'all';
let CUST_BRAND_FILTER = 'all';
let CUST_VIEW_FILTER = 'all';
let CUST_GROUP_BY = 'none';
// The VIP / brand / group-by selects live behind "More filters" (issue #447).
// Closed by default; anything actually filtering stays visible as a removal
// chip in the main bar, so nothing hides silently.
let CUST_SHOW_MORE_FILTERS = false;
// CUSTOMER_SELECTED_IDS lives in core/state.js so the renderPage page-guard
// in app.js can clear it on navigation away from the customers tab.

// Customers with at least one breaching or escalated ticket. Built as one
// pass over TICKETS rather than a nested `TICKETS.some()` per customer, which
// was O(customers × tickets) — tolerable when the page only rendered on
// navigation, wasteful now that every keystroke in the search box re-renders.
// Both the "At risk" chip count and its filter predicate read this.
function atRiskCustomerIdSet() {
  const ids = new Set();
  for (const t of TICKETS) {
    if (t.sla === 'breach' || t.status === 'escalated') ids.add(t.customerId);
  }
  return ids;
}

function applyCustFilters() {
  let list = [...CUSTOMERS];
  // Hide merged-into duplicates by default; the "Merged" view chip surfaces them on demand.
  if (CUST_VIEW_FILTER === 'merged') list = list.filter(c => c.mergedInto);
  else                               list = list.filter(c => !c.mergedInto);
  if (CUST_VIEW_FILTER === 'premium')         list = list.filter(c => c.vip === 'Platinum' || c.vip === 'Gold');
  else if (CUST_VIEW_FILTER === 'no-consent')  list = list.filter(c => !c.consent);
  else if (CUST_VIEW_FILTER === 'at-risk')     { const ids = atRiskCustomerIdSet(); list = list.filter(c => ids.has(c.id)); }
  if (CUST_QUERY.trim()) {
    const q = CUST_QUERY.toLowerCase();
    // Every address (primary + secondaries, email + mobile) is searchable.
    list = list.filter(c => (c.first+' '+c.last+' '+c.username+' '+c.id+' '+c.brand).toLowerCase().includes(q) || matchesContact(c, q));
  }
  if (CUST_VIP_FILTER !== 'all')   list = list.filter(c => c.vip === CUST_VIP_FILTER);
  if (CUST_BRAND_FILTER !== 'all') list = list.filter(c => c.brand === CUST_BRAND_FILTER);
  return list;
}

function groupCustomersBy(list, by) {
  if (by === 'none') return [{ key: null, items: list }];
  const groups = new Map();
  list.forEach(c => {
    let key = (c[by] || '—') + '';
    if (by === 'consent') key = c.consent ? 'Consent given' : 'No consent';
    groups.has(key) || groups.set(key, []);
    groups.get(key).push(c);
  });
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

function setCustView(v) { CUST_VIEW_FILTER = v; renderPage('customers'); }
function setCustGroupBy(v) { CUST_GROUP_BY = v; renderPage('customers'); }

function toggleCustSelected(id) {
  if (CUSTOMER_SELECTED_IDS.has(id)) CUSTOMER_SELECTED_IDS.delete(id);
  else CUSTOMER_SELECTED_IDS.add(id);
  renderPage('customers');
}

function toggleAllCustomers() {
  const ids = applyCustFilters().map(c => c.id);
  const all = ids.length > 0 && ids.every(id => CUSTOMER_SELECTED_IDS.has(id));
  if (all) ids.forEach(id => CUSTOMER_SELECTED_IDS.delete(id));
  else ids.forEach(id => CUSTOMER_SELECTED_IDS.add(id));
  renderPage('customers');
}

function clearCustSelection() { CUSTOMER_SELECTED_IDS.clear(); renderPage('customers'); }

function bulkSetCustVIP(v) {
  if (!v || CUSTOMER_SELECTED_IDS.size === 0) return;
  CUSTOMERS.forEach(c => { if (CUSTOMER_SELECTED_IDS.has(c.id)) c.vip = v; });
  CUSTOMER_SELECTED_IDS.clear();
  renderPage('customers');
}
function bulkSetCustConsent(v) {
  if (!v || CUSTOMER_SELECTED_IDS.size === 0) return;
  CUSTOMERS.forEach(c => { if (CUSTOMER_SELECTED_IDS.has(c.id)) c.consent = v === 'yes'; });
  CUSTOMER_SELECTED_IDS.clear();
  renderPage('customers');
}
// Bulk delete — real, server-persisted, permission-gated. The server refuses
// (409 has_tickets) any customer with live ticket history, so profiles can
// never orphan tickets; those rows stay and the result modal says why. Demo
// rows (no _uuid) keep the in-memory splice.
function bulkDeleteCustomers() {
  if (!window.canDeleteRecords()) return;
  const n = CUSTOMER_SELECTED_IDS.size;
  if (n === 0) return;
  showDangerConfirm({
    title: `Delete ${n} customer${n===1?'':'s'}`,
    bodyHtml: `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> customer profile${n===1?'':'s'}? Profiles with ticket history are skipped — merge those into another profile instead. This cannot be undone.</div>`,
    confirmLabel: 'Delete',
    onConfirm: async () => {
      closeModal();
      const ids = [...CUSTOMER_SELECTED_IDS];
      let deleted = 0, skippedTickets = 0;
      const failures = [];
      for (const id of ids) {
        const c = CUSTOMERS.find(x => x.id === id);
        if (!c) continue;
        if (c._uuid) {
          try { await apiDelete(`/api/v1/customers/${c._uuid}`); }
          catch (err) {
            if (err?.body?.code === 'has_tickets') skippedTickets++;
            else failures.push(`${id}: ${err?.message || err}`);
            continue;
          }
        }
        deleted++;
        const i = CUSTOMERS.findIndex(x => x.id === id);
        if (i >= 0) CUSTOMERS.splice(i, 1);
      }
      CUSTOMER_SELECTED_IDS.clear();
      renderPage('customers');
      if (skippedTickets || failures.length) {
        const parts = [`${deleted} deleted`];
        if (skippedTickets) parts.push(`${skippedTickets} skipped — they have tickets; merge them instead`);
        if (failures.length) parts.push(`${failures.length} failed (${failures[0]}${failures.length > 1 ? ', …' : ''})`);
        showToast(parts.join(' · '), skippedTickets && !failures.length ? 'warn' : 'error', 8000);
      }
    },
  });
}

function exportCustomerList() {
  const list = applyCustFilters();
  const headers = ['ID','First','Last','Username','Maestro user ID','Member ID','Email','Mobile','Brand','VIP','Jurisdiction','Consent','Since'];
  const rows = list.map(c => [c.id, c.first, c.last, c.username, c.maestroUserId, c.memberId, c.email, c.mobile, c.brand, c.vip, c.jurisdiction, c.consent ? 'Yes' : 'No', c.since]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `customers-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
// Full re-render rather than the old incremental table patch: the query now
// has a removal chip and feeds the "N of M" counter alongside the badge, and
// refreshCustTable only rewrites thead/tbody — the chrome would go stale as
// you type. Focus and caret are restored the same way tickets/list.js does.
// ─── Topbar overflow menu ───────────────────────────────────────────────────
// The ⋯ menu behind Columns / Fields / Import / Export. Unlike the composer's
// .comp-menu it owns its dismissal entirely (backdrop + Escape + every item
// handler), so core/dismiss.js does not participate — see openCustMoreMenu
// for why it can't live inside the topbar.
const CUST_MENU_ITEMS = [
  { action: 'cust.showColumnPanel', label: 'Columns…' },
  { action: 'cust.manageFields',    label: 'Fields…' },
  { action: 'cust.csvImport',       label: 'Import CSV…' },
  { action: 'cust.export',          label: 'Export CSV' },
];

function closeCustMoreMenu() {
  document.getElementById('cust-more-backdrop')?.remove();
  document.removeEventListener('keydown', onCustMenuKeydown, true);
  document.getElementById('cust-more-menu-btn')?.setAttribute('aria-expanded', 'false');
}

function onCustMenuKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCustMoreMenu();
    document.getElementById('cust-more-menu-btn')?.focus();
  }
}

// Built at BODY level with its own full-viewport backdrop, mirroring the
// workspace switcher, because .topbar is height:48px with overflow:hidden AND
// isolation:isolate: a panel rendered inside it is cut off at 48px, and even
// as position:fixed its z-index stays trapped in the topbar's stacking
// context, painting underneath the filter bar below.
function openCustMoreMenu() {
  const btn = document.getElementById('cust-more-menu-btn');
  if (!btn) return;
  closeCustMoreMenu();

  const backdrop = document.createElement('div');
  backdrop.id = 'cust-more-backdrop';
  backdrop.className = 'menu-backdrop';
  backdrop.setAttribute('data-action', 'cust.closeMoreMenu');

  const panel = document.createElement('div');
  panel.id = 'cust-more-menu';
  panel.className = 'comp-menu comp-menu-fixed';
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', 'More customer actions');
  // Absorber: a click inside the panel but not on an item must not fall
  // through to the backdrop and close it.
  panel.setAttribute('data-action', '');
  // Real <button>s, not divs: these were plain buttons before the topbar was
  // decluttered, and a div would have made all four mouse-only.
  panel.innerHTML = CUST_MENU_ITEMS
    .map((i) => `<button type="button" role="menuitem" class="comp-menu-item" data-action="${i.action}">${i.label}</button>`)
    .join('');

  const r = btn.getBoundingClientRect();
  const W = 200;
  panel.style.top  = `${Math.round(r.bottom + 4)}px`;
  panel.style.left = `${Math.round(Math.max(8, Math.min(r.right - W, window.innerWidth - W - 12)))}px`;
  panel.style.display = 'block';

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onCustMenuKeydown, true);
  btn.setAttribute('aria-expanded', 'true');
  panel.querySelector('.comp-menu-item')?.focus();
}

function filterCustomers(q) {
  // Capture the caret BEFORE the re-render: the input element is destroyed and
  // rebuilt, and forcing the caret to the end broke mid-string editing —
  // typing into "smith" at offset 0 put the next character at the end.
  const before = document.getElementById('cust-search');
  const selStart = before ? before.selectionStart : null;
  const selEnd   = before ? before.selectionEnd   : null;
  CUST_QUERY = q;
  renderPage('customers');
  const input = document.getElementById('cust-search');
  if (input) {
    input.focus();
    if (selStart !== null) {
      const max = input.value.length;
      input.setSelectionRange(Math.min(selStart, max), Math.min(selEnd, max));
    }
  }
}
function custSetVIP(v)   { CUST_VIP_FILTER = v;   renderPage('customers'); }
function custSetBrand(v) { CUST_BRAND_FILTER = v; renderPage('customers'); }

export function renderCustomers() {
  // Live player lookup (search the whole brand roster from Maestro) takes over
  // the page when active — see ./player-lookup.js. Checked before the local
  // detail branch; the two selections are mutually exclusive in practice.
  if (playerLookupActive()) return renderPlayerLookupView();
  if (CUSTOMER_SELECTED) return renderCustomerDetail(CUSTOMER_SELECTED);
  detachPinObserver();   // back on the list: release the profile card's scroll observer
  getCustColumns();
  const filtered = applyCustFilters();
  const total = CUSTOMERS.length;
  const brands = [...new Set(CUSTOMERS.map(c => c.brand))];
  const vipCounts = { Platinum:0, Gold:0, Silver:0, Bronze:0 };
  CUSTOMERS.forEach(c => { if (vipCounts[c.vip] !== undefined) vipCounts[c.vip]++; });
  const premium = vipCounts.Platinum + vipCounts.Gold;
  const avgPerCust = total ? (TICKETS.length / total).toFixed(1) : '0';
  const consentRate = total ? Math.round(CUSTOMERS.filter(c => c.consent).length / total * 100) : 0;

  // View chip counts
  const noConsentN  = CUSTOMERS.filter(c => !c.consent).length;
  const atRiskN     = (() => { const ids = atRiskCustomerIdSet(); return CUSTOMERS.filter(c => ids.has(c.id)).length; })();
  const mergedN = CUSTOMERS.filter(c => c.mergedInto).length;
  const views = [
    { k: 'all',         l: 'All',                         active: CUST_VIEW_FILTER === 'all' },
    { k: 'premium',     l: `Premium · ${premium}`,        active: CUST_VIEW_FILTER === 'premium' },
    { k: 'no-consent',  l: `No consent · ${noConsentN}`,  active: CUST_VIEW_FILTER === 'no-consent' },
    { k: 'at-risk',     l: `At risk · ${atRiskN}`,        active: CUST_VIEW_FILTER === 'at-risk' },
    { k: 'merged',      l: `Merged · ${mergedN}`,         active: CUST_VIEW_FILTER === 'merged' },
  ];

  const tableBody = buildCustTableBody(filtered);
  // How many of the "More filters" selects are narrowing the list. Badged on
  // the toggle so a closed row can never hide an active filter. Grouping is
  // excluded — it rearranges rows, it drops none — but it still gets a chip.
  const advancedN = [CUST_VIP_FILTER, CUST_BRAND_FILTER].filter(v => v !== 'all').length;
  const activeChipN = advancedN + (CUST_QUERY ? 1 : 0) + (CUST_GROUP_BY !== 'none' ? 1 : 0);

  const bulkBar = CUSTOMER_SELECTED_IDS.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${CUSTOMER_SELECTED_IDS.size} selected</span>
      <select class="filter-select" data-change-action="cust.bulkSetVIP">
        <option value="">Set VIP tier…</option>
        <option value="Platinum">Platinum</option>
        <option value="Gold">Gold</option>
        <option value="Silver">Silver</option>
        <option value="Bronze">Bronze</option>
      </select>
      <select class="filter-select" data-change-action="cust.bulkSetConsent">
        <option value="">Set consent…</option>
        <option value="yes">Consent: Yes</option>
        <option value="no">Consent: No</option>
      </select>
      ${window.canDeleteRecords() ? `<button class="btn btn-sm btn-danger" data-action="cust.bulkDelete">Delete</button>` : ''}
      <button class="btn btn-sm" data-action="cust.clearSelection" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Customers</div>
        ${getBrandId() ? `<button class="btn btn-sm" data-action="players.lookup" title="Search every player in this brand, live from Maestro">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.2"/><path d="M7.7 7.7L11 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          Look up player
        </button>` : ''}
        ${/* Columns / Fields / Import / Export are housekeeping — they were
             crowding out the two actions that matter, so they fold into an
             overflow menu. */''}
        ${/* Trigger only — the panel is built at body level by
             openCustMoreMenu(). It cannot live in here: .topbar is height:48px
             with overflow:hidden AND isolation:isolate (shell.css), so a
             descendant panel is clipped to a sliver and its z-index is trapped
             in the topbar's own stacking context, painting underneath the
             filter bar below it. Same escape the workspace switcher uses. */''}
        <button class="btn btn-sm" id="cust-more-menu-btn" data-action="cust.toggleMoreMenu"
                aria-haspopup="true" aria-expanded="false" aria-label="More customer actions" title="More actions">⋯</button>
        <button class="btn btn-sm btn-solid" data-action="cust.new">+ New Customer</button>
      </div>
      <div class="kpi-bar" style="grid-template-columns:repeat(5,1fr)">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Customers</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${premium}</div><div class="kpi-l">Premium VIP</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${brands.length}</div><div class="kpi-l">Brands</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${avgPerCust}</div><div class="kpi-l">Avg tickets</div></div>
        <div class="kpi"><div class="kpi-n c-green">${consentRate}%</div><div class="kpi-l">Consent</div></div>
      </div>
      ${bulkBar}
      ${/* One bar, not two (issue #447), matching the Tickets page. Search
           and the saved views stay out; the selects move behind "More
           filters", which badges how many are actually narrowing the list. */''}
      <div class="filter-bar" style="flex-wrap:wrap">
        ${/* aria-label, not just a placeholder: the "Filter" label was dropped
             to buy back a slot, and a placeholder is not an accessible name —
             it also vanishes the moment you type. */''}
        <input class="filter-select" id="cust-search" type="search" aria-label="Search customers" placeholder="Search name, username, ID, email, brand…" style="width:230px" value="${window.escAttr(CUST_QUERY)}" data-input-action="cust.filter"/>
        <span class="filter-label">View</span>
        ${views.map(v => `<span class="filter-tag${v.active?' active':''}" style="cursor:pointer" data-action="cust.setView" data-view="${window.escAttr(v.k)}">${v.l}</span>`).join('')}
        <button class="filter-more${CUST_SHOW_MORE_FILTERS?' open':''}" id="cust-more-toggle" data-action="cust.toggleMoreFilters"
                aria-expanded="${CUST_SHOW_MORE_FILTERS?'true':'false'}" aria-controls="cust-more-filters">
          More filters${advancedN?` <span class="filter-more-n">${advancedN}</span>`:''} <span class="filter-more-caret" aria-hidden="true">${CUST_SHOW_MORE_FILTERS?'▴':'▾'}</span>
        </button>
        ${activeChipN?'<span class="filter-sep" aria-hidden="true"></span>':''}
        ${CUST_VIP_FILTER!=='all'?`<span class="filter-tag">${window.escHtml(CUST_VIP_FILTER)}<span class="rm" data-action="cust.clearFilter" data-filter="vip">×</span></span>`:''}
        ${CUST_BRAND_FILTER!=='all'?`<span class="filter-tag">${window.escHtml(CUST_BRAND_FILTER)}<span class="rm" data-action="cust.clearFilter" data-filter="brand">×</span></span>`:''}
        ${CUST_QUERY?`<span class="filter-tag">"${window.escHtml(CUST_QUERY)}"<span class="rm" data-action="cust.clearFilter" data-filter="query">×</span></span>`:''}
        ${/* Grouping isn't a filter so it stays out of the badge, but with the
             select tucked away there'd otherwise be nothing on screen naming
             it or undoing it. */''}
        ${CUST_GROUP_BY!=='none'?`<span class="filter-tag">Grouped by ${window.escHtml(CUST_GROUP_BY)}<span class="rm" data-action="cust.clearFilter" data-filter="group" title="Remove grouping">×</span></span>`:''}
        <span id="cust-counter" style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${filtered.length} of ${total}</span>
        ${/* A CHILD of .filter-bar, always in the DOM: as a sibling it would
             survive the section being collapsed (an orphaned row whose toggle
             is hidden), and rendering it conditionally would leave
             aria-controls pointing at nothing while closed. */''}
        <div class="filter-subbar" id="cust-more-filters" ${CUST_SHOW_MORE_FILTERS?'':'hidden'}>
          <select class="filter-select" aria-label="Filter by VIP tier" data-change-action="cust.setVIP">
            <option value="all"      ${CUST_VIP_FILTER==='all'?'selected':''}>All VIP tiers</option>
            <option value="Platinum" ${CUST_VIP_FILTER==='Platinum'?'selected':''}>Platinum</option>
            <option value="Gold"     ${CUST_VIP_FILTER==='Gold'?'selected':''}>Gold</option>
            <option value="Silver"   ${CUST_VIP_FILTER==='Silver'?'selected':''}>Silver</option>
            <option value="Bronze"   ${CUST_VIP_FILTER==='Bronze'?'selected':''}>Bronze</option>
          </select>
          <select class="filter-select" aria-label="Filter by brand" data-change-action="cust.setBrand">
            <option value="all" ${CUST_BRAND_FILTER==='all'?'selected':''}>All brands</option>
            ${brands.map(b => `<option value="${window.escAttr(b)}" ${CUST_BRAND_FILTER===b?'selected':''}>${window.escHtml(b)}</option>`).join('')}
          </select>
          <span class="filter-subbar-sep" aria-hidden="true"></span>
          <select class="filter-select" aria-label="Group rows" data-change-action="cust.setGroupBy" title="Group rows">
            <option value="none"         ${CUST_GROUP_BY==='none'?'selected':''}>No grouping</option>
            <option value="vip"          ${CUST_GROUP_BY==='vip'?'selected':''}>Group by VIP</option>
            <option value="brand"        ${CUST_GROUP_BY==='brand'?'selected':''}>Group by brand</option>
            <option value="jurisdiction" ${CUST_GROUP_BY==='jurisdiction'?'selected':''}>Group by jurisdiction</option>
            <option value="consent"      ${CUST_GROUP_BY==='consent'?'selected':''}>Group by consent</option>
          </select>
        </div>
      </div>
      <div style="flex:1;overflow:auto">
        <table class="tbl" style="min-width:500px">
          <thead><tr id="cust-thead">${buildCustHeaders()}</tr></thead>
          <tbody id="cust-tbody">${tableBody}</tbody>
        </table>
        ${filtered.length === 0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No customers match</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

function getCustomerStats(custId) {
  const tickets = TICKETS.filter(t => t.customerId === custId);
  const open = tickets.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const resolved = tickets.filter(t => t.status === 'resolved').length;
  const csat = tickets.filter(t => t.csat);
  const avgCSAT = csat.length ? csat.reduce((a, t) => a + t.csat, 0) / csat.length : 0;
  return { tickets, total: tickets.length, open, resolved, csatCount: csat.length, avgCSAT };
}

function getCustomerActivity(custId) {
  const items = [];
  TICKETS.filter(t => t.customerId === custId).forEach(t => {
    (t.msgs || []).forEach(m => items.push({
      ticketId: t.id,
      from: m.from,
      role: m.r,
      text: m.t,
      ts: m.ts,
    }));
  });
  return items.slice(-15).reverse();
}

function getCustomerCommonTags(custId) {
  const counts = {};
  TICKETS.filter(t => t.customerId === custId).forEach(t => {
    (t.tags || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function getCustomerRisk(c) {
  const tickets = TICKETS.filter(t => t.customerId === c.id);
  const flags = [];
  const breaches = tickets.filter(t => t.sla === 'breach').length;
  if (breaches > 0) flags.push({ level: 'high', text: `${breaches} SLA breach${breaches>1?'es':''}` });
  const escalated = tickets.filter(t => t.status === 'escalated').length;
  if (escalated > 0) flags.push({ level: 'high', text: `${escalated} escalated` });
  if (tickets.filter(t => t.status === 'gdpr').length > 0) flags.push({ level: 'high', text: 'Active GDPR request' });
  if (!c.consent) flags.push({ level: 'medium', text: 'No marketing consent' });
  return flags;
}

function addCustomerNote(custId) {
  showModal('Add internal note', `<div class="form-row"><label class="form-label">Note</label><textarea class="form-input" id="cn-text" style="min-height:120px;font-family:'Inter',sans-serif" placeholder="Context the team should know about this customer…"></textarea></div>`, async () => {
    const text = document.getElementById('cn-text').value.trim();
    if (!text) return;
    const c = CUSTOMERS.find(x => x.id === custId);
    if (!c) return;
    if (!c.notes) c.notes = [];
    if (c._uuid) {
      // Persisted: the server stamps the author + timestamp; map its row to
      // the render shape exactly like bootstrap does. Close BEFORE the await
      // — modal.confirm re-invokes on every click, so a modal left open
      // during the round-trip double-posts on a double-click.
      closeModal();
      let res;
      try { res = await apiPost(`/api/v1/customers/${c._uuid}/notes`, { text }); }
      catch (err) { showToast(`Couldn't save the note: ${err?.message || err}`, 'error', 6000); return; }
      c.notes.unshift(mapCustomerNote(res.note));
      renderPage('customers');
      return;
    } else {
      // Demo persona — in-memory only, as before.
      c.notes.unshift({
        author: SESSION?.name || 'Unknown',
        ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
        text,
      });
    }
    closeModal(); renderPage('customers');
  }, 'Add note');
}

// Note deletion is real (API) and permission-gated; every path confirms
// first. Notes are addressed by id for API rows; demo rows (no _uuid on the
// customer, no id on the note) fall back to the array index.
function deleteCustomerNote(custId, noteId, idx) {
  if (!window.canDeleteRecords()) return;
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c || !c.notes) return;
  const note = (noteId && c.notes.find(n => n.id === noteId)) || c.notes[idx];
  if (!note) return;
  showDangerConfirm({
    title: 'Delete note',
    bodyHtml: `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Delete this internal note by <strong style="color:var(--ink)">${window.escHtml(note.author || 'Unknown')}</strong>? This cannot be undone.</div><div style="margin-top:10px;padding:10px 12px;background:var(--off2);border-radius:var(--r);font-size:12px;color:var(--ink2);white-space:pre-wrap">${window.escHtml(String(note.text || '').slice(0, 300))}</div>`,
    confirmLabel: 'Delete note',
    onConfirm: async () => {
      // Close before the await — a modal left open during the round-trip
      // fires a second DELETE on a double-click (spurious 404 alert).
      closeModal();
      if (c._uuid && note.id) {
        try { await apiDelete(`/api/v1/customers/${c._uuid}/notes/${note.id}`); }
        catch (err) { showToast(`Couldn't delete: ${err?.message || err}`, 'error', 6000); return; }
      }
      const i = c.notes.indexOf(note);
      if (i >= 0) c.notes.splice(i, 1);
      renderPage('customers');
    },
  });
}

function openCustomerProfile(id) { setCustomerSelected(id); renderPage('customers'); }
function closeCustomerProfile()  { setCustomerSelected(null); renderPage('customers'); }

// ─── Customer merge ─────────────────────────────────────────────────────────
// Combines a duplicate customer record into a primary. Tickets reassign their
// customerId, notes copy across, and missing profile fields are pulled from
// the source if the primary's value was empty. Each affected ticket is tagged
// with `preMergeCustomerId` so unmergeCustomer can reliably restore them.
function showMergeCustomerModal(custId) {
  if (!window.canDeleteRecords()) return;
  const src = CUSTOMERS.find(x => x.id === custId);
  if (!src) return;
  if (src.mergedInto) { alert(`Already merged into ${src.mergedInto}.`); return; }
  // Candidates: not self and not themselves a merged duplicate. A previously-
  // unmerged customer that used to have custId merged in is still a valid
  // primary, so we don't filter that out.
  const candidates = CUSTOMERS.filter(x => x.id !== custId && !x.mergedInto);
  if (!candidates.length) {
    showModal('Merge customer into…', '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No primary candidates available.</div>', null, null);
    return;
  }
  const card = c => `
    <div data-mousedown-action="cust.mergeFromModal" data-source="${window.escAttr(custId)}" data-target="${window.escAttr(c.id)}" style="padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <div style="width:30px;height:30px;border-radius:50%;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0">${window.escHtml((c.first[0]||'') + (c.last[0]||''))}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">${window.escHtml(c.first + ' ' + c.last)}</div>
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(c.id)} · ${window.escHtml(c.email || '')}</div>
      </div>
      <span class="vip-badge vip-${(c.vip || '').toLowerCase()}">${window.escHtml(c.vip || '')}</span>
    </div>`;
  showModal('Merge customer into…', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Pick the surviving profile. You'll see both profiles side by side and confirm before anything merges.</div>
    <div style="max-height:380px;overflow-y:auto">${candidates.map(card).join('')}</div>
  `, null, null);
}

// Server column names → client view-model keys, for applying merge/unmerge
// responses locally (the rest of the backfill columns share their names).
const MERGE_COL_MAP = { vip_tier: 'vip', backoffice_url: 'bo', maestro_user_id: 'maestroUserId', maestro_member_id: 'memberId' };

// Side-by-side confirmation between picking a survivor and actually merging —
// the spec's safety gate (the old picker merged on a single mousedown).
// Cancel closes outright; re-opening the picker is one click on ↩ Merge
// (one-modal-at-a-time constraint, same trade-off as the saved-search flow).
function showMergeConfirm(srcId, primaryId) {
  if (!window.canDeleteRecords()) return;
  const src = CUSTOMERS.find(x => x.id === srcId);
  const primary = CUSTOMERS.find(x => x.id === primaryId);
  if (!src || !primary) return;
  const esc = window.escHtml;
  const nCount = (src.notes || []).length;
  // TICKETS holds only the loaded pages, so per-profile ticket counts here
  // are "of the loaded set" — the copy below deliberately avoids claiming an
  // exact total (the server moves ALL of them regardless).
  const card = (c, label, color) => `
    <div style="flex:1;min-width:0;border:1px solid var(--rule);border-radius:var(--r);padding:12px;background:var(--off2)">
      <div style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${color};margin-bottom:8px">${label}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <div style="width:30px;height:30px;border-radius:50%;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0">${esc((c.first[0]||'') + (c.last[0]||''))}</div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.first + ' ' + c.last)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${esc(c.id)}</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--ink2);line-height:1.7">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.email || '—')}</div>
        <div>${esc(c.vip || '—')}</div>
        <div>${TICKETS.filter(t => t.customerId === c.id).length} loaded ticket${TICKETS.filter(t => t.customerId === c.id).length === 1 ? '' : 's'} · ${(c.notes || []).length} notes</div>
        <div>Since ${esc(c.since || '—')}</div>
      </div>
    </div>`;
  showDangerConfirm({
    title: 'Merge profiles',
    bodyHtml: `
      <div style="display:flex;gap:10px;align-items:stretch;margin-bottom:12px">
        ${card(src, 'Duplicate — merges away', 'var(--red)')}
        <div style="align-self:center;color:var(--ink3);font-size:16px;flex-shrink:0">→</div>
        ${card(primary, 'Survivor', 'var(--green)')}
      </div>
      <div style="font-size:12px;color:var(--ink2);line-height:1.6">Every ticket this duplicate has ever had and its ${nCount} note${nCount===1?'':'s'} move to the survivor, blank survivor details fill in from the duplicate, its email and mobile addresses move across as secondaries (the survivor keeps its own as primary), and the duplicate is hidden as merged. Reversible with Un-merge.</div>`,
    confirmLabel: 'Merge profiles',
    onConfirm: () => { closeModal(); mergeCustomers(srcId, primaryId); },
  });
}

// Apply a merge/unmerge response's contact fields onto a local row: the
// email/mobile mirror (server-derived for a merged-away duplicate) plus the
// emails/mobiles arrays. Server truth beats local bookkeeping here — the
// source's addresses physically move to the survivor as secondaries.
async function mergeCustomers(srcId, primaryId) {
  if (!window.canDeleteRecords()) return;
  if (srcId === primaryId) return;
  const src = CUSTOMERS.find(x => x.id === srcId);
  const primary = CUSTOMERS.find(x => x.id === primaryId);
  if (!src || !primary || src.mergedInto) return;
  if (primary.mergedInto) {
    alert(`${primaryId} is already a duplicate of ${primary.mergedInto}. Pick the chain's primary instead.`);
    return;
  }
  // API-backed workspace: the server owns the merge (transactional — tickets
  // move keeping their original emails/timestamps, notes move, auto note,
  // journalled backfill, audit row); we then apply its response locally so no
  // reload is needed. Demo personas keep the legacy in-memory body below.
  if (src._uuid && primary._uuid) {
    let res;
    try { res = await apiPost(`/api/v1/customers/${src._uuid}/merge`, { into_id: primary._uuid }); }
    catch (err) { alert(`Couldn't merge: ${err?.message || err}`); return; }
    const moved = new Set(res.tickets_moved_ids || []);
    TICKETS.forEach(t => {
      if (t._uuid && moved.has(t._uuid)) { t.preMergeCustomerId = srcId; t.customerId = primaryId; }
    });
    // Resolve merged_from stamps for EVERY note via the uuid map, not just
    // this merge's source — replacing primary.notes wholesale must not wipe
    // the stamps of children merged in earlier (their local unmerge would
    // otherwise strand their notes on the survivor until a reload).
    const custByUuid = Object.fromEntries(CUSTOMERS.map(x => [x._uuid, x]));
    primary.notes = (res.notes || []).map(n => ({
      ...mapCustomerNote(n),
      mergedFromCustomerId: n.merged_from_customer_id ? (custByUuid[n.merged_from_customer_id]?.id) : undefined,
    }));
    src.notes = [];
    Object.entries(res.backfilled_fields || {}).forEach(([col, val]) => { primary[MERGE_COL_MAP[col] || col] = val; });
    applyContacts(primary, res.primary);
    applyContacts(src, res.source);
    src.mergedInto = primaryId;
    src.mergedAt = String(res.source?.merged_at || '').slice(0, 10);
    primary.mergedFrom = primary.mergedFrom || [];
    if (!primary.mergedFrom.includes(srcId)) primary.mergedFrom.push(srcId);
    setCustomerSelected(primaryId);
    renderPage('customers');
    return;
  }
  // Reassign tickets, stamping each with the original customerId so un-merge
  // can put them back on the source if the merge is reversed.
  TICKETS.forEach(t => {
    if (t.customerId === srcId) {
      t.preMergeCustomerId = srcId;
      t.customerId = primaryId;
      logTicketEvent(t.id, 'system', `Customer merged: ${srcId} → ${primaryId}`);
    }
  });
  // Merge notes: append src.notes onto primary.notes with a separator marker
  // so an admin can see the boundary.
  if (src.notes && src.notes.length) {
    if (!primary.notes) primary.notes = [];
    primary.notes.push({ author:'System', ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }), text: `── Notes merged from ${srcId} ──`, mergedFromCustomerId: srcId });
    src.notes.forEach(n => primary.notes.push({ ...n, mergedFromCustomerId: srcId }));
  }
  // Backfill primary fields from src where primary is blank, recording which
  // fields we touched so unmergeCustomer can put the primary back the way it
  // was instead of leaving it carrying the source's data forever.
  primary._mergeBackfilled = primary._mergeBackfilled || {};
  primary._mergeBackfilled[srcId] = { fields: [], custom: [] };
  ['email','mobile','username','maestroUserId','memberId','brand','vip','jurisdiction','since','bo'].forEach(f => {
    if (!primary[f] && src[f]) {
      primary[f] = src[f];
      primary._mergeBackfilled[srcId].fields.push(f);
    }
  });
  if (src.custom) {
    primary.custom = primary.custom || {};
    Object.keys(src.custom).forEach(k => {
      if (primary.custom[k] === undefined || primary.custom[k] === '') {
        primary.custom[k] = src.custom[k];
        primary._mergeBackfilled[srcId].custom.push(k);
      }
    });
  }
  src.mergedInto = primaryId;
  src.mergedAt = new Date().toISOString().slice(0, 10);
  primary.mergedFrom = primary.mergedFrom || [];
  if (!primary.mergedFrom.includes(srcId)) primary.mergedFrom.push(srcId);
  // Navigate to the primary so the agent sees the consolidated view.
  setCustomerSelected(primaryId);
  renderPage('customers');
}

async function unmergeCustomer(srcId) {
  if (!window.canDeleteRecords()) return;
  const src = CUSTOMERS.find(x => x.id === srcId);
  if (!src || !src.mergedInto) return;
  const primaryId = src.mergedInto;
  const primary = CUSTOMERS.find(x => x.id === primaryId);
  // API-backed workspace: the server reverses the merge (stamped tickets and
  // notes come back, journalled backfills revert only where the survivor
  // hasn't edited them, audit row); apply the response locally.
  if (src._uuid) {
    let res;
    try { res = await apiPost(`/api/v1/customers/${src._uuid}/unmerge`); }
    catch (err) { alert(`Couldn't un-merge: ${err?.message || err}`); return; }
    const restored = new Set(res.tickets_restored_ids || []);
    TICKETS.forEach(t => {
      if (t._uuid && restored.has(t._uuid)) { t.customerId = srcId; delete t.preMergeCustomerId; }
    });
    // Both sides' notes come back from the server (server truth beats
    // filtering local stamps, which go stale after a reload or a second
    // stacked merge into the same survivor).
    const custByUuid = Object.fromEntries(CUSTOMERS.map(x => [x._uuid, x]));
    const mapNotes = (rows) => (rows || []).map(n => ({
      ...mapCustomerNote(n),
      mergedFromCustomerId: n.merged_from_customer_id ? (custByUuid[n.merged_from_customer_id]?.id) : undefined,
    }));
    src.notes = mapNotes(res.source_notes);
    if (primary) primary.notes = mapNotes(res.primary_notes);
    (res.fields_reverted || []).forEach(col => { if (primary) primary[MERGE_COL_MAP[col] || col] = ''; });
    applyContacts(src, res.source);
    applyContacts(primary, res.primary);
    if (primary && primary.mergedFrom) primary.mergedFrom = primary.mergedFrom.filter(x => x !== srcId);
    delete src.mergedInto;
    delete src.mergedAt;
    setCustomerSelected(srcId);
    renderPage('customers');
    return;
  }
  // Walk tickets and put them back on the source.
  TICKETS.forEach(t => {
    if (t.preMergeCustomerId === srcId && t.customerId === primaryId) {
      t.customerId = srcId;
      delete t.preMergeCustomerId;
      logTicketEvent(t.id, 'system', `Customer un-merged: restored to ${srcId}`);
    }
  });
  // Strip notes that came from src, including the separator marker.
  if (primary && primary.notes) {
    primary.notes = primary.notes.filter(n => n.mergedFromCustomerId !== srcId);
  }
  // Roll back fields the merge backfilled from this source, so the primary
  // returns to the state it was in pre-merge for those fields.
  if (primary && primary._mergeBackfilled?.[srcId]) {
    const back = primary._mergeBackfilled[srcId];
    (back.fields || []).forEach(f => { primary[f] = ''; });
    if (primary.custom && back.custom) (back.custom || []).forEach(k => { delete primary.custom[k]; });
    delete primary._mergeBackfilled[srcId];
  }
  if (primary && primary.mergedFrom) primary.mergedFrom = primary.mergedFrom.filter(x => x !== srcId);
  delete src.mergedInto;
  delete src.mergedAt;
  setCustomerSelected(srcId);
  renderPage('customers');
}

async function updateCustomField(custId, fieldId, value) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c) return;
  if (!c.custom) c.custom = {};
  if (c._uuid) {
    try {
      await apiPut(`/api/v1/custom-values/customers/${c._uuid}/${encodeURIComponent(fieldId)}`, { value: value || null });
    } catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
  }
  c.custom[fieldId] = value;
}

function showCustomerGDPR(custId) {
  showModal('GDPR actions', `
    <div class="gdpr-action"><div class="gdpr-action-title">Request erasure</div><div class="gdpr-action-desc">Permanently delete this customer's personal data under Article 17.</div><button class="btn btn-sm btn-danger" data-action="cust.closeGdpr">Request erasure</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">Redact in-thread data</div><div class="gdpr-action-desc">Mask PII in this customer's ticket messages.</div><button class="btn btn-sm" data-action="cust.closeGdpr">Redact</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">SAR export</div><div class="gdpr-action-desc">Export all data held about this customer.</div><button class="btn btn-sm" data-action="cust.closeGdpr">Export</button></div>
  `, null, null);
}

function renderCustomerDetail(custId) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c) { setCustomerSelected(null); return renderCustomers(); }
  void refreshCustomerAccount(c, () => {
    if (CUSTOMER_SELECTED !== custId) return;
    const card = document.getElementById('cust-pin');
    if (!card) return;
    const template = document.createElement('template');
    template.innerHTML = renderDetailsCard(c);
    const updated = template.content.querySelector('#cust-pin');
    if (!updated) return;
    detachPinObserver();
    card.replaceWith(updated);
    attachPinObserver();
  }, (err) => {
    if (CUSTOMER_SELECTED === custId) showToast(err?.message || "Couldn't refresh account details.", 'error');
  });
  // Real-time presence — no-ops for demo personas (no _uuid). Chip
  // slot is in the topbar below; the first heartbeat resolves after
  // main.innerHTML is set, so the slot is in the DOM by then.
  // No #presence-banner slot here — that's the "Emma is replying"
  // typing-indicator strip above the compose textarea, which only
  // makes sense for surfaces that have a composer (ticket detail).
  if (c._uuid && SESSION?.userId) startPresence('customer', c._uuid);
  const s = getCustomerStats(custId);
  const activity = getCustomerActivity(custId);
  const tagsList = getCustomerCommonTags(custId);
  const risks = getCustomerRisk(c);
  const notes = c.notes || [];

  const ticketRows = s.tickets.map(t => `
    <tr data-action="cust.openTicket" data-ticket-id="${window.escAttr(t.id)}" style="cursor:pointer">
      <td class="bold">${t.id}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--ink)">${window.escHtml(t.subject)}</td>
      <td><span class="tag tag-${t.status}">${t.status}</span></td>
      <td><span class="tag tag-${t.priority}">${t.priority}</span></td>
      <td>${window.escHtml(t.agent)}</td>
      <td><span class="sla-${t.sla}" style="font-size:11px;text-transform:uppercase;font-weight:500">${t.sla}</span></td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${t.updated}</td>
    </tr>`).join('');

  const customFields = CUSTOM_FIELDS.map(cf => {
    const val = c.custom?.[cf.id] ?? '';
    const inputType = cf.type === 'number' ? 'number' : cf.type === 'date' ? 'date' : 'text';
    // Filling in / editing values is open to all agents — only creating and
    // removing the field definitions is gated (see the Roles page).
    return `
      <div class="form-row">
        <label class="form-label">${window.escHtml(cf.label)}</label>
        <input class="form-input" type="${inputType}" value="${window.escAttr(val)}" data-input-action="cust.updateField" data-cust-id="${window.escAttr(c.id)}" data-field-id="${window.escAttr(cf.id)}"/>
      </div>`;
  }).join('') || '<div style="color:var(--ink3);font-size:12px;padding:8px 0">No custom fields defined. They can be added from the Custom Fields page (Senior Agent and above).</div>';

  const riskPanel = risks.length ? `
    <div class="card" style="margin-bottom:16px;border-color:var(--red-bd);background:var(--red-wash)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l6 11H1L7 1z" stroke="var(--red)" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 5v3M7 10v.5" stroke="var(--red)" stroke-width="1.4" stroke-linecap="round"/></svg>
        <div class="card-title" style="margin:0;color:var(--red)">Risk indicators</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${/* No border-color: .tag declares no border-width, so it would be
             inert, and the 1px outline is reserved as the shape cue for VIP
             tier badges (styles/pages.css). These read as tint-only pills. */''}
        ${risks.map(r => `<span class="tag" style="font-size:10px;color:${r.level==='high'?'var(--red)':'var(--amber)'};background:${r.level==='high'?'var(--red-lt)':'var(--amber-lt)'}">${window.escHtml(r.text)}</span>`).join('')}
      </div>
    </div>` : '';

  const tagsBlock = tagsList.length ? `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Common topics</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${tagsList.map(([tag, count]) => `<span class="tag tag-neutral" style="font-size:11px;display:inline-flex;align-items:center;gap:5px">${window.escHtml(tag)} <span style="color:var(--ink3);font-family:'DM Mono',monospace">${count}</span></span>`).join('')}
      </div>
    </div>` : '';

  const timelineBlock = activity.length ? `
    <div class="card">
      <div class="card-title">Activity timeline</div>
      <div class="cust-timeline">
        ${activity.map(a => `
          <div class="cust-timeline-item role-${a.role}" data-action="cust.openTicket" data-ticket-id="${window.escAttr(a.ticketId)}">
            <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
              <span style="font-size:11px;font-weight:600;color:var(--ink)">${window.escHtml(a.from)}</span>
              ${a.role === 'note' ? '<span class="note-mark">Note</span>' : a.role === 'ai' ? '<span class="ai-mark">AI</span>' : ''}
              <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${a.ticketId}</span>
              <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink4);margin-left:auto">${a.ts}</span>
            </div>
            <div style="font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(a.text)}</div>
          </div>
        `).join('')}
      </div>
    </div>` : `<div class="card"><div class="card-title">Activity timeline</div><div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No activity yet</div></div>`;

  const notesBlock = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Internal notes</div>
        <button class="btn btn-sm" data-action="cust.addNote" data-cust-id="${window.escAttr(c.id)}">+ Add note</button>
      </div>
      ${notes.length ? notes.map((n, i) => `
        <div class="cust-note">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px">
            <span style="font-size:11px;font-weight:600;color:var(--ink)">${window.escHtml(n.author)}</span>
            <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${n.ts}</span>
            ${window.canDeleteRecords() ? `<button class="btn btn-sm btn-danger" style="margin-left:auto;padding:2px 8px;font-size:10px;border:none;background:transparent;color:var(--ink3)" data-action="cust.deleteNote" data-cust-id="${window.escAttr(c.id)}" data-note-id="${window.escAttr(n.id || '')}" data-note-idx="${i}" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Delete note">×</button>` : ''}
          </div>
          <div style="font-size:12.5px;color:var(--ink2);line-height:1.55;white-space:pre-wrap">${window.escHtml(n.text)}</div>
        </div>
      `).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No notes yet — share context with the team by adding one.</div>'}
    </div>`;

  // ── Areas ────────────────────────────────────────────────────────────────
  // The three blocks above plus the four below are the profile's reorderable
  // AREAS. The pinned details card (customers/details-card.js) is the `details`
  // area — always first, always visible, so it is emitted as chrome at the top
  // of the template with the merged banner, merged-duplicates card and quick
  // actions, and dropped from the rows below.
  //
  // These were inline in the return template until the area registry below
  // needed to own their order. Their internal indentation is deliberately the
  // indentation they had inline, so the rendered bytes are unchanged.
  // Column count derives from the tile list (the Consent tile moved onto the
  // details card; its layout toggle now governs the card row instead).
  const kpiTiles = [
    `<div class="r-tile" style="border-color:var(--cyan-bd);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${s.open}</div><div class="r-tile-l" style="color:var(--cyan)">Open</div></div>`,
    `<div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${s.total}</div><div class="r-tile-l" style="color:var(--ink3)">Total tickets</div></div>`,
    `<div class="r-tile" style="border-color:var(--amber-bd);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${s.csatCount?s.avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">CSAT (${s.csatCount})</div></div>`,
  ];
  const kpisBlock = `<div style="display:grid;grid-template-columns:repeat(${kpiTiles.length},1fr);gap:10px;margin-bottom:20px">
          ${kpiTiles.join('\n          ')}
        </div>`;

  // The details rows (every profile field, in the admin-configured order, plus
  // the address pills) render inside the pinned card — see details-card.js.

  const customFieldsBlock = `<div class="card">
            <div class="card-title">Custom fields</div>
            ${customFields}
          </div>`;

  const ticketsBlock = `<div class="card">
          <div class="card-title">Tickets</div>
          ${s.tickets.length ? `
            <table class="tbl">
              <thead><tr><th>ID</th><th>Subject</th><th>Status</th><th>Priority</th><th>Agent</th><th>SLA</th><th>Updated</th></tr></thead>
              <tbody>${ticketRows}</tbody>
            </table>
          ` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets</div><div class="empty-line"></div></div>`}
        </div>`;

  // Keyed by NAME, never by position. core/collapsible.js keys its sections
  // positionally (`customers:filter-bar:0`) and documents at length how that
  // forced it to carry a SECTION_MIGRATIONS list; a stored layout referring to
  // "area 3" breaks the moment an area is inserted, whereas a name survives.
  // Values, not thunks: every block above is already built by the time we get
  // here, so a thunk would defer nothing and only imply laziness that isn't
  // there. If hiding areas ever makes it worth not building them, the blocks
  // move inside — that is a real change, not this one.
  const areas = {
    risk:         riskPanel,
    kpis:         kpisBlock,
    tags:         tagsBlock,
    customFields: customFieldsBlock,
    timeline:     timelineBlock,
    notes:        notesBlock,
    tickets:      ticketsBlock,
  };

  // Rows, in order, from the admin-configured area layout (Layouts → Profile
  // areas). getProfileAreaRows applies the pairing rule — neighbouring
  // half-width areas share one 2-column grid row (`timeline`+`notes` in the
  // default order) — and drops hidden areas. `details` is pinned at position
  // one and full width, so it always arrives as its own first row; it is
  // rendered as chrome above (the sticky card must be a direct child of
  // .page-scroll to stick for the whole scroll), so it leaves the rows here.
  // Filtered by name rather than sliced by position so a stored layout that
  // somehow carries it elsewhere can't render it twice.
  const areaRows = getProfileAreaRows().map(r => r.filter(k => k !== 'details')).filter(r => r.length);

  const areasHtml = areaRows.map(row => {
    // Drop names the registry doesn't know. areaRows is a literal today so this
    // never fires, but admin-configurable order (a later PR) can carry the name
    // of an area since renamed or removed — and `areas[k]` on a missing key is
    // undefined, which interpolates into the page as the literal text
    // "undefined" where a card should be. Keying by name only buys resilience if
    // the unknown name is actually handled, so handle it here rather than leaving
    // the guarantee to the PR that introduces stored config.
    //
    // Object.hasOwn, not a truthiness check: a stored name like 'constructor' or
    // 'toString' resolves through the prototype chain, so the row would keep it
    // and interpolate Object.prototype's member — a FUNCTION, which stringifies
    // into the page as its own source ("function toString() { [native code] }").
    // Same guard core/router.js uses on its own name-keyed page registry.
    // Warn rather than drop in silence: a card that just stops appearing, with
    // nothing in the console, is close to undebuggable. Same treatment
    // core/router.js gives an unknown page key.
    const kept = row.filter(k => {
      if (Object.hasOwn(areas, k)) return true;
      console.warn(`[customers] unknown profile area "${k}" — skipped`);
      return false;
    });
    const parts = kept.map(k => areas[k]);
    // A row with nothing in it emits nothing. Returning the grid wrapper for an
    // all-empty row would leave a stray margin-bottom gap on the page.
    if (parts.every(p => !p)) return '';
    // A lone FULL-width area renders bare — those blocks carry their own
    // bottom margins, and double-wrapping would double the gap. A lone
    // HALF-width area (partner hidden, or the pair split by a reorder) keeps
    // the grid wrapper: the card blocks have no margin of their own, so the
    // wrapper is what spaces the row.
    if (parts.length === 1 && !areaIsHalf(kept[0])) return parts[0];
    // Columns follow the row's length instead of assuming two, so a three-area
    // row does not silently wrap into a 2-column grid. Spelled out as
    // '1fr 1fr ...' rather than repeat(n,1fr) so the two-area case stays
    // byte-identical to the markup this replaced.
    const cols = Array(parts.length).fill('1fr').join(' ');
    return `<div style="display:grid;grid-template-columns:${cols};gap:16px;margin-bottom:16px">
          ${parts.join('\n          ')}
        </div>`;
  }).join('\n        ');

  // The sticky card measures itself and arms its scroll observer once the
  // markup below is in the DOM — renderPage assigns innerHTML synchronously,
  // so the next frame is the earliest safe moment. No-op in the smoke shim
  // (no IntersectionObserver there).
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attachPinObserver);

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="cust.closeProfile">Customers</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${window.escHtml(c.first)} ${window.escHtml(c.last)}</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <div id="presence-chips" class="presence-chips" aria-label="Agents viewing this customer"></div>
          </span>
        </div>
      </div>
      <div class="page-scroll">${renderDetailsCard(c)}
        ${c.mergedInto ? `<div style="margin:0 0 16px;padding:10px 14px;background:var(--purple-lt);border:1px solid var(--purple);border-radius:var(--r);font-size:11px;color:var(--purple);display:flex;align-items:center;gap:10px">
          <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Merged duplicate</span>
          <span style="color:var(--ink2)">→</span>
          <span class="link" data-action="cust.selectAndRender" data-cust-id="${window.escAttr(c.mergedInto)}" style="color:var(--purple);font-weight:500">${window.escHtml(c.mergedInto)}</span>
          <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:10px">on ${window.escHtml(c.mergedAt || '—')}</span>
          ${window.canDeleteRecords() ? `<button class="btn btn-sm" style="margin-left:auto" data-action="cust.unmerge" data-cust-id="${window.escAttr(c.id)}">Un-merge</button>` : ''}
        </div>` : ''}
        ${(c.mergedFrom || []).length ? `<div class="card" style="margin-bottom:16px">
          <div class="card-title">Merged duplicates (${c.mergedFrom.length})</div>
          ${c.mergedFrom.map(mid => {
            const m = CUSTOMERS.find(x => x.id === mid);
            if (!m) return '';
            return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--rule);cursor:pointer" data-action="cust.selectAndRender" data-cust-id="${window.escAttr(mid)}">
              <div style="width:24px;height:24px;border-radius:50%;background:var(--ink);color:var(--w);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600">${window.escHtml((m.first[0]||'') + (m.last[0]||''))}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(m.first + ' ' + m.last)}</div>
                <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(mid)} · merged ${window.escHtml(m.mergedAt || '—')}</div>
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
        <div class="cust-quickactions">
          <button class="btn btn-sm" data-action="cust.addNote" data-cust-id="${window.escAttr(c.id)}">+ Note</button>
          ${!c.mergedInto ? `<button class="btn btn-sm" data-action="cust.newTicket" data-cust-id="${window.escAttr(c.id)}">✉ New ticket</button>` : ''}
          ${window.canDeleteRecords() && !c.mergedInto ? `<button class="btn btn-sm" data-action="cust.showMergeModal" data-cust-id="${window.escAttr(c.id)}">↩ Merge</button>` : ''}
          <button class="btn btn-sm btn-danger" style="margin-left:auto" data-action="cust.showGdpr" data-cust-id="${window.escAttr(c.id)}">GDPR</button>
        </div>
        ${areasHtml}
      </div>
    </div>`;
}

registerActions({
  // List + bulk actions
  'cust.openProfile':     (ds) => openCustomerProfile(ds.custId),
  'cust.closeProfile':    () => closeCustomerProfile(),
  'cust.toggleMoreFilters': () => {
    CUST_SHOW_MORE_FILTERS = !CUST_SHOW_MORE_FILTERS;
    renderPage('customers');
    // renderPage replaces the page, so a keyboard user who pressed Enter here
    // would land back on <body> and have to tab the whole shell again.
    document.getElementById('cust-more-toggle')?.focus();
  },
  'cust.toggleMoreMenu': () => {
    if (document.getElementById('cust-more-backdrop')) closeCustMoreMenu();
    else openCustMoreMenu();
  },
  'cust.closeMoreMenu': () => closeCustMoreMenu(),
  'cust.clearFilter': (ds) => {
    if      (ds.filter === 'vip')   CUST_VIP_FILTER = 'all';
    else if (ds.filter === 'brand') CUST_BRAND_FILTER = 'all';
    else if (ds.filter === 'query') CUST_QUERY = '';
    else if (ds.filter === 'group') CUST_GROUP_BY = 'none';
    renderPage('customers');
  },
  'cust.setView':         (ds) => setCustView(ds.view),
  'cust.bulkDelete':      () => bulkDeleteCustomers(),
  'cust.clearSelection':  () => clearCustSelection(),
  'cust.showColumnPanel': () => { closeCustMoreMenu(); showColumnPanel(); },
  'cust.manageFields':    () => { closeCustMoreMenu(); showManageFieldsModal(); },
  // Direct imports despite the customers↔customers/modals.js cycle — the
  // openers are only referenced inside these closures. See header.
  'cust.csvImport':       () => { closeCustMoreMenu(); showCSVModal(); },
  'cust.new':             () => showNewCustomerModal(),
  'cust.export':          () => { closeCustMoreMenu(); exportCustomerList(); },
  'cust.closeGdpr':       () => closeModal(),
  // Detail-page actions
  'cust.openTicket':      (ds) => openTicket(ds.ticketId),
  'cust.addNote':         (ds) => addCustomerNote(ds.custId),
  // Opens the two-step new-ticket flow with this customer pre-picked.
  'cust.newTicket':       (ds) => showNewTicketModal(null, ds.custId),
  'cust.deleteNote':      (ds) => deleteCustomerNote(ds.custId, ds.noteId || null, parseInt(ds.noteIdx, 10)),
  'cust.unmerge':         (ds) => unmergeCustomer(ds.custId),
  'cust.showMergeModal':  (ds) => showMergeCustomerModal(ds.custId),
  'cust.showGdpr':        (ds) => showCustomerGDPR(ds.custId),
  // Switch the active customer + re-render — used by the
  // mergedInto link and the per-original-customer list items in the
  // un-merge undo block.
  'cust.selectAndRender': (ds) => { setCustomerSelected(ds.custId); renderPage('customers'); },
});

registerChangeActions({
  'cust.toggleSelected': (ds) => toggleCustSelected(ds.custId),
  'cust.toggleAll':      () => toggleAllCustomers(),
  'cust.toggleCol':      (ds, el) => { CUST_COLUMNS[parseInt(ds.colIdx, 10)].visible = el.checked; refreshCustTable(applyCustFilters()); },
  'cust.bulkSetVIP':     (ds, el) => bulkSetCustVIP(el.value),
  'cust.bulkSetConsent': (ds, el) => bulkSetCustConsent(el.value),
  'cust.setVIP':         (ds, el) => custSetVIP(el.value),
  'cust.setBrand':       (ds, el) => custSetBrand(el.value),
  'cust.setGroupBy':     (ds, el) => setCustGroupBy(el.value),
});

registerInputActions({
  'cust.filter':      (ds, el) => filterCustomers(el.value),
  'cust.updateField': (ds, el) => updateCustomField(ds.custId, ds.fieldId, el.value),
});

registerMousedownActions({
  // Pick a survivor in the merge picker: close it, then show the
  // side-by-side confirmation (the merge itself runs from its Confirm).
  'cust.mergeFromModal': (ds) => { closeModal(); showMergeConfirm(ds.source, ds.target); },
});

// ─── Column drag-and-drop dispatcher ─────────────────────────────────────────
// Drag is sparse — only this module + widget-shell use it across the
// codebase — so it lives here rather than in core/event-delegation.js. The
// selector `th[draggable="true"]` disambiguates from widget-shell's
// `.widget[draggable="true"]`, so both modules' document-level listeners
// coexist without stepping on each other.
function _dragTh(e) { return e.target.closest('th[draggable="true"]'); }
document.addEventListener('dragstart', e => {
  const th = _dragTh(e); if (!th) return;
  setCustDragCol(parseInt(th.dataset.colIdx, 10));
});
document.addEventListener('dragover', e => {
  const th = _dragTh(e); if (!th) return;
  e.preventDefault();
});
document.addEventListener('drop', e => {
  const th = _dragTh(e); if (!th) return;
  dropCustCol(parseInt(th.dataset.colIdx, 10));
});
