// ─── Macros ──────────────────────────────────────────────────────────────────
// A macro is an agent-triggered, ordered sequence of mutations applied to a
// single ticket (or each ticket in a bulk selection). Steps run through the
// existing single-ticket mutators where possible so audit logging, SLA refresh,
// CSAT triggers, etc all stay correct.
//
// External reaches (interim, via window): isAdmin, escHtml, escAttr — still
// in app.js. changeTicketStatus, changeTicketPriority, changeTicketAgent,
// addTicketTag, openTicket, showModal / closeModal (core/modal.js), navTo
// (core/keybindings.js) and insertMacro (tickets/detail.js) are direct ES
// imports.
//
// No window-bridge namespace: the inline on*= handlers are delegated as
// macros.* actions (bottom of file). showMacroPanel / showApplyMacroModal
// stay exported (detail.js imports them as td.macroPanel / td.macroModal);
// MACROS (data) is imported by list.js; renderMacros by the router. The
// mutators run via the actions and are module-internal.
//
// insertMacro lives in tickets/detail.js which imports showMacroPanel /
// showApplyMacroModal back from here — a cycle, fine because the binding is
// only used inside the action closure (deferred), not at module-eval time.
//
// logTicketEvent is imported from core/activity-log.js since that's already
// extracted.

import { AGENTS, CANNED_RESPONSES, CUSTOMERS, TICKETS } from '../core/data.js';
import { CURRENT_TICKET, MACRO_FILTER_QUERY, SESSION, TICKET_SELECTED_IDS, setMacroFilterQuery } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { logTicketEvent } from '../core/activity-log.js';
import { showModal, closeModal } from '../core/modal.js';
import { navTo } from '../core/keybindings.js';
import { insertMacro, openTicket, changeTicketStatus, changeTicketPriority, changeTicketAgent, addTicketTag } from './detail.js';
import {
  registerActions, registerChangeActions,
  registerMousedownActions, registerInputActions,
} from '../core/event-delegation.js';

export const MACROS = [
  { id:'MAC-001', name:'Waiting on customer', icon:'⏸', description:'Pause for customer reply',
    actions:[
      { kind:'status',  value:'pending' },
      { kind:'tag',     value:'waiting-customer' },
      { kind:'reply',   templateId:'TPL-002' },
    ], usageCount:14, lastUsed:'2025-04-15' },
  { id:'MAC-002', name:'Resolve with thanks', icon:'✅', description:'Send a thank-you reply and resolve',
    actions:[
      { kind:'reply',   templateId:'TPL-004' },
      { kind:'status',  value:'resolved' },
    ], usageCount:23, lastUsed:'2025-04-16' },
  { id:'MAC-003', name:'Escalate to billing', icon:'⬆', description:'High priority + billing tag + note',
    actions:[
      { kind:'priority', value:'high' },
      { kind:'tag',      value:'billing-escalation' },
      { kind:'note',     text:'Escalated to billing for review.' },
    ], usageCount:7, lastUsed:'2025-04-14' },
];

function macNextId() {
  const max = Math.max(0, ...MACROS.map(m => parseInt((m.id||'').split('-')[1] || '0', 10)));
  return `MAC-${String(max + 1).padStart(3, '0')}`;
}

const MAC_ACTION_KINDS = [
  { kind:'status',   label:'Set status',     hint:'open / pending / escalated / gdpr / resolved' },
  { kind:'priority', label:'Set priority',   hint:'urgent / high / normal / low' },
  { kind:'assign',   label:'Assign to',      hint:'agent name (or "unassign")' },
  { kind:'tag',      label:'Add tag',        hint:'lowercase, hyphenated' },
  { kind:'reply',    label:'Insert reply',   hint:'response template' },
  { kind:'note',     label:'Add internal note', hint:'note text' },
];

