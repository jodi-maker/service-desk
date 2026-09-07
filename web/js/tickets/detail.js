// ─── Ticket Detail ────────────────────────────────────────────────────────────
// The per-ticket detail view: header banners (snooze / merged), full sidebar
// (timing, SLA gauge, custom fields, mentions, attachments, linked tickets,
// macros, AI summary, KB suggestions), the activity log, and the compose
// pane with its AI / send / translate / mention controls. The create flow
// lives in tickets/new-ticket.js (which imports openTicket and
// notifyReplyDelivery from here).
//
// External reaches (interim, via window): escAttr, escHtml, fmtMinutes —
// all still in app.js. navTo is a direct ES import.

import { AGENTS, CANNED_RESPONSES, CUSTOMERS, KB_ARTICLES, TAG_LIBRARY, TICKETS } from '../core/data.js';
import { COMPOSE_TAB, CURRENT_TICKET, SESSION, TICKET_SELECTED_IDS, setAiThinking, setComposeTabValue, setCurrentTicket, setKbSelected } from '../core/state.js';
import { renderPage, updateNavBadges } from '../core/router.js';
import { summarizeTicket, clearTicketSummary } from '../ai/summarize.js';
import {
  AGENT_PREFERRED_LANG, TRANSLATOR_LANGS,
  translateText, translateMessage, hideMessageTranslation,
  toggleThreadTranslate, toggleAutoTranslateReplies,
  setCustomerLanguage,
} from '../ai/translate.js';
import { aiAction } from '../ai/reply.js';
import { AI_API_KEY } from '../ai/client.js';
import {
  ticketTotalMinutes, ticketBillableMinutes,
  removeTimeEntry, showLogTimeModal,
} from './time-tracking.js';
import {
  formatSnoozeUntil, unsnoozeTicket, showSnoozeModal,
} from './snooze.js';
import {
  BUSINESS_HOURS, isWithinBusinessHours,
  computeTicketSLA, refreshTicketSLA, fmtSLAMinutes,
} from './sla.js';
import {
  unlinkTicket, unmergeTicket,
  showLinkTicketModal, showMergeTicketModal,
} from './linked.js';
import {
  parseMentions, renderTextWithMentions,
  updateMentionDropdown, hideMentionDropdown,
  mentionDropdownKey,
} from './mentions.js';
import { loadDraft, saveDraft, clearDraft, clearAllDrafts } from './drafts.js';
import { logTicketEvent, getTicketEvents } from '../core/activity-log.js';
import { showMacroPanel, showApplyMacroModal } from './macros.js';
import { showAttachPanel } from './attachments.js';
import { renderAttachmentChips } from './attachment-chips.js';
import {
  appendText, clear as clearComposer, getHtml, getPlainText, insertAtCursor,
  isEmpty as isComposerEmpty, mountComposer,
} from './composer.js';
import { pendingAttachmentIds, renderPendingAttachments, clearPendingAttachments } from './attachments.js';
import { captureTicketLayout, setComposerMode, syncTicketLayout } from './layout.js';
import { enableRemoteImages, renderMessageBody, sizeMessageFrames } from './message-html.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';
import { loadTicketDetail } from '../core/bootstrap.js';
import { apiPatch, apiPost, apiDelete } from '../core/api-client.js';
import { showToast } from '../core/toast.js';
import {
  KB_INTEGRATION, KB_TICKET_CACHE,
  refreshTicketKbSuggestions,
} from '../kb-integration/index.js';
import { showModal, closeModal, showDangerConfirm } from '../core/modal.js';
import { ticketCSATBlock } from './csat.js';
import { runAssignmentRulesOnTicket, isAgentOOO } from './assignment-rules.js';
import { showGDPRModal, openCustomerModal } from '../customers/modals.js';
import { navTo } from '../core/keybindings.js';
import {
  startPresence, setComposing, confirmIfOthersComposing,
  setTicketChangedCallback,
} from '../core/presence.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';

// Live-sync hook: presence reports the server's tickets.updated_at on
// every heartbeat. When it moves (because another agent replied, tagged,
// re-assigned, etc.), force-reload the ticket detail and re-render iff
// the user is still on it. CURRENT_TICKET comes from core/state.js; the
// TICKETS lookup translates the heartbeat's uuid to our display_id.
//
// Locally-driven mutations also bump the server's updated_at, so the
// next heartbeat fires this callback too — refetch is redundant but
// harmless (~50ms) and self-corrects any local/canonical drift.
// Reload a ticket (and re-render it if it's the one open) given its server
// uuid. Driven by both the presence heartbeat's ticket_updated_at delta and
// the Pubby `ticket.changed` push (js/core/realtime.js) — same self-correcting
// refetch either way.
export function reloadTicketByUuid(changedUuid) {
  const t = TICKETS.find((x) => x._uuid === changedUuid);
  if (!t) return;
  loadTicketDetail(t.id, { force: true }).then(() => {
    if (CURRENT_TICKET === t.id) openTicket(t.id);
  }).catch((err) => console.warn('[ticket-detail] live-sync reload failed:', err));
}
setTicketChangedCallback(({ uuid: changedUuid }) => reloadTicketByUuid(changedUuid));

// Sentiment badge for customer messages — colored dot + label next to
// the author name. Skipped silently when sentiment is null (not yet
// classified, or AI off for the workspace) and for neutral, which is
// the common case and doesn't need a visual cue.
function renderSentimentBadge(sentiment) {
  if (!sentiment || sentiment === 'neutral') return '';
  const palette = {
    angry:      { color: 'var(--red)',   label: 'ANGRY' },
    frustrated: { color: 'var(--amber)', label: 'FRUSTRATED' },
    positive:   { color: 'var(--green)', label: 'POSITIVE' },
  };
  const p = palette[sentiment];
  if (!p) return '';
  return ` <span title="AI sentiment: ${sentiment}" style="margin-left:8px;display:inline-flex;align-items:center;gap:4px;padding:1px 6px;font-size:9px;font-weight:600;color:${p.color};background:transparent;border:1px solid ${p.color};border-radius:3px;font-family:'DM Mono',monospace;letter-spacing:.04em">${p.label}</span>`;
}

export function openTicket(id) {
  const layout = captureTicketLayout(id);
  setCurrentTicket(id);
  const t = TICKETS.find(x => x.id === id);
  // Bad ticket IDs can reach here from stale notifications, deep-links
  // pasted from chat, or external modules calling window.openTicket after
  // a delete/merge. Fall back to the list so the page doesn't blank out.
  if (!t) { setCurrentTicket(null); return renderPage('tickets'); }
  // Fire-and-forget API load of messages/tags/ai_tags/time_entries. The
  // ticket renders immediately with whatever's already in `t`; when the
  // fetch completes, the entry is mutated in place and we re-render iff
  // the user is still on this ticket. Skipped for demo personas
  // (loadTicketDetail no-ops when `t._uuid` is absent) and idempotent.
  if (t._uuid && !t._detailLoaded) {
    loadTicketDetail(id).then(() => {
      if (CURRENT_TICKET === id) openTicket(id);
    }).catch(err => console.warn('[ticket-detail] load failed:', err));
  }
  // Real-time presence — heartbeat starts on first open and re-paints
  // chips on every re-render. No-ops for demo personas (no _uuid) so
  // the localStorage-only flow stays untouched.
  if (t._uuid && SESSION?.userId) startPresence('ticket', t._uuid);
  const cust = CUSTOMERS.find(c => c.id === t.customerId);
  const otherTickets = TICKETS.filter(x => x.customerId === t.customerId && x.id !== id && !x.mergedInto);
  const snoozeBanner = (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) ? `
    <div style="margin:0 0 10px;padding:8px 12px;background:var(--off2);border:1px solid var(--rule2);border-radius:var(--r);font-size:11px;color:var(--ink2);display:flex;align-items:center;gap:8px">
      <span style="font-size:14px">💤</span>
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)">Snoozed</span>
      <span style="color:var(--ink2)">${window.escHtml(formatSnoozeUntil(t.snoozedUntil))}</span>
      ${t.snoozeReason ? `<span style="color:var(--ink3);font-style:italic">· ${window.escHtml(t.snoozeReason)}</span>` : ''}
      <button class="btn btn-sm" style="margin-left:auto" data-action="td.unsnooze" data-ticket-id="${window.escAttr(t.id)}">Wake up</button>
    </div>` : '';
  const mergedFromIds = (t.mergedFrom || []);
  const mergedBanner = t.mergedInto ? `
    <div style="margin:0 0 10px;padding:8px 12px;background:var(--purple-lt);border:1px solid var(--purple);border-radius:var(--r);font-size:11px;color:var(--purple);display:flex;align-items:center;gap:8px">
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Merged duplicate</span>
      <span style="color:var(--ink2)">→</span>
      <span class="link" data-action="td.openTicket" data-ticket-id="${window.escAttr(t.mergedInto)}" style="color:var(--purple);font-weight:500">${window.escHtml(t.mergedInto)}</span>
      <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:10px">on ${window.escHtml(t.mergedAt || '—')}</span>
      <button class="btn btn-sm" style="margin-left:auto" data-action="td.unmerge" data-ticket-id="${window.escAttr(t.id)}">Un-merge</button>
    </div>` : '';
  const mergedFromBlock = mergedFromIds.length ? `
    <div class="ts-section">
      <div class="ts-heading">Merged duplicates (${mergedFromIds.length})</div>
      ${mergedFromIds.map(mid => {
        const m = TICKETS.find(x => x.id === mid);
        if (!m) return '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0;cursor:pointer" data-action="td.openTicket" data-ticket-id="${window.escAttr(mid)}">
              <div style="font-size:11.5px;color:var(--ink2);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(m.subject)}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                <span class="tag" style="font-size:9px;background:var(--purple-lt);color:var(--purple);border:1px solid var(--purple)">merged</span>
                <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(mid)} · ${window.escHtml(m.mergedAt || '—')}</span>
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>` : '';
  const csatScore = cust ? TICKETS.filter(x=>x.customerId===cust.id&&x.csat).reduce((a,x)=>a+x.csat,0) / (TICKETS.filter(x=>x.customerId===cust.id&&x.csat).length||1) : 0;
  const csatColor = csatScore >= 4 ? 'var(--green)' : csatScore >= 3 ? 'var(--blue)' : 'var(--red)';
  const csatPct = Math.round((csatScore/5)*100);
  const circumference = 2*Math.PI*18;
  const dash = (csatPct/100)*circumference;

  const pendingAITags = t.aiTags.filter(x => !x.accepted);
  const aiTagsHtml = pendingAITags.length ? `
    <div class="ts-section">
      <div class="ts-heading">AI Tag Suggestions</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
        ${pendingAITags.map(at=>`<span class="ai-tag-chip" data-action="td.acceptAITag" data-ticket-id="${window.escAttr(id)}" data-tag="${window.escAttr(at.tag)}">${at.tag} <span class="conf">${at.conf}%</span></span>`).join('')}
      </div>
      <button class="btn btn-sm" data-action="td.acceptAllAITags" data-ticket-id="${window.escAttr(id)}">Accept all</button>
    </div>` : '';

  const times = getTicketTimes(t);
  const timeBlock = `
    <div class="ts-section">
      <div class="ts-heading">Timing</div>
      <div class="ts-row"><span class="ts-key">Created</span><span class="ts-val">${times.created}</span></div>
      <div class="ts-row"><span class="ts-key">Age</span><span class="ts-val">${times.age}</span></div>
      <div class="ts-row"><span class="ts-key">First response</span><span class="ts-val">${times.firstResp}</span></div>
      <div class="ts-row"><span class="ts-key">Last update</span><span class="ts-val">${times.lastUpdate}</span></div>
      ${t.attachments && t.attachments.length ? `<div class="ts-row"><span class="ts-key">Attachments</span><span class="ts-val"><span class="link" data-action="td.showAttach" data-ticket-id="${window.escAttr(id)}">${t.attachments.length}</span></span></div>` : ''}
    </div>`;

  // SLA evaluation block — computed live from policies + ticket timing.
  const sla = computeTicketSLA(t);
  const slaColor = s => s === 'breach' ? 'var(--red)' : s === 'warn' ? 'var(--amber)' : s === 'snoozed' ? 'var(--ink3)' : 'var(--green)';
  const slaBar = (used, total, status) => {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    return `<div style="height:5px;background:var(--off2);border-radius:3px;overflow:hidden;margin-top:4px"><div style="height:100%;background:${slaColor(status)};width:${pct}%;transition:width .25s"></div></div>`;
  };
  const bhActive = BUSINESS_HOURS.enabled;
  const bhPaused = bhActive && !isWithinBusinessHours(new Date());
  const slaBlock = `
    <div class="ts-section">
      <div class="ts-heading">SLA${bhPaused ? ' <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink3);font-size:10px;font-style:italic;margin-left:4px">· paused (outside hours)</span>' : ''}</div>
      ${sla.policy ? `
        <div class="ts-row"><span class="ts-key">Policy</span><span class="ts-val"><span class="link" data-action="td.navTo" data-target="sla">${window.escHtml(sla.policy.name)}</span></span></div>
        ${bhActive ? `<div class="ts-row"><span class="ts-key">Hours</span><span class="ts-val"><span class="link" data-action="td.navTo" data-target="business-hours">Business hours</span></span></div>` : ''}
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2)">
            <span>First response</span>
            <span style="color:${slaColor(sla.firstResponseStatus)};font-weight:500;text-transform:uppercase;font-size:10px;letter-spacing:.06em">${window.escHtml(sla.firstResponseStatus)}</span>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${fmtSLAMinutes(sla.firstRespMin != null ? sla.firstRespMin : sla.elapsedMin)} ${sla.firstRespMin != null ? 'taken' : 'so far'} · target ${fmtSLAMinutes(sla.policy.firstResponseMin)}</div>
          ${slaBar(sla.firstRespMin != null ? sla.firstRespMin : sla.elapsedMin, sla.policy.firstResponseMin, sla.firstResponseStatus)}
        </div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2)">
            <span>Resolution</span>
            <span style="color:${slaColor(sla.resolutionStatus)};font-weight:500;text-transform:uppercase;font-size:10px;letter-spacing:.06em">${sla.isResolved ? 'resolved' : window.escHtml(sla.resolutionStatus)}</span>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${fmtSLAMinutes(sla.elapsedMin)} elapsed · target ${fmtSLAMinutes(sla.policy.resolutionMin)}</div>
          ${slaBar(sla.elapsedMin, sla.policy.resolutionMin, sla.isResolved ? 'ok' : sla.resolutionStatus)}
        </div>
      ` : `<div style="font-size:11px;color:var(--ink3);font-style:italic">No active policy matches this ticket. Configure one in <span class="link" data-action="td.navTo" data-target="sla">SLA Policies</span>.</div>`}
    </div>`;

  const summarizing = t.aiSummary && t.aiSummary.summarizing;
  const summary = t.aiSummary && !t.aiSummary.summarizing ? t.aiSummary : null;
  const summaryStale = summary && summary.coveredMsgCount !== undefined && summary.coveredMsgCount !== null && (t.msgs || []).length > summary.coveredMsgCount;
  const aiSummaryBlock = summarizing ? `
    <div class="ts-section">
      <div class="ts-heading">AI Summary <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--purple);font-size:10px;font-style:italic;margin-left:4px">generating…</span></div>
      <div style="font-size:11px;color:var(--ink3);font-style:italic">Talking to Claude…</div>
    </div>` : (summary ? `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">AI Summary${summaryStale ? '<span class="ts-stale-badge">stale</span>' : ''}</div>
        <span style="display:flex;gap:10px">
          <span class="link" data-action="td.summarize" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">Refresh</span>
          <span class="link" data-action="td.clearSummary" data-ticket-id="${window.escAttr(id)}" style="font-size:11px;color:var(--ink3)">×</span>
        </span>
      </div>
      ${summary.error ? `<div style="font-size:11px;color:var(--red);font-style:italic">${window.escHtml(summary.error)}</div>` : `
        <div style="font-size:12px;color:var(--ink);line-height:1.5;margin-bottom:8px">${window.escHtml(summary.tldr || '')}</div>
        ${summary.issue ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--purple);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Issue · </strong>${window.escHtml(summary.issue)}</div>` : ''}
        ${summary.done ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--green);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Done · </strong>${window.escHtml(summary.done)}</div>` : ''}
        ${summary.next ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--amber);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Next · </strong>${window.escHtml(summary.next)}</div>` : ''}
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:6px">covered ${summary.coveredMsgCount || 0} msg${summary.coveredMsgCount === 1 ? '' : 's'} · ${window.escHtml((summary.generatedAt || '').slice(0, 16).replace('T', ' '))}</div>
      `}
    </div>` : '');

  const followers = t.followers || [];
  const watching = SESSION ? followers.includes(SESSION.name) : false;
  const followerAvatars = followers.map(name => {
    const ag = AGENTS.find(a => a.name === name);
    const initials = ag ? ag.initials : (name.split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase());
    return `<div title="${window.escAttr(name)}" style="width:22px;height:22px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0;margin-left:-6px;border:2px solid var(--off)">${initials}</div>`;
  }).join('');
  const followersBlock = `
    <div class="ts-section">
      <div class="ts-heading">Followers (${followers.length})</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;padding-left:6px">${followerAvatars || '<span style="font-size:11px;color:var(--ink3)">No followers yet</span>'}</div>
        <button class="btn btn-sm" data-action="td.toggleWatch" data-ticket-id="${window.escAttr(id)}">${watching ? 'Unfollow' : 'Follow'}</button>
      </div>
    </div>`;

  const kbSuggestions = getSuggestedKB(t);
  const kbBlock = kbSuggestions.length ? `
    <div class="ts-section">
      <div class="ts-heading">Suggested KB</div>
      ${kbSuggestions.map(a => `
        <div data-action="td.openKB" data-kb-id="${window.escAttr(a.id)}" style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;margin-bottom:5px;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='var(--rule)'">
          <div style="font-size:10px;color:var(--purple);text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:2px">${window.escHtml(a.category)}</div>
          <div style="font-size:12px;color:var(--ink);font-weight:500;line-height:1.3">${window.escHtml(a.title)}</div>
        </div>`).join('')}
    </div>` : '';

  // External-KB suggestions are fetched lazily and cached by ticket id. The
  // sidebar shows a loading shimmer first paint, then the results on the
  // re-render. If the integration is disabled the whole block stays hidden.
  let extKbBlock = '';
  if (KB_INTEGRATION.enabled) {
    const cache = KB_TICKET_CACHE.get(t.id);
    if (cache === undefined) setTimeout(() => refreshTicketKbSuggestions(t.id), 0);
    const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">External KB</div>
        <span class="link" data-action="td.refreshKB" data-ticket-id="${window.escAttr(t.id)}" style="font-size:11px">Refresh</span>
      </div>`;
    let body = '';
    if (!cache || cache.loading) body = '<div style="font-size:11px;color:var(--ink3);font-style:italic">Searching your KB…</div>';
    else if (cache.error)        body = `<div style="font-size:11px;color:var(--red);font-style:italic">${window.escHtml(cache.error)}</div>`;
    else if (!cache.articles.length) body = '<div style="font-size:11px;color:var(--ink3);font-style:italic">No matching articles.</div>';
    else body = cache.articles.map(a => {
      // External URL goes into an href, so escape with escHtml (handles ", &,
      // <, >). Also restrict to http(s) so a malicious KB can't ship a
      // javascript: link that runs on click.
      const safeUrl = (typeof a.url === 'string' && /^https?:\/\//i.test(a.url.trim())) ? a.url.trim() : '';
      return `
      <div style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);margin-bottom:5px;background:var(--off2)">
        ${safeUrl ? `<a href="${window.escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:var(--ink);font-weight:500;text-decoration:none;line-height:1.3">${window.escHtml(a.title)} ↗</a>` : `<div style="font-size:12px;color:var(--ink);font-weight:500;line-height:1.3">${window.escHtml(a.title)}</div>`}
        ${a.body ? `<div style="font-size:11px;color:var(--ink3);margin-top:4px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${window.escHtml(String(a.body).slice(0, 200))}</div>` : ''}
      </div>`;
    }).join('');
    extKbBlock = `<div class="ts-section">${head}${body}</div>`;
  }

  const totalTimeMin    = ticketTotalMinutes(t);
  const billableTimeMin = ticketBillableMinutes(t);
  const recentTime      = (t.timeEntries || []).slice(0, 4);
  const timeLogBlock = `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">Time logged${totalTimeMin ? ` · ${window.fmtMinutes(totalTimeMin)}` : ''}</div>
        <span class="link" data-action="td.logTime" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">+ Log time</span>
      </div>
      ${totalTimeMin ? `
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2);margin-bottom:8px">
          <span>Total <strong style="color:var(--ink)">${window.fmtMinutes(totalTimeMin)}</strong></span>
          <span>Billable <strong style="color:${billableTimeMin === totalTimeMin ? 'var(--ink)' : 'var(--amber)'}">${window.fmtMinutes(billableTimeMin)}</strong></span>
        </div>
        ${recentTime.map(e => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0">
              <div style="font-size:11.5px;color:var(--ink);font-weight:500">${window.fmtMinutes(e.minutes)}${e.billable === false ? ' <span style="color:var(--ink3);font-weight:400;font-size:10px">· non-billable</span>' : ''}</div>
              ${e.note ? `<div style="font-size:11px;color:var(--ink2);font-style:italic;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">"${window.escHtml(e.note)}"</div>` : ''}
              <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${window.escHtml(e.agent)} · ${window.escHtml(e.ts)}</div>
            </div>
            <button data-action="td.removeTime" data-ticket-id="${window.escAttr(id)}" data-entry-id="${window.escAttr(e.id)}" style="background:transparent;border:none;color:var(--ink3);cursor:pointer;font-size:14px;padding:4px 6px;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Remove entry">×</button>
          </div>`).join('')}
      ` : `<div style="font-size:11px;color:var(--ink3);text-align:center;padding:8px 0">No time logged yet</div>`}
    </div>`;

  const linkedIds = t.linked || [];
  const linkedBlock = `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">Linked tickets (${linkedIds.length})</div>
        <span style="display:flex;gap:10px">
          <span class="link" data-action="td.linkTicket" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">+ Link</span>
          ${t.mergedInto ? '' : `<span class="link" data-action="td.mergeTicket" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">↩ Merge</span>`}
        </span>
      </div>
      ${linkedIds.length ? linkedIds.map(linkedId => {
        const lt = TICKETS.find(x => x.id === linkedId);
        if (!lt) return '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0;cursor:pointer" data-action="td.openTicket" data-ticket-id="${window.escAttr(linkedId)}">
              <div style="font-size:11.5px;color:var(--ink2);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(lt.subject)}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                <span class="tag tag-${lt.status}" style="font-size:9px">${lt.status}</span>
                <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(linkedId)}</span>
              </div>
            </div>
            <button data-action="td.unlink" data-ticket-id="${window.escAttr(id)}" data-linked-id="${window.escAttr(linkedId)}" style="background:transparent;border:none;color:var(--ink3);cursor:pointer;font-size:14px;padding:4px 6px;flex-shrink:0;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Unlink">×</button>
          </div>`;
      }).join('') : '<div style="font-size:11px;color:var(--ink3);text-align:center;padding:8px 0">No linked tickets</div>'}
    </div>`;

  const eventColors = { status:'var(--cyan)', priority:'var(--amber)', agent:'var(--purple)', tag:'var(--green)', system:'var(--ink3)' };
  const events = getTicketEvents(t);
  const activityBlock = events.length ? `
    <div class="ts-section">
      <div class="ts-heading">Activity (${events.length})</div>
      <div style="max-height:240px;overflow-y:auto;margin-right:-4px;padding-right:4px">
        ${events.slice(0, 12).map(e => `
          <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="width:6px;height:6px;border-radius:50%;background:${eventColors[e.type] || 'var(--ink4)'};margin-top:5px;flex-shrink:0"></div>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;color:var(--ink2);line-height:1.4;word-break:break-word">${window.escHtml(e.details)}</div>
              <div style="font-size:10px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:2px">${e.author === 'System' ? '' : window.escHtml(e.author) + ' · '}${e.ts}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>` : '';

  const threadOn = !!t.translateThread;
  const msgsHtml = t.msgs.map((m, i) => {
    let translateBlock = '';
    let bodyText = m.t;
    let bodyNote = '';

    if (m.r === 'customer') {
      // Thread translation: show translation as the primary body when available
      if (threadOn && m.translatedFor === AGENT_PREFERRED_LANG && m.translation) {
        bodyText = m.translation;
        bodyNote = `<div style="margin-top:6px;font-size:10px;color:var(--ink3);font-style:italic">Translated from ${window.escHtml(t.detectedCustomerLang || 'auto')} → ${window.escHtml(AGENT_PREFERRED_LANG)} · <span class="link" data-action="td.hideTranslation" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">show original</span></div>`;
      } else if (m.translating) {
        translateBlock = '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule);font-size:11px;color:var(--purple);font-style:italic">Translating…</div>';
      } else if (m.translation) {
        translateBlock = `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule)">
          <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:4px">Translation</div>
          <div style="font-size:13px;color:var(--ink2);font-style:italic;line-height:1.55">${window.escHtml(m.translation)}</div>
          <div style="margin-top:6px"><span class="link" style="font-size:11px" data-action="td.hideTranslation" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">Hide translation</span></div>
        </div>`;
      } else {
        translateBlock = `<div style="margin-top:6px"><span class="link" style="font-size:11px" data-action="td.translateMsg" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">Translate</span></div>`;
      }
    } else if ((m.r === 'agent' || m.r === 'note') && m.tOriginal) {
      // Agent reply that was auto-translated for the customer — show what the agent typed
      bodyText = m.tOriginal;
      bodyNote = `<div style="margin-top:6px;font-size:10px;color:var(--ink3);font-style:italic">→ Sent to customer in ${window.escHtml(m.translatedTo || 'their language')} · <span class="link" data-action="td.showSentText" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">view sent text</span></div>`;
    }

    const plainBody = m.r === 'note'
      ? renderTextWithMentions(bodyText)
      : window.escHtml(bodyText).replace(/\n/g, '<br>');
    // A formatted email renders in a sandboxed frame; everything else (notes,
    // plain-text mail, and any message being shown as a translation or as the
    // agent's pre-translation original) keeps the escaped-text rendering.
    const showRich = !!m.html && bodyText === m.t;
    const bodyHtml = showRich ? renderMessageBody(m, id, i, plainBody) : plainBody;
    const attachHtml = renderAttachmentChips(m.attachments);
    const sentimentBadge = m.r === 'customer' ? renderSentimentBadge(m.sentiment) : '';
    return `
    <div class="msg msg-${m.r}">
      <div class="msg-from">${window.escHtml(m.from)} ${m.r==='ai'?'<span class="ai-mark">AI</span>':''} ${m.r==='note'?'<span class="note-mark">Note</span>':''}${sentimentBadge}<span style="margin-left:auto;font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3)">${window.escHtml(m.ts)}</span></div>
      ${bodyHtml}
      ${attachHtml}
      ${bodyNote}
      ${translateBlock}
    </div>`;
  }).join('');

  // Thread translation toolbar — sits above the message thread
  const customerLangLabel = t.detectedCustomerLang
    ? `<span style="color:var(--ink2)">Customer language: <strong style="color:var(--ink)">${window.escHtml(t.detectedCustomerLang)}</strong></span>`
    : `<span style="color:var(--ink3);font-style:italic">Customer language: not yet detected</span>`;
  const langOptions = TRANSLATOR_LANGS.map(l => `<option value="${l}" ${t.detectedCustomerLang===l?'selected':''}>${l}</option>`).join('');
  const threadBarHtml = `
    <div class="ticket-thread-tools">
      <strong>Conversation</strong>
      <span class="ticket-translation-state">${t.autoTranslateReplies ? `Replies translated to ${window.escHtml(t.detectedCustomerLang || 'customer language')}` : ''}</span>
      <details class="ticket-popover ticket-language" ${layout.languageOpen ? 'open' : ''}>
        <summary class="btn btn-sm">${threadOn ? 'Translated' : 'Language'} ▾</summary>
        <div class="ticket-popover-panel">
      <label class="auth-check" style="margin:0">
        <input type="checkbox" ${threadOn?'checked':''} data-change-action="td.toggleThreadTranslate" data-ticket-id="${window.escAttr(id)}">
        <span>Translate thread to <strong style="color:var(--ink)">${window.escHtml(AGENT_PREFERRED_LANG)}</strong></span>
      </label>
      <span style="color:var(--rule2)">·</span>
      ${customerLangLabel}
      ${(threadOn || t.autoTranslateReplies) ? `<select class="filter-select" data-change-action="td.setCustomerLang" data-ticket-id="${window.escAttr(id)}" style="font-size:11px;padding:3px 8px"><option value="">— override —</option>${langOptions}</select>` : ''}
      <span style="color:var(--rule2)">·</span>
      <label class="auth-check" style="margin:0">
        <input type="checkbox" ${t.autoTranslateReplies?'checked':''} data-change-action="td.toggleAutoTranslate" data-ticket-id="${window.escAttr(id)}">
        <span>Send replies in customer language</span>
      </label>
      ${!AI_API_KEY ? '<span style="margin-left:auto;color:var(--amber);font-family:\'DM Mono\',monospace;font-size:10px">Add API key in Settings → AI</span>' : ''}
        </div>
      </details>
      <button class="btn btn-sm" data-action="tl.details" data-ticket-id="${window.escAttr(id)}" aria-controls="ticket-details-${id}" aria-expanded="false">Details</button>
    </div>`;

  // Sentiment backfill nudge — only when this is a real (api-backed)
  // ticket AND it has at least one customer message that hasn't been
  // scored yet. Demo personas + already-scored tickets never see it.
  const unscoredCount = t._uuid
    ? (t.msgs || []).filter(m => m.r === 'customer' && !m.sentiment && (m.t || '').trim()).length
    : 0;
  const sentimentBackfillBar = unscoredCount > 0 ? `
    <div style="padding:6px 14px;border-bottom:1px solid var(--rule);background:var(--off2);display:flex;align-items:center;gap:10px;font-size:11px;color:var(--ink3)">
      <span>${unscoredCount} customer message${unscoredCount === 1 ? '' : 's'} not yet scored for sentiment.</span>
      <button class="btn btn-sm" data-action="td.backfillSentiment" data-ticket-id="${window.escAttr(id)}" style="margin-left:auto">Score now</button>
    </div>` : '';

  const main = document.getElementById('main-area');
  // Preserve the reader's place across in-place re-renders (openTicket is also
  // the re-render path for tag/status edits, presence repaints, async loads,
  // etc.). main.innerHTML below rebuilds a fresh .thread scrolled to the top,
  // so capture the outgoing thread's position first: keep it only if the same
  // ticket was already open AND scrolled up from the bottom; otherwise (a fresh
  // open, or already pinned to the newest message) we jump to the latest reply.
  const prevThread = document.getElementById('thread-' + id);
  const keepScroll = prevThread &&
    (prevThread.scrollHeight - prevThread.scrollTop - prevThread.clientHeight > 40)
      ? prevThread.scrollTop : null;
  main.innerHTML = `
    <div class="page ticket-page" id="ticket-page-${id}" data-ticket-id="${window.escAttr(id)}" data-compose-mode="${layout.mode}" data-details="${layout.details}">
      <div class="topbar ticket-topbar">
        <div class="tb-breadcrumb">
          <button class="ticket-back" data-action="td.openTicketsList">Tickets</button>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${t.id}</span>
          <span class="ticket-header-actions">
            <div id="presence-chips" class="presence-chips" aria-label="Agents viewing this ticket"></div>
            <button class="btn btn-sm" data-action="td.prev" aria-label="Previous ticket">← Prev</button>
            <button class="btn btn-sm" data-action="td.next" aria-label="Next ticket">Next →</button>
            <details class="ticket-popover ticket-more">
              <summary class="btn btn-sm">More ▾</summary>
              <div class="ticket-popover-panel">
            ${t.mergedInto ? '' : `<button class="btn btn-sm" data-action="td.summarize" data-ticket-id="${window.escAttr(id)}" title="Generate an AI summary of this ticket"${summarizing ? ' disabled' : ''}>${summarizing ? '⏳' : '📝'} Summarize</button>`}
            ${t.mergedInto ? '' : `<button class="btn btn-sm" data-action="td.macroModal" data-ticket-id="${window.escAttr(id)}" title="Apply a macro">⚡ Macro</button>`}
            ${t.mergedInto ? '' : `<button class="btn btn-sm" data-action="td.runRules" data-ticket-id="${window.escAttr(id)}" title="Auto-assign by rules">⇄ Run rules</button>`}
            ${t.status !== 'escalated' && t.status !== 'resolved' ? `<button class="btn btn-sm" data-action="td.quickStatus" data-ticket-id="${window.escAttr(id)}" data-status="escalated">Escalate</button>` : ''}
            ${t.status !== 'resolved' ? (t.snoozedUntil
              ? `<button class="btn btn-sm" data-action="td.unsnooze" data-ticket-id="${window.escAttr(id)}" title="Wake the ticket up now">💤 Wake up</button>`
              : `<button class="btn btn-sm" data-action="td.snooze" data-ticket-id="${window.escAttr(id)}" title="Pause SLA until a chosen time">💤 Snooze</button>`) : ''}
                <button class="btn btn-sm" data-action="td.gdprModal" data-ticket-id="${window.escAttr(id)}">Privacy / GDPR</button>
              </div>
            </details>
            ${t.status !== 'resolved'
              ? `<button class="btn btn-sm btn-solid" data-action="td.quickStatus" data-ticket-id="${window.escAttr(id)}" data-status="resolved">Resolve</button>`
              : `<button class="btn btn-sm" data-action="td.quickStatus" data-ticket-id="${window.escAttr(id)}" data-status="open">Reopen</button>`}
          </span>
        </div>
      </div>
      <div class="ticket-heading">
        ${mergedBanner}
        ${snoozeBanner}
        <div style="font-family:\'Syne\',sans-serif;font-size:17px;font-weight:700;color:var(--ink);letter-spacing:-.02em;margin-bottom:7px">${window.escHtml(t.subject)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span class="tag tag-${t.status}">${t.status}</span>
          <span class="tag tag-${t.priority}">${t.priority}</span>
          <span class="tag tag-neutral">${window.escHtml(t.category)}</span>
          ${t.tags.map(tg=>`<span class="tag tag-neutral" style="display:inline-flex;align-items:center;gap:4px">${window.escHtml(tg)}<span style="cursor:pointer;color:var(--ink3);font-weight:400" data-action="td.removeTag" data-ticket-id="${window.escAttr(id)}" data-tag="${window.escAttr(tg)}" title="Remove tag">×</span></span>`).join('')}
          <input id="tag-add-${id}" data-tag-add-id="${window.escAttr(id)}" placeholder="+ tag" style="background:transparent;border:1px dashed var(--rule2);border-radius:3px;padding:2px 8px;font-size:10px;color:var(--ink2);width:90px;outline:none;font-family:'Inter',sans-serif;letter-spacing:.03em;text-transform:uppercase"/>
          <span style="font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3);margin-left:auto">SLA: <span class="sla-${t.sla}">${t.sla.toUpperCase()}</span></span>
        </div>
      </div>
      <div class="ticket-layout">
        <div class="ticket-main">
          ${threadBarHtml}
          <div class="thread" id="thread-${id}">${msgsHtml}</div>
          <div class="composer" data-compose-tab="${COMPOSE_TAB}">
            <div id="presence-banner"></div>
            <div class="composer-launcher">
              <button class="btn btn-sm btn-solid" data-action="td.setComposeTab" data-ticket-id="${window.escAttr(id)}" data-tab="reply" data-compose-launch aria-controls="composer-body-${id}" aria-expanded="${layout.mode !== 'read'}">Reply${loadDraft(id, 'reply') ? ' · draft' : ''}</button>
              <button class="btn btn-sm" data-action="td.setComposeTab" data-ticket-id="${window.escAttr(id)}" data-tab="note" data-compose-launch aria-controls="composer-body-${id}" aria-expanded="${layout.mode !== 'read'}">Internal note${loadDraft(id, 'note') ? ' · draft' : ''}</button>
              <span class="composer-launch-hint">${pendingAttachmentIds(id).length ? `${pendingAttachmentIds(id).length} ${pendingAttachmentIds(id).length === 1 ? 'attachment' : 'attachments'} ready` : 'Write a reply…'}</span>
            </div>
            <div class="composer-tabs">
              <button class="ctab ${COMPOSE_TAB==='reply'?'active':''}" aria-pressed="${COMPOSE_TAB==='reply'}" data-action="td.setComposeTab" data-ticket-id="${window.escAttr(id)}" data-tab="reply">Reply</button>
              <button class="ctab ${COMPOSE_TAB==='note'?'active':''}" aria-pressed="${COMPOSE_TAB==='note'}" data-action="td.setComposeTab" data-ticket-id="${window.escAttr(id)}" data-tab="note">Internal note</button>
              <span class="composer-view-actions">
                <button class="btn btn-sm" data-action="tl.minimise" data-ticket-id="${window.escAttr(id)}">Minimise</button>
                <button class="btn btn-sm" data-action="tl.expand" data-ticket-id="${window.escAttr(id)}" aria-expanded="${layout.mode === 'expanded'}">${layout.mode === 'expanded' ? 'Restore' : 'Expand'}</button>
              </span>
            </div>
            <div class="composer-body" id="composer-body-${id}">
              ${COMPOSE_TAB === 'reply'
                // Rich editor host. Quill mounts into it after render
                // (mountComposer below); the draft is restored as HTML there.
                ? `<div class="compose-area compose-rich" id="compose-${id}" data-rich="1" data-ticket-id="${window.escAttr(id)}"></div>`
                : `<textarea class="compose-area" id="compose-${id}" data-ticket-id="${window.escAttr(id)}" data-input-action="td.composeInput" placeholder="Add an internal note… type @ to mention an agent">${window.escHtml(loadDraft(id))}</textarea>`}
              ${COMPOSE_TAB === 'reply' ? `<div class="pending-att" id="pending-att-${id}"></div>` : ''}
              <div class="comp-meta">
                <span id="draft-status-${id}">${loadDraft(id) ? 'Draft restored' : ''}</span>
                <span id="char-count-${id}">${loadDraft(id).length} chars</span>
              </div>
              <div class="composer-foot">
                <div class="composer-actions">
                  <button class="btn btn-sm" data-action="td.macroPanel" data-ticket-id="${window.escAttr(id)}">Macros</button>
                  <button class="btn btn-sm" data-action="td.showAttach" data-ticket-id="${window.escAttr(id)}">Attach${t.attachments&&t.attachments.length?' · '+t.attachments.length:''}</button>
                  <details class="ticket-popover composer-insert">
                    <summary class="btn btn-sm">Insert ▾</summary>
                    <div class="ticket-popover-panel">
                      <button class="btn btn-sm" data-action="td.insertVar" data-ticket-id="${window.escAttr(id)}" data-token="{name}">Customer name</button>
                      <button class="btn btn-sm" data-action="td.insertVar" data-ticket-id="${window.escAttr(id)}" data-token="{ticket}">Ticket ID</button>
                      <button class="btn btn-sm" data-action="td.insertVar" data-ticket-id="${window.escAttr(id)}" data-token="{brand}">Brand</button>
                      <button class="btn btn-sm" data-action="td.insertVar" data-ticket-id="${window.escAttr(id)}" data-token="{agent}">Agent name</button>
                    </div>
                  </details>
                  <div class="thinking" id="thinking-${id}"><span class="dot">·</span><span class="dot">·</span><span class="dot">·</span>&nbsp;working</div>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  ${COMPOSE_TAB==='reply' ? `
                  <div style="position:relative;display:inline-block">
                    <button class="btn btn-sm" data-action="td.toggleAIMenu" data-ticket-id="${window.escAttr(id)}">AI ▾</button>
                    <div id="ai-menu-${id}" class="comp-menu">
                      <div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="draft">Draft reply</div>
                      ${KB_INTEGRATION.enabled ? `<div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="kb-reply" title="Draft a reply grounded in your external KB">Draft reply with KB</div>` : ''}
                      <div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="improve">Improve writing</div>
                      <div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="shorten">Shorten</div>
                      <div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="lengthen">Add detail</div>
                      <div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="friendly">Friendlier tone</div>
                      <div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="formal">More formal</div>
                      <div class="comp-menu-item" data-action="td.aiAction" data-ticket-id="${window.escAttr(id)}" data-verb="translate">Translate to English</div>
                    </div>
                  </div>` : ''}
                  <div style="position:relative;display:inline-flex">
                    <button class="btn btn-sm btn-solid" style="border-radius:var(--r) 0 0 var(--r);border-right:1px solid rgba(255,255,255,0.25)" data-action="td.send" data-ticket-id="${window.escAttr(id)}">${COMPOSE_TAB==='reply'?'Send':'Add note'}</button>
                    <button class="btn btn-sm btn-solid" style="border-radius:0 var(--r) var(--r) 0;padding:5px 8px" data-action="td.toggleSendMenu" data-ticket-id="${window.escAttr(id)}" title="More send options">▾</button>
                    <div id="send-menu-${id}" class="comp-menu">
                      <div class="comp-menu-item" data-action="td.sendAnd" data-ticket-id="${window.escAttr(id)}" data-status="resolved">${COMPOSE_TAB==='reply'?'Send':'Add note'} and resolve</div>
                      <div class="comp-menu-item" data-action="td.sendAnd" data-ticket-id="${window.escAttr(id)}" data-status="pending">${COMPOSE_TAB==='reply'?'Send':'Add note'} and set pending</div>
                      <div class="comp-menu-item" data-action="td.sendAnd" data-ticket-id="${window.escAttr(id)}" data-status="escalated">${COMPOSE_TAB==='reply'?'Send':'Add note'} and escalate</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <aside class="ticket-sidebar" id="ticket-details-${id}" aria-label="Ticket details">
          <div class="ticket-details-header"><strong>Ticket details</strong><button class="btn btn-sm" data-action="tl.closeDetails" data-ticket-id="${window.escAttr(id)}" aria-label="Close ticket details">Close</button></div>
          ${cust?`
          <div class="ts-section" style="cursor:pointer" data-action="td.openCustomer" data-cust-id="${window.escAttr(cust.id)}">
            <div class="ts-heading">Customer</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--w);flex-shrink:0">${window.escHtml(cust.first[0])}${window.escHtml(cust.last[0])}</div>
              <div><div style="font-size:12px;font-weight:500;color:var(--ink)">${window.escHtml(cust.first)} ${window.escHtml(cust.last)}</div><div style="font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3)">${cust.id}</div></div>
            </div>
            <div class="ts-row"><span class="ts-key">Brand</span><span class="ts-val">${window.escHtml(cust.brand)}</span></div>
            <div class="ts-row"><span class="ts-key">VIP</span><span class="vip-badge vip-${cust.vip.toLowerCase()}">${window.escHtml(cust.vip)}</span></div>
            <div class="ts-row"><span class="ts-key">Jurisdiction</span><span class="ts-val">${window.escHtml(cust.jurisdiction)}</span></div>
          </div>`:``}
          <div class="ts-section">
            <div class="ts-heading">Properties</div>
            <select class="ts-select" aria-label="Ticket status" data-change-action="td.setStatus" data-ticket-id="${window.escAttr(id)}">
              <option value="open" ${t.status==='open'?'selected':''}>Open</option>
              <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
              <option value="escalated" ${t.status==='escalated'?'selected':''}>Escalated</option>
              <option value="gdpr" ${t.status==='gdpr'?'selected':''}>GDPR</option>
              <option value="resolved" ${t.status==='resolved'?'selected':''}>Resolved</option>
            </select>
            <select class="ts-select" aria-label="Ticket priority" data-change-action="td.setPriority" data-ticket-id="${window.escAttr(id)}">
              <option value="urgent" ${t.priority==='urgent'?'selected':''}>Urgent</option>
              <option value="high" ${t.priority==='high'?'selected':''}>High</option>
              <option value="normal" ${t.priority==='normal'?'selected':''}>Normal</option>
              <option value="low" ${t.priority==='low'?'selected':''}>Low</option>
            </select>
            <select class="ts-select" aria-label="Assigned agent" data-change-action="td.setAgent" data-ticket-id="${window.escAttr(id)}">
              ${AGENTS.map(a=>`<option value="${window.escAttr(a.name)}" ${t.agent===a.name?'selected':''}>${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
            </select>
          </div>
          ${unscoredCount > 0 ? `<details class="ts-section ticket-secondary"><summary>Sentiment · ${unscoredCount} unscored</summary>${sentimentBackfillBar}</details>` : ''}
          <details class="ts-section ticket-secondary"><summary>Customer satisfaction</summary>
          <div class="ts-section">
            <div class="ts-heading">CSAT</div>
            <div class="csat-ring-wrap">
              <div class="csat-ring">
                <svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--rule)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" stroke="${csatColor}" stroke-width="4" stroke-dasharray="${dash} ${circumference-dash}" stroke-linecap="round"/></svg>
                <div class="csat-inner" style="color:${csatColor};font-size:10px">${csatScore>0?csatScore.toFixed(1):'—'}</div>
              </div>
              <div style="font-size:11px;color:var(--ink2)">Avg score<br/><span style="color:var(--ink3);font-family:'Inter',sans-serif;font-size:11px">${TICKETS.filter(x=>x.customerId===t.customerId&&x.csat).length} rated tickets</span></div>
            </div>
          </div>
          ${ticketCSATBlock(t)}
          </details>
          ${aiSummaryBlock}
          ${timeBlock}
          ${slaBlock}
          ${aiTagsHtml}
          ${followersBlock}
          ${kbBlock}
          ${extKbBlock}
          ${timeLogBlock}
          ${t.status==='gdpr'||t.category==='GDPR'?`
          <div class="ts-section">
            <div class="ts-heading">GDPR Actions</div>
            <button class="btn btn-sm btn-danger" style="width:100%;margin-bottom:5px;justify-content:center" data-action="td.gdprErasure">Request Erasure</button>
            <button class="btn btn-sm" style="width:100%;margin-bottom:5px;justify-content:center" data-action="td.gdprRedact">Redact Data</button>
            <button class="btn btn-sm" style="width:100%;justify-content:center" data-action="td.gdprExport">SAR Export</button>
          </div>`:''}
          ${mergedFromBlock}
          ${linkedBlock}
          ${otherTickets.length?`
          <div class="ts-section">
            <div class="ts-heading">Other tickets (${otherTickets.length})</div>
            ${otherTickets.map(ot=>`
              <div class="other-ticket" data-action="td.openTicket" data-ticket-id="${window.escAttr(ot.id)}">
                <div class="other-ticket-subj">${window.escHtml(ot.subject)}</div>
                <span class="tag tag-${ot.status}">${ot.status}</span>
              </div>`).join('')}
          </div>`:''}
          ${activityBlock}
          ${(window.canDeleteRecords() || isTicketBlank(t)) ? `
          <div class="ts-section">
            <div class="ts-heading">Danger zone</div>
            <button class="btn btn-sm btn-danger" style="width:100%;justify-content:center" data-action="td.deleteTicket" data-ticket-id="${window.escAttr(id)}">Delete ticket</button>
            ${!window.canDeleteRecords() ? `<div style="font-size:10.5px;color:var(--ink3);margin-top:6px;line-height:1.4">Deletable because this ticket has no messages or notes yet.</div>` : ''}
          </div>` : ''}
        </aside>
      </div>
    </div>`;
  syncTicketLayout(id);

  // Show the most recent reply on open: scroll to the bottom, unless we're
  // restoring a scrolled-up reader's position from an in-place re-render.
  const thread = document.getElementById('thread-' + id);
  // Formatted bodies live in iframes, which have no intrinsic height. Sizing
  // them is asynchronous and changes the thread's scrollHeight, so re-apply
  // the scroll position after each frame settles — otherwise "scrolled to the
  // newest message" silently becomes "scrolled to wherever it was".
  const applyScroll = () => {
    if (!thread) return;
    thread.scrollTop = keepScroll === null ? thread.scrollHeight : keepScroll;
  };
  if (thread) sizeMessageFrames(thread, applyScroll);
  applyScroll();

  // Mount the rich editor for the reply tab and repaint the pending-upload
  // chips. Fire-and-forget: the composer falls back to plain text if the
  // editor can't load, and neither may break the render.
  if (COMPOSE_TAB === 'reply') {
    mountComposer(id, {
      initialHtml: loadDraft(id),
      placeholder: 'Write a reply or use AI…',
      onChange: () => onComposeInput(id),
    }).then(() => syncTicketLayout(id)).catch((err) => console.warn('[composer] mount failed:', err));
    renderPendingAttachments(id);
  }
}

function setComposeTab(tab, id) {
  const mode = captureTicketLayout(id).mode === 'expanded' ? 'expanded' : 'edit';
  if (COMPOSE_TAB === tab) { setComposerMode(id, mode, true); return; }
  setComposeTabValue(tab);
  openTicket(id);
  setComposerMode(id, mode, true);
}

// A ticket is BLANK when it holds no real messages — nothing from the
// customer, no sent agent/ai reply, no internal note; 'system' rows are
// merge/audit bookkeeping. Anyone may delete a blank ticket (one started in
// error — an unsent compose draft lives only in localStorage, so it can't
// make a ticket non-blank). For API tickets the thread must actually be
// loaded before we trust msgs (list rows carry msgs:[] until then); the
// server re-verifies with the same rule regardless.
function isTicketBlank(t) {
  if (t._uuid && !t._detailLoaded) return false;
  // KEEP IN SYNC with the server rule in api/src/routes/tickets.ts
  // DELETE /:id — blank ⇔ no message whose role is one of these four.
  const REAL_ROLES = ['customer', 'agent', 'ai', 'note'];
  return (t.msgs || []).every(m => !REAL_ROLES.includes(m.r));
}

function deleteTicketPrompt(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const blank = isTicketBlank(t);
  if (!window.canDeleteRecords() && !blank) return;
  showDangerConfirm({
    title: `Delete ${id}`,
    bodyHtml: `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(id)} · ${window.escHtml(t.subject || '')}</strong>${blank ? '' : ' and its full conversation history'}? This cannot be undone.</div>`,
    confirmLabel: 'Delete ticket',
    onConfirm: async () => {
      // Close before the await — a modal left open during the round-trip
      // fires a second DELETE on a double-click (spurious 404 alert).
      closeModal();
      if (t._uuid) {
        try { await apiDelete(`/api/v1/tickets/${t._uuid}`); }
        catch (err) { showToast(`Couldn't delete: ${err?.message || err}`, 'error', 6000); return; }
      }
      clearAllDrafts(id);
      const i = TICKETS.findIndex(x => x.id === id);
      if (i >= 0) TICKETS.splice(i, 1);
      // Drop it from any bulk selection too, or the list's bulk bar keeps
      // counting a ghost row.
      TICKET_SELECTED_IDS.delete(id);
      setCurrentTicket(null);
      updateNavBadges();
      renderPage('tickets');
    },
  });
}