function macActionSummary(a) {
  if (a.kind === 'status')   return `→ status <strong>${window.escHtml(a.value)}</strong>`;
  if (a.kind === 'priority') return `→ priority <strong>${window.escHtml(a.value)}</strong>`;
  if (a.kind === 'assign')   return a.value === 'unassign' ? '→ unassign' : `→ assign to <strong>${window.escHtml(a.value)}</strong>`;
  if (a.kind === 'tag')      return `+ tag <strong>${window.escHtml(a.value)}</strong>`;
  if (a.kind === 'reply') {
    const tpl = CANNED_RESPONSES.find(r => r.id === a.templateId);
    return `+ reply <strong>${window.escHtml(tpl ? tpl.name : a.templateId)}</strong>`;
  }
  if (a.kind === 'note') {
    const txt = String(a.text || '');
    const preview = txt.length > 40 ? txt.slice(0, 40) + '…' : txt;
    return `+ note <em style="color:var(--ink3)">"${window.escHtml(preview)}"</em>`;
  }
  return window.escHtml(a.kind);
}

// Picker for inserting a CANNED_RESPONSES entry into the compose box of
// ticket `id`. Rows carry data-action="macros.insert"; the handler calls
// insertMacro (from detail.js). Labels go through escAttr/escHtml on the way in.
export function showMacroPanel(id) {
  const items = CANNED_RESPONSES.map((r, i) => {
    const preview = r.text.replace(/\n+/g, ' ').slice(0, 100);
    return `<div class="macro-item" data-action="macros.insert" data-id="${window.escAttr(id)}" data-idx="${i}">
      <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">${window.escHtml(r.name)}</div>
        <div style="font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(preview)}</div>
      </div>
    </div>`;
  }).join('');
  showModal('Insert canned response', `<div style="font-size:12px;color:var(--ink3);margin-bottom:12px">{name} placeholders are auto-filled with the customer\'s first name.</div>${items}`, null, null);
}

function runMacro(macroId, ticketId) {
  const macro = MACROS.find(m => m.id === macroId);
  const t = TICKETS.find(x => x.id === ticketId);
  if (!macro || !t) return;
  if (t.mergedInto) { alert(`${ticketId} is a merged duplicate. Open ${t.mergedInto} to apply macros.`); return; }
  let replyAppended = '';
  (macro.actions || []).forEach(a => {
    if (a.kind === 'status' && a.value)   changeTicketStatus(ticketId, a.value);
    else if (a.kind === 'priority' && a.value) changeTicketPriority(ticketId, a.value);
    else if (a.kind === 'assign') {
      if (a.value === 'unassign') changeTicketAgent(ticketId, '');
      else if (a.value) changeTicketAgent(ticketId, a.value);
    }
    else if (a.kind === 'tag' && a.value) addTicketTag(ticketId, a.value);
    else if (a.kind === 'reply' && a.templateId) {
      const tpl = CANNED_RESPONSES.find(r => r.id === a.templateId);
      if (tpl) {
        const cust = CUSTOMERS.find(c => c.id === t.customerId);
        // Resolve the same {var} tokens the composer's "Insert" buttons offer
        // so a reply-step macro produces the same text an agent would compose.
        const text = tpl.text
          .replace(/\{name\}/g,   cust ? cust.first : 'there')
          .replace(/\{ticket\}/g, t.id)
          .replace(/\{brand\}/g,  cust?.brand || '')
          .replace(/\{agent\}/g,  t.agent || SESSION?.name || '');
        replyAppended = replyAppended ? `${replyAppended}\n\n${text}` : text;
      }
    }
    else if (a.kind === 'note' && a.text) {
      t.msgs = t.msgs || [];
      t.msgs.push({
        from: SESSION?.name || 'Agent', r:'note',
        t: a.text,
        ts: new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
      });
    }
  });
  macro.usageCount = (macro.usageCount || 0) + 1;
  macro.lastUsed = new Date().toISOString().slice(0, 10);
  logTicketEvent(ticketId, 'system', `Macro applied: ${macro.name}`);
  if (CURRENT_TICKET === ticketId) {
    openTicket(ticketId);
    if (replyAppended) {
      appendText(ticketId, replyAppended);
    }
  }
}