function getTicketTimes(t) {
  const msgs = t.msgs || [];
  const customerMsgs = msgs.filter(m => m.r === 'customer');
  const agentMsgs = msgs.filter(m => m.r === 'agent' || m.r === 'ai');

  let firstResp = '—';
  if (customerMsgs.length && agentMsgs.length) {
    const cust = customerMsgs[0];
    const agentAfter = agentMsgs.find(a => msgs.indexOf(a) > msgs.indexOf(cust));
    if (agentAfter && /^\d+:\d+/.test(cust.ts) && /^\d+:\d+/.test(agentAfter.ts)) {
      const [ch, cm] = cust.ts.split(':').map(Number);
      const [ah, am] = agentAfter.ts.split(':').map(Number);
      const diff = Math.max(0, (ah - ch) * 60 + (am - cm));
      firstResp = diff === 0 ? '< 1m' : diff < 60 ? `${diff}m` : `${Math.floor(diff/60)}h ${diff%60}m`;
    }
  }

  let age = '—';
  if (t.created) {
    const created = new Date(t.created);
    // Demo personas load tickets from data.js with `created: '2025-04-16'`
    // across the board, so a frozen "today" keeps demo ages looking fresh.
    // Real tickets carry `_uuid` and need the actual current date.
    const today = t._uuid ? new Date() : new Date('2025-04-16');
    const days = Math.max(0, Math.floor((today - created) / 86400000));
    age = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
  }

  return { firstResp, age, created: t.created || '—', lastUpdate: t.updated || '—' };
}

function getSuggestedKB(t) {
  const tokens = (t.subject || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const cat = (t.category || '').toLowerCase();
  const scored = KB_ARTICLES.map(a => {
    let score = 0;
    if (a.category.toLowerCase() === cat) score += 3;
    const text = (a.title + ' ' + a.body).toLowerCase();
    tokens.forEach(tok => { if (text.includes(tok)) score += 1; });
    return { a, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map(s => s.a);
}

function toggleWatch(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || !SESSION) return;
  if (!t.followers) t.followers = [];
  const idx = t.followers.indexOf(SESSION.name);
  if (idx >= 0) t.followers.splice(idx, 1);
  else t.followers.push(SESSION.name);
  openTicket(id);
}

export function insertMacro(ticketId, idx) {
  const r = CANNED_RESPONSES[idx];
  if (!r) return;
  const t = TICKETS.find(x => x.id === ticketId);
  const cust = t ? CUSTOMERS.find(c => c.id === t.customerId) : null;
  const text = r.text.replace('{name}', cust ? cust.first : 'there');
  const el = document.getElementById('compose-' + ticketId);
  if (el) {
    appendText(ticketId, text);
    onComposeInput(ticketId);
  }
  closeModal();
}

export async function changeTicketStatus(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || t.status === val) return;
  // Side-effect: resolving an un-surveyed ticket auto-requests CSAT. Bundle
  // both fields into a single PATCH so the row stays consistent if the
  // status update succeeds but a follow-up call would fail.
  const stampCsat = val === 'resolved' && !t.csatRequestedAt && !t.csat
    ? new Date().toISOString().slice(0, 10)
    : null;
  if (t._uuid) {
    const patch = { status_key: val };
    if (stampCsat) patch.csat_requested_at = stampCsat;
    try { await apiPatch(`/api/v1/tickets/${t._uuid}`, patch); }
    catch (err) { alert(`Couldn't change status: ${err?.message || err}`); return; }
  }
  const prevSla = t.sla;
  logTicketEvent(id, 'status', `Status: ${t.status} → ${val}`);
  t.status = val;
  refreshTicketSLA(t);
  if (stampCsat) {
    t.csatRequestedAt = stampCsat;
    logTicketEvent(id, 'system', 'CSAT survey sent to customer');
  }
  updateNavBadges();
  if (CURRENT_TICKET === id) openTicket(id);
  if (val === 'resolved')   fireWebhook('ticket.resolved',  ticketPayload(t));
  if (val === 'escalated')  fireWebhook('ticket.escalated', ticketPayload(t));
  if (prevSla !== 'breach' && t.sla === 'breach') fireWebhook('sla.breach', ticketPayload(t));
}
function quickStatus(id, val) { changeTicketStatus(id, val); }

// Trigger server-side sentiment backfill for a ticket. Sequential
// scoring means a slow ticket (lots of unscored messages) will take
// a few seconds — show a "Scoring…" label and reload from the API
// when done so the in-thread badges + the auto-priority bump (if it
// fires) reflect the new state. Demo personas without _uuid are
// already filtered out at the render site, so this assumes _uuid.
async function backfillTicketSentiment(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t?._uuid) return;
  try {
    const res = await apiPost(`/api/v1/tickets/${t._uuid}/sentiment/backfill`);
    // Force a re-fetch of the ticket detail so the score badges +
    // potentially-bumped priority + system audit message all land.
    await loadTicketDetail(id);
    openTicket(id);
    if (res.total && res.scored < res.total) {
      alert(`Scored ${res.scored} of ${res.total} messages — the rest were skipped (likely AI budget exhausted).`);
    }
  } catch (err) {
    alert(`Backfill failed: ${err?.message || err}`);
  }
}
export async function addTicketTag(id, raw) {
  const tag = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!tag) return;
  const t = TICKETS.find(x => x.id === id); if (!t) return;
  if (!t.tags) t.tags = [];
  if (t.tags.includes(tag)) { openTicket(id); return; }
  if (t._uuid) {
    try { await apiPost(`/api/v1/tickets/${t._uuid}/tags`, { tag }); }
    catch (err) { alert(`Couldn't add tag: ${err?.message || err}`); return; }
  }
  t.tags.push(tag);
  logTicketEvent(id, 'tag', `Tagged: ${tag}`);
  const lib = TAG_LIBRARY.find(x => x.tag === tag);
  if (lib) lib.count++;
  else TAG_LIBRARY.push({ tag, count: 1, type: 'manual', conf: null });
  openTicket(id);
}
async function removeTicketTag(id, tag) {
  const t = TICKETS.find(x => x.id === id); if (!t) return;
  if (!(t.tags || []).includes(tag)) { openTicket(id); return; }
  if (t._uuid) {
    try { await apiDelete(`/api/v1/tickets/${t._uuid}/tags/${encodeURIComponent(tag)}`); }
    catch (err) { alert(`Couldn't remove tag: ${err?.message || err}`); return; }
  }
  logTicketEvent(id, 'tag', `Tag removed: ${tag}`);
  t.tags = (t.tags || []).filter(x => x !== tag);
  const lib = TAG_LIBRARY.find(x => x.tag === tag);
  if (lib && lib.count > 0) lib.count--;
  openTicket(id);
}
export async function changeTicketPriority(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || t.priority === val) return;
  if (t._uuid) {
    try { await apiPatch(`/api/v1/tickets/${t._uuid}`, { priority_key: val }); }
    catch (err) { alert(`Couldn't change priority: ${err?.message || err}`); return; }
  }
  logTicketEvent(id, 'priority', `Priority: ${t.priority} → ${val}`);
  t.priority = val;
  refreshTicketSLA(t);
  if (CURRENT_TICKET === id) openTicket(id);
}
export async function changeTicketAgent(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const old = t.agent || 'Unassigned';
  if (old === val) return;
  if (t._uuid) {
    // val is the agent name (matches AGENTS[i].name). Resolve to a user_id
    // for the API; empty/Unassigned → null to clear assignment.
    const assignee = val && val !== 'Unassigned' ? AGENTS.find(a => a.name === val) : null;
    const assignedUserId = assignee?.userId ?? null;
    try { await apiPatch(`/api/v1/tickets/${t._uuid}`, { assigned_user_id: assignedUserId }); }
    catch (err) { alert(`Couldn't reassign: ${err?.message || err}`); return; }
  }
  logTicketEvent(id, 'agent', `Reassigned: ${old} → ${val}`);
  t.agent = val;
  if (CURRENT_TICKET === id) openTicket(id);
  fireWebhook('ticket.assigned', { ...ticketPayload(t), previousAgent: old });
}