function bulkRunMacro(macroId) {
  if (!macroId || TICKET_SELECTED_IDS.size === 0) return;
  const ids = [...TICKET_SELECTED_IDS];
  ids.forEach(id => runMacro(macroId, id));
  TICKET_SELECTED_IDS.clear();
  renderPage('tickets');
}

export function showApplyMacroModal(ticketId) {
  if (MACROS.length === 0) {
    showModal('Apply macro', '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No macros defined yet. Create one in <span class="link" data-action="macros.gotoManage">Config → Macros</span>.</div>', null, null);
    return;
  }
  const items = MACROS.map(m => `
    <div data-mousedown-action="macros.runAndClose" data-macro-id="${window.escAttr(m.id)}" data-ticket-id="${window.escAttr(ticketId)}" style="padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <span style="font-size:14px">${window.escHtml(m.icon || '⚡')}</span>
        <span style="font-size:13px;font-weight:600;color:var(--ink)">${window.escHtml(m.name)}</span>
        <span style="margin-left:auto;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(m.id)}</span>
      </div>
      <div style="font-size:11px;color:var(--ink2);line-height:1.5">${(m.actions || []).map(macActionSummary).join('<span style="color:var(--ink3)"> · </span>')}</div>
    </div>`).join('');
  showModal('Apply macro', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">Each step runs in order. Reply text is staged in the composer for review before sending.</div>
    <div style="max-height:380px;overflow-y:auto">${items}</div>
  `, null, null);
}

function macStepRow(a, i) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const valueInput = (() => {
    if (a.kind === 'status') {
      return `<select class="form-input" data-mac-val="${i}">${['open','pending','escalated','gdpr','resolved'].map(v=>`<option value="${v}" ${a.value===v?'selected':''}>${v}</option>`).join('')}</select>`;
    }
    if (a.kind === 'priority') {
      return `<select class="form-input" data-mac-val="${i}">${['urgent','high','normal','low'].map(v=>`<option value="${v}" ${a.value===v?'selected':''}>${v}</option>`).join('')}</select>`;
    }
    if (a.kind === 'assign') {
      return `<select class="form-input" data-mac-val="${i}"><option value="unassign" ${a.value==='unassign'?'selected':''}>Unassign</option>${AGENTS.map(ag=>`<option value="${window.escAttr(ag.name)}" ${a.value===ag.name?'selected':''}>${window.escHtml(ag.name)}</option>`).join('')}</select>`;
    }
    if (a.kind === 'reply') {
      return `<select class="form-input" data-mac-tpl="${i}">${CANNED_RESPONSES.map(r=>`<option value="${window.escAttr(r.id)}" ${a.templateId===r.id?'selected':''}>${window.escHtml(r.name)}</option>`).join('')}</select>`;
    }
    if (a.kind === 'note') {
      return `<input class="form-input" data-mac-text="${i}" value="${esc(a.text)}" placeholder="Internal note text"/>`;
    }
    return `<input class="form-input" data-mac-val="${i}" value="${esc(a.value)}" placeholder="value"/>`;
  })();
  return `
    <div class="mac-step" data-mac-step="${i}" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:6px">
      <select class="form-input" style="flex:0 0 130px" data-mac-kind="${i}" data-change-action="macros.stepKind" data-idx="${i}">${MAC_ACTION_KINDS.map(k=>`<option value="${k.kind}" ${a.kind===k.kind?'selected':''}>${k.label}</option>`).join('')}</select>
      <div style="flex:1">${valueInput}</div>
      <button type="button" class="btn btn-sm" data-action="macros.removeStep" data-idx="${i}" title="Remove step">×</button>
    </div>`;
}

function macFormBody(m) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const steps = (m?.actions || []).map(macStepRow).join('');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="mac-name" value="${esc(m?.name)}" placeholder="e.g. Waiting on customer"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Icon (emoji)</label><input class="form-input" id="mac-icon" value="${esc(m?.icon || '⚡')}" maxlength="2"/></div>
      <div class="form-row"><label class="form-label">Description</label><input class="form-input" id="mac-desc" value="${esc(m?.description)}" placeholder="What this macro does"/></div>
    </div>
    <div class="form-row">
      <label class="form-label" style="display:flex;align-items:center;justify-content:space-between">Steps <button type="button" class="btn btn-sm" data-action="macros.addStep">+ Add step</button></label>
      <div id="mac-steps">${steps}</div>
    </div>`;
}

function _macReadDraft() {
  const root = document.getElementById('mac-steps');
  if (!root) return [];
  return [...root.querySelectorAll('[data-mac-step]')].map(row => {
    const i = row.dataset.macStep;
    const kind = row.querySelector(`[data-mac-kind="${i}"]`).value;
    const tplEl = row.querySelector(`[data-mac-tpl="${i}"]`);
    const txtEl = row.querySelector(`[data-mac-text="${i}"]`);
    const valEl = row.querySelector(`[data-mac-val="${i}"]`);
    if (kind === 'reply') return { kind, templateId: tplEl?.value };
    if (kind === 'note')  return { kind, text: txtEl?.value };
    return { kind, value: valEl?.value };
  });
}

function _macReplaceSteps(actions) {
  const root = document.getElementById('mac-steps');
  if (!root) return;
  root.innerHTML = actions.map(macStepRow).join('');
}

function macAddStep() {
  const draft = _macReadDraft();
  draft.push({ kind:'status', value:'open' });
  _macReplaceSteps(draft);
}
function macRemoveStep(i) {
  const draft = _macReadDraft();
  draft.splice(i, 1);
  _macReplaceSteps(draft);
}
function macStepKindChange(i, newKind) {
  const draft = _macReadDraft();
  // Reset value when kind changes; pick a sensible default per kind so the row
  // doesn't render empty inputs.
  const defaults = { status:'open', priority:'normal', assign:'unassign', tag:'', reply: CANNED_RESPONSES[0]?.id, note:'' };
  draft[i] = { kind: newKind };
  if (newKind === 'reply') draft[i].templateId = defaults.reply;
  else if (newKind === 'note') draft[i].text = '';
  else draft[i].value = defaults[newKind] || '';
  _macReplaceSteps(draft);
}

function macNew() {
  if (!window.isAdmin()) return;
  const seed = { actions: [{ kind:'status', value:'pending' }] };
  showModal('New macro', macFormBody(seed), () => {
    const name = document.getElementById('mac-name').value.trim();
    if (!name) { alert('Name is required.'); return; }
    const actions = _macReadDraft().filter(a => a.kind && (a.value || a.text || a.templateId));
    if (!actions.length) { alert('Add at least one step.'); return; }
    MACROS.unshift({
      id: macNextId(),
      name,
      icon: document.getElementById('mac-icon').value.trim() || '⚡',
      description: document.getElementById('mac-desc').value.trim(),
      actions,
      usageCount: 0,
      lastUsed: null,
    });
    closeModal(); renderPage('macros');
  }, 'Create');
}

function macEdit(id) {
  if (!window.isAdmin()) return;
  const m = MACROS.find(x => x.id === id); if (!m) return;
  showModal('Edit macro · ' + m.id, macFormBody(m), () => {
    const name = document.getElementById('mac-name').value.trim();
    if (!name) { alert('Name is required.'); return; }
    const actions = _macReadDraft().filter(a => a.kind && (a.value || a.text || a.templateId));
    if (!actions.length) { alert('Add at least one step.'); return; }
    m.name = name;
    m.icon = document.getElementById('mac-icon').value.trim() || '⚡';
    m.description = document.getElementById('mac-desc').value.trim();
    m.actions = actions;
    closeModal(); renderPage('macros');
  }, 'Save');
}

function macDelete(id) {
  if (!window.isAdmin()) return;
  const m = MACROS.find(x => x.id === id); if (!m) return;
  showModal('Delete macro', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(m.name)}</strong>?</div>`, () => {
    const i = MACROS.findIndex(x => x.id === id);
    if (i >= 0) MACROS.splice(i, 1);
    closeModal(); renderPage('macros');
  }, 'Delete');
}

export function renderMacros() {
  const admin = window.isAdmin();
  const ql = MACRO_FILTER_QUERY.trim().toLowerCase();
  let list = [...MACROS];
  if (ql) list = list.filter(m =>
    m.name.toLowerCase().includes(ql) ||
    (m.description||'').toLowerCase().includes(ql) ||
    (m.actions||[]).some(a => (a.value||a.text||a.templateId||'').toLowerCase().includes(ql))
  );
  const total = MACROS.length;
  const totalUses = MACROS.reduce((s, m) => s + (m.usageCount || 0), 0);
  const top = [...MACROS].sort((a,b) => (b.usageCount||0) - (a.usageCount||0))[0];

  const rows = list.map(m => `
    <tr>
      <td><span style="font-size:14px;margin-right:6px">${window.escHtml(m.icon || '⚡')}</span><strong>${window.escHtml(m.name)}</strong></td>
      <td style="color:var(--ink2)">${window.escHtml(m.description || '')}</td>
      <td>
        <div style="font-size:11px;color:var(--ink2);line-height:1.6">
          ${(m.actions || []).map(a => `<span style="display:inline-block;margin-right:6px">${macActionSummary(a)}</span>`).join('')}
        </div>
      </td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${m.usageCount || 0}</td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${window.escHtml(m.lastUsed || '—')}</td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" data-action="macros.edit" data-id="${window.escAttr(m.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="macros.delete" data-id="${window.escAttr(m.id)}">Delete</button>
      </td>` : ''}
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Macros</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" data-action="macros.new">+ New Macro</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Macros</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${totalUses}</div><div class="kpi-l">Total uses</div></div>
        <div class="kpi"><div class="kpi-n c-purple" style="font-size:18px;line-height:1.1">${top ? window.escHtml(top.name) : '—'}</div><div class="kpi-l">Most used ${top ? '· ' + (top.usageCount || 0) : ''}</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Search</span>
        <input class="filter-select" placeholder="name, description, action…" style="width:300px" value="${window.escHtml(MACRO_FILTER_QUERY)}" data-input-action="macros.filter"/>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th>Macro</th><th>Description</th><th>Steps</th><th>Uses</th><th>Last used</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No macros match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Macros run on a single ticket from the ticket sidebar (<strong style="color:var(--ink2)">⚡ Apply macro</strong>) or across a selection from the tickets list bulk action bar. Steps run in order through the standard mutation paths so audit logging, SLA refresh, and CSAT triggers stay correct.</div>
      </div>
    </div>`;
}

registerActions({
  'macros.insert':     (ds) => insertMacro(ds.id, parseInt(ds.idx, 10)),
  'macros.gotoManage': () => { closeModal(); navTo('macros'); },
  'macros.removeStep': (ds) => macRemoveStep(parseInt(ds.idx, 10)),
  'macros.addStep':    () => macAddStep(),
  'macros.edit':       (ds) => macEdit(ds.id),
  'macros.delete':     (ds) => macDelete(ds.id),
  'macros.new':        () => macNew(),
});

registerChangeActions({
  // step-kind select in the macro editor (idx on data-idx, new kind on el.value)
  'macros.stepKind': (ds, el) => macStepKindChange(parseInt(ds.idx, 10), el.value),
  // bulk "run macro" select rendered by tickets/list.js
  'macros.bulkRun':  (ds, el) => bulkRunMacro(el.value),
});

registerMousedownActions({
  // apply-macro picker rows — mousedown so it fires before the modal dismiss
  'macros.runAndClose': (ds) => { closeModal(); runMacro(ds.macroId, ds.ticketId); },
});

registerInputActions({
  'macros.filter': (ds, el) => { setMacroFilterQuery(el.value); renderPage('macros'); },
});