async function acceptAITag(ticketId, tagName) {
  const t = TICKETS.find(x=>x.id===ticketId);
  if (!t) return;
  const at = t.aiTags.find(x=>x.tag===tagName);
  if (!at || at.accepted) { openTicket(ticketId); return; }
  if (t._uuid) {
    try { await apiPatch(`/api/v1/tickets/${t._uuid}/ai_tags/${encodeURIComponent(tagName)}`, { accepted: true }); }
    catch (err) { alert(`Couldn't accept AI tag: ${err?.message || err}`); return; }
  }
  at.accepted = true;
  if (!t.tags.includes(tagName)) t.tags.push(tagName);
  openTicket(ticketId);
}
async function acceptAllAITags(ticketId) {
  const t = TICKETS.find(x=>x.id===ticketId);
  if (!t) return;
  const pending = t.aiTags.filter(at => !at.accepted);
  if (pending.length === 0) { openTicket(ticketId); return; }
  if (t._uuid) {
    try {
      await Promise.all(pending.map((at) =>
        apiPatch(`/api/v1/tickets/${t._uuid}/ai_tags/${encodeURIComponent(at.tag)}`, { accepted: true })
      ));
    } catch (err) { alert(`Couldn't accept AI tags: ${err?.message || err}`); return; }
  }
  pending.forEach((at) => {
    at.accepted = true;
    if (!t.tags.includes(at.tag)) t.tags.push(at.tag);
  });
  openTicket(ticketId);
}
function prevNextTicket(dir) {
  const idx = TICKETS.findIndex(t => t.id === CURRENT_TICKET);
  const next = TICKETS[idx + dir];
  if (next) openTicket(next.id);
}


export function onComposeInput(id) {
  const el = document.getElementById('compose-' + id);
  if (!el) return;
  // The draft holds HTML for the rich reply box and plain text for a note, so
  // a restored draft keeps its formatting.
  const draft = getHtml(id) ?? getPlainText(id);
  const text = getPlainText(id);
  saveDraft(id, draft);
  const launcher = document.querySelector?.(`#ticket-page-${id} [data-compose-launch][data-tab="${COMPOSE_TAB}"]`);
  if (launcher) launcher.textContent = (COMPOSE_TAB === 'reply' ? 'Reply' : 'Internal note') + (draft ? ' · draft' : '');
  const cc = document.getElementById('char-count-' + id);
  if (cc) cc.textContent = `${text.length} chars`;
  const ds = document.getElementById('draft-status-' + id);
  if (ds) ds.textContent = text.length ? 'Draft saved' : '';
  if (COMPOSE_TAB === 'note') updateMentionDropdown(id, el);
  else hideMentionDropdown();
  // Broadcast composing presence: empty box = not composing, anything
  // else = composing. Only meaningful for the reply tab — internal
  // notes aren't outbound, so we don't surface "Emma is typing" for
  // notes (avoids false-alarming the send-confirm flow).
  setComposing(COMPOSE_TAB === 'reply' && !isComposerEmpty(id));
}


function insertVar(id, token) {
  const t = TICKETS.find(x => x.id === id);
  const cust = t ? CUSTOMERS.find(c => c.id === t.customerId) : null;
  let val = token;
  if (token === '{name}'   && cust) val = cust.first;
  else if (token === '{ticket}')    val = id;
  else if (token === '{brand}' && cust) val = cust.brand;
  else if (token === '{agent}' && t) val = t.agent || '';
  insertAtCursor(id, val);
  onComposeInput(id);
}

function toggleAIMenu(id) {
  const m = document.getElementById('ai-menu-' + id);
  if (!m) return;
  document.getElementById('send-menu-' + id)?.style.setProperty('display', 'none');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
function hideAIMenu(id)  { const m = document.getElementById('ai-menu-'   + id); if (m) m.style.display = 'none'; }
function toggleSendMenu(id) {
  const m = document.getElementById('send-menu-' + id);
  if (!m) return;
  document.getElementById('ai-menu-' + id)?.style.setProperty('display', 'none');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
function hideSendMenu(id) { const m = document.getElementById('send-menu-' + id); if (m) m.style.display = 'none'; }

async function sendComposeAnd(id, status) {
  hideSendMenu(id);
  const sent = await sendCompose(id);
  if (sent === false) return;
  changeTicketStatus(id, status);
  if (CURRENT_TICKET === id) openTicket(id);
}

function showSentTextModal(ticketId, msgIdx) {
  const t = TICKETS.find(x => x.id === ticketId);
  const m = t && t.msgs && t.msgs[msgIdx];
  if (!m) return;
  showModal(`Sent to customer · ${m.translatedTo || 'translated'}`,
    `<div style="font-size:13px;color:var(--ink);line-height:1.6;white-space:pre-wrap;word-wrap:break-word">${window.escHtml(m.t || '')}</div>`,
    null, null);
}

async function sendCompose(id) {
  const el = document.getElementById(`compose-${id}`);
  if (!el) return false;
  const txt = getPlainText(id).trim();
  // A reply may be an image with no words at all, so "empty" is the editor's
  // own judgement, not just the text.
  if (isComposerEmpty(id)) return false;
  const t = TICKETS.find(x => x.id === id);
  if (!t) return false;

  // Soft double-handling guard — only for outbound replies, and only
  // for API-backed tickets where presence is actually running. Demo
  // personas never have other viewers, so the prompt is suppressed.
  if (t._uuid && COMPOSE_TAB === 'reply') {
    const ok = await confirmIfOthersComposing();
    if (!ok) return false;
  }

  // Auto-translate outgoing replies (not internal notes) when toggle is on and we know the customer's language
  let outgoing = txt;
  let original = null;
  let translatedTo = null;
  const shouldAutoTranslate = COMPOSE_TAB !== 'note'
    && t.autoTranslateReplies
    && t.detectedCustomerLang
    && t.detectedCustomerLang.toLowerCase() !== AGENT_PREFERRED_LANG.toLowerCase()
    && AI_API_KEY;
  if (shouldAutoTranslate) {
    setAiThinking(true);
    try {
      if (CURRENT_TICKET === id) openTicket(id);
      const res = await translateText(txt, t.detectedCustomerLang);
      if (res.translation) {
        outgoing = res.translation;
        original = txt;
        translatedTo = t.detectedCustomerLang;
      }
    } finally {
      setAiThinking(false);
    }
  }

  const isNote = COMPOSE_TAB === 'note';
  const mentions = isNote ? parseMentions(outgoing) : null;

  // API-backed path. The server stamps the canonical author_label + ts;
  // we use its response so the row in t.msgs matches what /tickets/:id
  // would return on a future refetch. Translation metadata (tOriginal,
  // translatedTo) is purely client-side display state — not persisted
  // server-side yet, so it lives only on the local entry.
  if (t._uuid) {
    let message, delivery;
    // Rich HTML only for a reply the agent actually formatted, and never when
    // auto-translate rewrote the text — the translation is plain text, so
    // sending the original markup alongside it would contradict it.
    const html = (!isNote && !shouldAutoTranslate) ? getHtml(id) : null;
    const attachmentIds = isNote ? [] : pendingAttachmentIds(id);
    try {
      const res = await apiPost(`/api/v1/tickets/${t._uuid}/messages`, {
        role: isNote ? 'note' : 'agent',
        body: outgoing,
        body_html: html || undefined,
        attachment_ids: attachmentIds.length ? attachmentIds : undefined,
        mentions: isNote ? (mentions || []).map((m) => m.userId).filter(Boolean) : undefined,
      });
      message = res.message;
      delivery = res.delivery;
    } catch (err) {
      alert(`Couldn't send: ${err?.message || err}`);
      return false;
    }
    // Public replies are emailed to the customer; surface the outcome. Internal
    // notes have no delivery field, so this is silently skipped for them.
    if (delivery) notifyReplyDelivery(delivery);
    t.msgs.push({
      from: message.author_label,
      r: message.role,
      t: message.body,
      // Same shape GET /tickets/:id returns, so the sent reply renders exactly
      // as it will after a refetch (formatting, inline images, file chips).
      html: message.body_html || null,
      attachments: message.attachments || [],
      tOriginal: original,
      translatedTo,
      mentions,
      ts: new Date(message.created_at).toTimeString().slice(0, 5),
    });
    if (!isNote) clearPendingAttachments(id);
  } else {
    // Demo persona — no API, synthesise locally as before.
    t.msgs.push({
      from: SESSION.name,
      r: isNote ? 'note' : 'agent',
      t: outgoing,
      tOriginal: original,
      translatedTo,
      mentions,
      ts: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    });
  }
  clearComposer(id);
  clearDraft(id);
  onComposeInput(id);
  if (CURRENT_TICKET === id) openTicket(id);
  return true;
}

// Map the server's agent-reply delivery outcome to a transient toast. The
// reply is always saved on the ticket; this only tells the agent whether the
// customer also got it by email (and why not, when applicable).
// Exported: the new-ticket flow (tickets/new-ticket.js) reuses the same
// delivery→toast mapping after sending a first message on a fresh ticket.
export function notifyReplyDelivery(delivery) {
  if (delivery.emailed) { showToast('✓ Emailed to the customer', 'success'); return; }
  const msg = {
    no_customer_email:       'Reply saved. Not emailed — no email address on file for this customer.',
    email_suppressed:        'Reply saved. Not emailed — this address previously hard-bounced or was marked spam.',
    postmark_not_configured: 'Reply saved. Outbound email isn’t configured, so it wasn’t sent.',
    no_from:                 'Reply saved. Not emailed — no sender address is configured for this workspace.',
    send_failed:             'Reply saved, but the email failed to send. Try again or reach the customer another way.',
  }[delivery.reason] || 'Reply saved, but it wasn’t emailed.';
  showToast(msg, delivery.reason === 'send_failed' ? 'error' : 'warn', 6000);
}

// ─── data-action registrations (sidebar) ─────────────────────────────────────
// First slice of the detail.js event-delegation migration. Sidebar
// handlers only — toolbar, tags row, message thread, and compose area
// still use inline strings (follow-up PRs). Bridge namespace can't
// retire until all three slices land.
//
// `td.*` action prefix avoids collisions with other modules. Most
// handlers call locally-imported fns directly. `navTo` still goes
// through `window` (lifts when the Keybindings namespace retires).

registerActions({
  // Snooze + merge banners
  'td.unsnooze':       (ds) => unsnoozeTicket(ds.ticketId),
  'td.snooze':         (ds) => showSnoozeModal(ds.ticketId),
  'td.unmerge':        (ds) => unmergeTicket(ds.ticketId),
  'td.deleteTicket':   (ds) => deleteTicketPrompt(ds.ticketId),
  'td.openTicket':     (ds) => openTicket(ds.ticketId),
  // AI tags
  'td.acceptAITag':    (ds) => acceptAITag(ds.ticketId, ds.tag),
  'td.acceptAllAITags':(ds) => acceptAllAITags(ds.ticketId),
  // Sidebar info rows / SLA / KB
  'td.showAttach':     (ds) => showAttachPanel(ds.ticketId),
  'td.navTo':          (ds) => navTo(ds.target),
  'td.summarize':      (ds) => summarizeTicket(ds.ticketId),
  'td.clearSummary':   (ds) => clearTicketSummary(ds.ticketId),
  'td.toggleWatch':    (ds) => toggleWatch(ds.ticketId),
  'td.openKB':         (ds) => { setKbSelected(ds.kbId); navTo('kb'); },
  'td.refreshKB':      (ds) => refreshTicketKbSuggestions(ds.ticketId),
  // Time tracking
  'td.logTime':        (ds) => showLogTimeModal(ds.ticketId),
  'td.removeTime':     (ds) => removeTimeEntry(ds.ticketId, ds.entryId),
  // Linked tickets
  'td.linkTicket':     (ds) => showLinkTicketModal(ds.ticketId),
  'td.mergeTicket':    (ds) => showMergeTicketModal(ds.ticketId),
  'td.unlink':         (ds) => unlinkTicket(ds.ticketId, ds.linkedId),
  // Customer panel
  'td.openCustomer':   (ds) => openCustomerModal(ds.custId),
  // Per-ticket GDPR sidebar (stubs — same as the inline alerts they replace)
  'td.gdprErasure':    () => alert('Erasure request initiated'),
  'td.gdprRedact':     () => alert('Data redacted'),
  'td.gdprExport':     () => alert('SAR export started'),
  // Toolbar
  'td.openTicketsList':() => renderPage('tickets'),
  'td.prev':           () => prevNextTicket(-1),
  'td.next':           () => prevNextTicket(1),
  'td.macroModal':     (ds) => showApplyMacroModal(ds.ticketId),
  'td.runRules':       (ds) => runAssignmentRulesOnTicket(ds.ticketId),
  'td.quickStatus':    (ds) => quickStatus(ds.ticketId, ds.status),
  'td.backfillSentiment': (ds) => backfillTicketSentiment(ds.ticketId),
  // Tags row
  'td.removeTag':      (ds) => removeTicketTag(ds.ticketId, ds.tag),
  // Message thread
  'td.hideTranslation':(ds) => hideMessageTranslation(ds.ticketId, parseInt(ds.msgIdx, 10)),
  'td.translateMsg':   (ds) => translateMessage(ds.ticketId, parseInt(ds.msgIdx, 10)),
  'td.showSentText':   (ds) => showSentTextModal(ds.ticketId, parseInt(ds.msgIdx, 10)),
  'td.showRemoteImages': (ds) => { enableRemoteImages(ds.ticketId, parseInt(ds.msgIdx, 10)); openTicket(ds.ticketId); },
  // Compose area
  'td.setComposeTab':  (ds) => setComposeTab(ds.tab, ds.ticketId),
  'td.insertVar':      (ds) => insertVar(ds.ticketId, ds.token),
  'td.macroPanel':     (ds) => showMacroPanel(ds.ticketId),
  // GDPR modal lives in customers/modals.js. The detail↔modals↔customers/index
  // cycle (customers/index→detail edge from #127) is tolerated — the binding
  // is only used inside this closure, never at module top level.
  'td.gdprModal':      (ds) => showGDPRModal(ds.ticketId),
  'td.toggleAIMenu':   (ds) => toggleAIMenu(ds.ticketId),
  'td.aiAction':       (ds) => aiAction(ds.ticketId, ds.verb),
  'td.send':           (ds) => sendCompose(ds.ticketId),
  'td.toggleSendMenu': (ds) => toggleSendMenu(ds.ticketId),
  'td.sendAnd':        (ds) => sendComposeAnd(ds.ticketId, ds.status),
});

registerChangeActions({
  'td.setStatus':            (ds, el) => changeTicketStatus(ds.ticketId, el.value),
  'td.setPriority':          (ds, el) => changeTicketPriority(ds.ticketId, el.value),
  'td.setAgent':             (ds, el) => changeTicketAgent(ds.ticketId, el.value),
  'td.toggleThreadTranslate':(ds, el) => toggleThreadTranslate(ds.ticketId, el.checked),
  'td.setCustomerLang':      (ds, el) => setCustomerLanguage(ds.ticketId, el.value),
  'td.toggleAutoTranslate':  (ds, el) => toggleAutoTranslateReplies(ds.ticketId, el.checked),
});

registerInputActions({
  'td.composeInput': (ds) => onComposeInput(ds.ticketId),
});

// ─── Module-internal keydown + focusout dispatch ─────────────────────────────
// Two events the shared harness doesn't dispatch — sparse callsites that
// don't justify extending the harness. Both are document-level listeners
// that route by element class/dataset.
//
//  - keydown: tag-add input (Enter adds the tag); compose textarea (the
//    `@` mention dropdown's arrow-key navigation, handled by mentions.js).
//  - focusout: compose textarea (when focus leaves, schedule a hide of the
//    mention dropdown — needed because `blur` doesn't bubble so a document
//    listener on `blur` wouldn't fire; `focusout` is the bubbling counterpart).
document.addEventListener('keydown', e => {
  const el = e.target;
  // Tag-add input (slice 2)
  if (el instanceof HTMLInputElement && el.dataset.tagAddId) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addTicketTag(el.dataset.tagAddId, el.value);
    return;
  }
  // Compose textarea mention-dropdown navigation
  if (el instanceof HTMLTextAreaElement && el.classList.contains('compose-area') && el.dataset.ticketId) {
    mentionDropdownKey(e, el.dataset.ticketId);
  }
});

document.addEventListener('focusout', e => {
  const el = e.target;
  if (el instanceof HTMLTextAreaElement && el.classList.contains('compose-area')) {
    // Delay so a click on a mention-dropdown item lands before the dropdown
    // hides. Matches the original inline `onblur="setTimeout(hide, 150)"`.
    setTimeout(hideMentionDropdown, 150);
  }
});
