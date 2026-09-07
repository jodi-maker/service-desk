// ─── Settings ────────────────────────────────────────────────────────────────
// Six-tab settings page: Profile, Appearance, Notifications, AI Assistant,
// Knowledge Base, Language. The "Knowledge Base" tab configures the
// KB_INTEGRATION object that lives in app.js — the rest of the KB
// integration code (fetchKbArticles, KB_TICKET_CACHE, refresh path) stays
// in app.js because the composer and ticket sidebar also depend on it.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// logout — all still in app.js. navTo is a direct ES import.
// refreshNotifBadge, setAIKey/setAIModel, setAgentPreferredLang,
// showModal/closeModal, resetAllCollapsedSections, COLLAPSED_SECTIONS,
// KB_INTEGRATION, KB_TICKET_CACHE, saveKbIntegration, fetchKbArticles are
// direct ES imports.
//
// No window-bridge namespace spread: the page's inline on*= handlers are
// delegated as settings.* actions (bottom of file). renderSettings is the
// router entry; setSettingsTab stays exported (ai/page + help import it) AND
// as an explicit app.js bridge entry, because notifications reaches it via
// window.setSettingsTab to dodge the settings↔notifications import cycle
// (settings already imports refreshNotifBadge from notifications).

import { CUSTOMERS, CATEGORIES } from '../core/data.js';
import { NOTIF_PREFS, SESSION, SETTINGS_TAB, setSettingsTabValue } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { AI_API_KEY, AI_MODEL, setAIKey, setAIModel } from '../ai/client.js';
import {
  AGENT_PREFERRED_LANG, TRANSLATOR_LANGS, setAgentPreferredLang,
} from '../ai/translate.js';
import { refreshNotifBadge } from '../notifications/index.js';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, API_BASE, getWorkspaceId, getJwt } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { COLLAPSED_SECTIONS, resetAllCollapsedSections } from '../core/collapsible.js';
import { KB_INTEGRATION, KB_TICKET_CACHE, saveKbIntegration, fetchKbArticles } from '../kb-integration/index.js';
import { settingsEmailBranding, settingsMySignature } from '../email-branding/index.js';
import { settingsSenderDomain } from '../email-domain/index.js';
import { settingsPushSection } from '../push/index.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';

// In-memory snapshots of the workspace's integrations, loaded lazily
// when the Integrations tab is opened.
let SLACK_INTEGRATION = null;
let SLACK_LOADED = false;
let OUTGOING_WEBHOOKS = [];
let OUTGOING_WEBHOOKS_LOADED = false;
let LAST_REVEALED_SECRET = null;        // shown once after a POST; cleared on next paint
let SUPPRESSED_CUSTOMERS = [];
let SUPPRESSED_LOADED = false;
let SUPPRESSED_SCOPE = null;
const suppressionScope = () => `${getWorkspaceId() || ''}:${getJwt() || ''}`;
let WORKSPACE_SETTINGS = null;
let WORKSPACE_SETTINGS_LOADED = false;
let ME_PREFS = null;
let ME_PREFS_LOADED = false;
let CATEGORIES_LOADED = false;   // Categories tab lazy-load guard
const SLACK_EVENTS = [
  { k: 'ticket.created',   l: 'Ticket created' },
  { k: 'ticket.resolved',  l: 'Ticket resolved' },
  { k: 'ticket.escalated', l: 'Ticket escalated' },
  { k: 'priority.urgent',  l: 'Priority set to urgent' },
];

// Module-scoped state for the Settings → Knowledge Base test panel. Kept off
// `window` so it doesn't pollute the global namespace.
let KB_TEST_STATE = null;

export function renderSettings() {
  const tabs = [
    {k:'profile',       l:'Profile'},
    {k:'appearance',    l:'Appearance'},
    {k:'notifications', l:'Notifications'},
    {k:'ai',            l:'AI Assistant'},
    {k:'knowledge-base', l:'Knowledge Base'},
    {k:'language',      l:'Language'},
    {k:'integrations',  l:'Integrations'},
    // Email branding + Sender domain + Categories are workspace config — admins only.
    ...(window.isAdmin() ? [{k:'email', l:'Email branding'}, {k:'sender-domain', l:'Sender domain'}, {k:'categories', l:'Categories'}] : []),
  ];
  const tabbar = tabs.map(t => `<div class="settings-tab ${SETTINGS_TAB===t.k?'active':''}" data-action="settings.setTab" data-tab="${window.escAttr(t.k)}">${t.l}</div>`).join('');
  let panel = '';
  if      (SETTINGS_TAB === 'profile')       panel = settingsProfile();
  else if (SETTINGS_TAB === 'appearance')    panel = settingsAppearance();
  else if (SETTINGS_TAB === 'notifications') panel = settingsNotifications();
  else if (SETTINGS_TAB === 'ai')            panel = settingsAI();
  else if (SETTINGS_TAB === 'knowledge-base') panel = settingsKnowledgeBase();
  else if (SETTINGS_TAB === 'language')      panel = settingsLanguage();
  else if (SETTINGS_TAB === 'integrations')  panel = settingsIntegrations();
  else if (SETTINGS_TAB === 'email')         panel = settingsEmailBranding();
  else if (SETTINGS_TAB === 'sender-domain') panel = settingsSenderDomain();
  else if (SETTINGS_TAB === 'categories')    panel = settingsCategories();
  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Settings</div></div>
      <div class="page-scroll">
        <div class="settings-shell">
          <aside class="settings-side">${tabbar}</aside>
          <div class="settings-panel">${panel}</div>
        </div>
      </div>
    </div>`;
}

export function setSettingsTab(k) { setSettingsTabValue(k); renderPage('settings'); }

function settingsProfile() {
  return `
    <div class="settings-section">
      <div class="settings-h">Account</div>
      <div style="display:flex;gap:12px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
        <div style="width:48px;height:48px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:14px">${SESSION?.initials||'??'}</div>
        <div>
          <div style="font-size:15px;font-weight:600;color:var(--ink)">${SESSION?.name||'—'}</div>
          <div style="font-size:12px;color:var(--ink3)">${SESSION?.role||'—'}</div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Display name</label>
        <input class="form-input" id="set-name" value="${SESSION?.name||''}" data-input-action="settings.updateName"/>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">Initials</label>
          <input class="form-input" id="set-initials" value="${SESSION?.initials||''}" maxlength="3" data-input-action="settings.updateInitials"/>
        </div>
        <div class="form-row">
          <label class="form-label">Role</label>
          <input class="form-input" value="${SESSION?.role||''}" disabled style="opacity:.6"/>
        </div>
      </div>
      <div style="margin-top:16px"><button class="btn btn-danger" data-action="settings.logout">Sign out</button></div>
    </div>
    ${settingsMySignature()}`;
}

function updateProfileName(name) {
  const trimmed = name.trim();
  if (!SESSION || !trimmed) return;
  SESSION.name = trimmed;
  const a = document.getElementById('sb-uname');   if (a) a.textContent = trimmed;
  const b = document.getElementById('sf-name');    if (b) b.textContent = trimmed;
  const c = document.getElementById('pf-name-sm'); if (c) c.textContent = trimmed;
  const d = document.getElementById('pf-name-lg'); if (d) d.textContent = trimmed;
}
function updateProfileInitials(v) {
  const trimmed = v.trim().toUpperCase();
  if (!SESSION || !trimmed) return;
  SESSION.initials = trimmed;
  const av  = document.getElementById('sb-av');    if (av)  av.textContent  = trimmed;
  const av2 = document.getElementById('pf-av-sm'); if (av2) av2.textContent = trimmed;
  const av3 = document.getElementById('pf-av-lg'); if (av3) av3.textContent = trimmed;
}

function settingsAppearance() {
  const collapsedN = COLLAPSED_SECTIONS.size;
  return `
    <div class="settings-section">
      <div class="settings-h">Page chrome</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Click the small caret in the top-right of any KPI bar, filter bar, or tab bar to collapse it. Collapsed sections shrink to a one-line "▸ Show …" pill — click anywhere on the pill to expand again. Choices stick across reloads.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Hidden sections</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">${collapsedN} section${collapsedN===1?'':'s'} collapsed across pages</div>
        </div>
        <button class="btn btn-sm" ${collapsedN===0?'disabled':''} data-action="settings.resetCollapsed">Show all</button>
      </div>
    </div>

    ${settingsWorkspaceBranding()}`;
}

function settingsWorkspaceBranding() {
  // Reuses the same workspace settings state lazy-loaded by the AI
  // Assistant tab (PR #222). Either tab triggers the fetch; whichever
  // lands first wins, the other paints from cache.
  if (!WORKSPACE_SETTINGS_LOADED) {
    WORKSPACE_SETTINGS_LOADED = true;
    apiGet('/api/v1/workspace/settings')
      .then((res) => { WORKSPACE_SETTINGS = res.workspace; renderPage('settings'); })
      .catch((err) => { console.warn('[settings] workspace load failed:', err); });
  }
  const ws = WORKSPACE_SETTINGS;
  const isAdmin = window.isAdmin();
  const logoUrl = ws?.logo_url || '';
  const color   = ws?.primary_color || '';
  const preview = logoUrl
    ? `<img src="${window.escAttr(logoUrl)}" alt="" style="max-height:32px;max-width:160px;vertical-align:middle;border:1px solid var(--rule);border-radius:4px;padding:2px;background:#fff" onerror="this.style.display='none'"/>`
    : '<span style="color:var(--ink3);font-size:11px;font-family:\'DM Mono\',monospace">No logo configured</span>';
  return `
    <div class="settings-section">
      <div class="settings-h">Workspace branding</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Logo + primary color are shown on the sidebar, in CSAT survey + magic-link emails, and on the customer portal. Host the logo image somewhere public (your CDN, an S3 bucket, etc.) and paste the URL here. Admins only.
      </div>
      <div class="settings-row" style="border:none;padding-bottom:8px">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Current</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">Shown wherever the workspace surfaces to a customer or agent.</div>
        </div>
        <div>${preview}</div>
      </div>
      <div class="form-row">
        <label class="form-label">Upload logo</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="file" id="brand-logo-file" accept="image/png,image/jpeg,image/svg+xml,image/webp" ${isAdmin ? '' : 'disabled'} style="flex:1;font-size:12px"/>
          <button class="btn btn-sm" data-action="settings.uploadLogo" ${isAdmin ? '' : 'disabled'}>Upload</button>
        </div>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">PNG, JPG, SVG, or WEBP up to 2 MB. Uploaded files are hosted on the workspace's own brand-assets bucket.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Or paste a URL</label>
        <input class="form-input" id="brand-logo-url" type="url" value="${window.escAttr(logoUrl)}" placeholder="https://cdn.example.com/your-logo.png" ${isAdmin ? '' : 'disabled'}/>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Externally hosted images work too. Leave empty (and don't upload) to fall back to the workspace name.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Primary color</label>
        <div style="display:flex;align-items:center;gap:10px">
          <input class="form-input" id="brand-primary-color" type="text" value="${window.escAttr(color)}" placeholder="#130e30" style="font-family:'DM Mono',monospace;max-width:140px" ${isAdmin ? '' : 'disabled'}/>
          <input type="color" id="brand-primary-color-picker" value="${color || '#130e30'}" data-input-action="settings.syncBrandColor" ${isAdmin ? '' : 'disabled'} style="width:34px;height:34px;border:1px solid var(--rule);border-radius:4px;padding:0;cursor:pointer;background:none"/>
        </div>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Hex like <code style="font-family:'DM Mono',monospace">#130e30</code>. Used for chips, focus rings, and the AI-draft button. Empty falls back to the default accent.</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" data-action="settings.saveBranding" ${isAdmin ? '' : 'disabled'}>Save</button>
        <span id="brand-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>

    ${settingsPortalCopy(ws, isAdmin)}`;
}

function settingsPortalCopy(ws, isAdmin) {
  const tagline = ws?.portal_tagline || '';
  const intro   = ws?.portal_intro   || '';
  const footer  = ws?.portal_footer  || '';
  return `
    <div class="settings-section">
      <div class="settings-h">Customer portal copy</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Custom text shown on the customer-facing portal (the page at <code style="font-family:'DM Mono',monospace">portal.html?ws=${window.escHtml(ws?.slug || 'your-workspace')}</code>). Leave any field empty to fall back to the platform default. Admins only.
      </div>
      <div class="form-row">
        <label class="form-label">Tagline <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— shown under the workspace name in the portal header</span></label>
        <input class="form-input" id="brand-portal-tagline" type="text" maxlength="100" value="${window.escAttr(tagline)}" placeholder="Help &amp; support" ${isAdmin ? '' : 'disabled'}/>
      </div>
      <div class="form-row">
        <label class="form-label">Intro paragraph <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— shown above the help / submit-request cards</span></label>
        <textarea class="form-input" id="brand-portal-intro" maxlength="1000" rows="3" placeholder="Welcome! Search our help center below, or submit a ticket and our team will get back to you." ${isAdmin ? '' : 'disabled'} style="resize:vertical;font-family:inherit">${window.escHtml(intro)}</textarea>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Up to 1000 characters. Plain text — no markdown or HTML.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Footer <span style="color:var(--ink3);font-weight:400;font-family:'DM Mono',monospace;font-size:11px">— replaces "Powered by Respovia"</span></label>
        <input class="form-input" id="brand-portal-footer" type="text" maxlength="500" value="${window.escAttr(footer)}" placeholder="© Your Company 2026 · Need urgent help? Call +1 555 0100" ${isAdmin ? '' : 'disabled'}/>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" data-action="settings.savePortalCopy" ${isAdmin ? '' : 'disabled'}>Save portal copy</button>
        <span id="portal-copy-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>

    ${settingsPortalDomain(ws, isAdmin)}`;
}

function settingsPortalDomain(ws, isAdmin) {
  const domain   = ws?.portal_custom_domain || '';
  const token    = ws?.portal_custom_domain_token || '';
  const verified = ws?.portal_custom_domain_verified === true;
  const recordName = domain ? `_maestro-verify.${domain}` : '';
  const verifiedPill = verified
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:var(--green-lt);color:var(--green);font-size:10px;font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">Verified</span>`
    : `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:var(--amber-lt);color:var(--amber);font-size:10px;font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">Pending</span>`;
  return `
    <div class="settings-section">
      <div class="settings-h">Custom portal domain</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        Serve the customer portal at your own hostname (e.g. <code style="font-family:'DM Mono',monospace">help.acme.com</code>) instead of the platform URL. TLS is on you — point a CDN at this server's portal host. Verification is via a TXT record so we know you control the domain.
      </div>
      <div class="form-row">
        <label class="form-label">Custom hostname</label>
        <div style="display:flex;align-items:center;gap:10px">
          <input class="form-input" id="brand-portal-domain" type="text" value="${window.escAttr(domain)}" placeholder="help.acme.com" ${isAdmin ? '' : 'disabled'} style="font-family:'DM Mono',monospace;flex:1"/>
          ${domain ? verifiedPill : ''}
        </div>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Lowercase, fully-qualified (at least one dot). Changing this re-issues the verification token and resets the verified state.</div>
      </div>
      ${domain && token ? `
        <div style="margin:14px 0;padding:12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);font-size:12px;line-height:1.6">
          <div style="font-weight:600;color:var(--ink);margin-bottom:8px">DNS verification</div>
          <div style="color:var(--ink2);margin-bottom:10px">Add a TXT record at:</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;background:var(--w);padding:8px 10px;border-radius:3px;border:1px solid var(--rule);user-select:all;margin-bottom:6px">${window.escHtml(recordName)}</div>
          <div style="color:var(--ink2);margin-bottom:10px">with the value:</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;background:var(--w);padding:8px 10px;border-radius:3px;border:1px solid var(--rule);user-select:all;word-break:break-all">${window.escHtml(token)}</div>
        </div>
      ` : ''}
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-solid btn-sm" data-action="settings.savePortalDomain" ${isAdmin ? '' : 'disabled'}>Save hostname</button>
        ${domain ? `<button class="btn btn-sm" data-action="settings.verifyPortalDomain" ${isAdmin ? '' : 'disabled'}>${verified ? 'Re-verify' : 'Verify now'}</button>` : ''}
        <span id="portal-domain-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;align-self:center"></span>
      </div>
    </div>`;
}

async function savePortalDomain() {
  if (!window.isAdmin()) return;
  const domain = document.getElementById('brand-portal-domain').value.trim().toLowerCase();
  const msg = document.getElementById('portal-domain-msg');
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch('/api/v1/workspace/settings', {
      portal_custom_domain: domain || null,
    });
    WORKSPACE_SETTINGS = res.workspace;
    msg.textContent = '✓ Saved';
    msg.style.color = 'var(--green)';
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

async function verifyPortalDomain() {
  if (!window.isAdmin()) return;
  const msg = document.getElementById('portal-domain-msg');
  msg.textContent = 'Looking up DNS...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPost('/api/v1/workspace/domain/verify');
    if (res.verified) {
      msg.textContent = '✓ Verified';
      msg.style.color = 'var(--green)';
      const fresh = await apiGet('/api/v1/workspace/settings');
      WORKSPACE_SETTINGS = fresh.workspace;
      renderPage('settings');
    } else {
      const reason = res.reason === 'no_txt_record'
        ? `No TXT record at ${res.record_name}`
        : res.reason === 'mismatch'
          ? `TXT record found but value didn't match the expected token`
          : `DNS lookup failed (${res.reason})`;
      msg.textContent = reason;
      msg.style.color = 'var(--red)';
    }
  } catch (err) {
    msg.textContent = err?.message || 'Verification failed';
    msg.style.color = 'var(--red)';
  }
}

async function savePortalCopy() {
  if (!window.isAdmin()) return;
  const tagline = document.getElementById('brand-portal-tagline').value.trim();
  const intro   = document.getElementById('brand-portal-intro').value.trim();
  const footer  = document.getElementById('brand-portal-footer').value.trim();
  const msg = document.getElementById('portal-copy-msg');
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch('/api/v1/workspace/settings', {
      portal_tagline: tagline || null,
      portal_intro:   intro   || null,
      portal_footer:  footer  || null,
    });
    WORKSPACE_SETTINGS = res.workspace;
    msg.textContent = '✓ Saved';
    msg.style.color = 'var(--green)';
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

async function uploadWorkspaceLogo() {
  if (!window.isAdmin()) return;
  const fileEl = document.getElementById('brand-logo-file');
  const file = fileEl?.files?.[0];
  const msg = document.getElementById('brand-msg');
  if (!file) {
    msg.textContent = 'Pick a file first';
    msg.style.color = 'var(--red)';
    return;
  }
  msg.textContent = 'Uploading...';
  msg.style.color = 'var(--ink3)';
  try {
    const form = new FormData();
    form.append('file', file);
    // apiPost serializes JSON; bypass it for multipart by calling fetch
    // directly. The api-client's auth + workspace headers live in
    // window for the standard JSON paths — we replicate the headers
    // here without the Content-Type (the browser sets the multipart
    // boundary on its own).
    const jwt         = sessionStorage.getItem('maestro_jwt') || '';
    const workspaceId = sessionStorage.getItem('maestro_workspace_id') || '';
    const res = await fetch(`${API_BASE}/api/v1/workspace/branding/logo`, {
      method: 'POST',
      headers: {
        Authorization:   `Bearer ${jwt}`,
        'X-Workspace-Id': workspaceId,
      },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    // Push the new URL into the local state + the URL input + apply
    // the brand so the sidebar updates without re-signing-in.
    WORKSPACE_SETTINGS = { ...(WORKSPACE_SETTINGS || {}), logo_url: data.logo_url };
    const urlEl = document.getElementById('brand-logo-url');
    if (urlEl) urlEl.value = data.logo_url;
    window.applyWorkspaceBrand?.({
      name:         WORKSPACE_SETTINGS.name,
      slug:         WORKSPACE_SETTINGS.slug,
      logoUrl:      data.logo_url,
      primaryColor: WORKSPACE_SETTINGS.primary_color,
    });
    msg.textContent = '✓ Uploaded';
    msg.style.color = 'var(--green)';
    fileEl.value = '';
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Upload failed';
    msg.style.color = 'var(--red)';
  }
}

async function saveWorkspaceBranding() {
  if (!window.isAdmin()) return;
  const logoUrl = document.getElementById('brand-logo-url').value.trim();
  const color   = document.getElementById('brand-primary-color').value.trim();
  const msg = document.getElementById('brand-msg');
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) {
    msg.textContent = 'Logo URL must start with https://';
    msg.style.color = 'var(--red)';
    return;
  }
  if (color && !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) {
    msg.textContent = 'Color must be a hex like #130e30';
    msg.style.color = 'var(--red)';
    return;
  }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch('/api/v1/workspace/settings', {
      logo_url:      logoUrl || null,
      primary_color: color   || null,
    });
    WORKSPACE_SETTINGS = res.workspace;
    msg.textContent = '✓ Saved';
    msg.style.color = 'var(--green)';
    // Apply the new brand to the sidebar + tab title immediately so
    // the user sees their change reflected without re-signing-in.
    window.applyWorkspaceBrand?.({
      name:         res.workspace.name,
      slug:         res.workspace.slug,
      logoUrl:      res.workspace.logo_url,
      primaryColor: res.workspace.primary_color,
    });
    // Re-render the settings page so the preview row picks up the
    // new logo / color too.
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

function settingsNotifications() {
  const types = [
    {k:'breach',    l:'SLA breach',    d:'Tickets that have exceeded their SLA window'},
    {k:'escalated', l:'Escalations',   d:'Tickets escalated to senior agents'},
    {k:'gdpr',      l:'GDPR requests', d:'Data subject access and erasure requests'},
    {k:'warn',      l:'SLA warnings',  d:'Tickets approaching SLA breach'},
    {k:'wake',      l:'Snooze wake-ups', d:'Tickets that have come back from a snooze'},
    {k:'mention',   l:'@mentions',     d:'You were @-mentioned in an internal note'},
    {k:'response',  l:'New customer responses', d:'A customer replied to a ticket assigned to you'},
  ];
  // Email preferences live server-side (per-user, on public.users).
  // Lazy-load on tab open + re-render once the fetch lands so the
  // toggle reflects the persisted value.
  if (!ME_PREFS_LOADED) {
    ME_PREFS_LOADED = true;
    apiGet('/api/v1/me')
      .then((res) => { ME_PREFS = res.user; renderPage('settings'); })
      .catch((err) => { console.warn('[settings] me load failed:', err); });
  }
  const mentionEmailOn = ME_PREFS ? ME_PREFS.mention_email_enabled !== false : true;
  return `
    <div class="settings-section">
      <div class="settings-h">Notification types</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Choose which alerts appear in the notifications bell.</div>
      ${types.map(t => `
        <div class="settings-row">
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--ink)">${t.l}</div>
            <div style="font-size:11px;color:var(--ink3);margin-top:2px">${t.d}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${NOTIF_PREFS[t.k]?'checked':''} data-change-action="settings.toggleNotif" data-key="${t.k}">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('')}
    </div>

    <div class="settings-section">
      <div class="settings-h">Email notifications</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Choose when we email you outside the app. Saved to your account, applies across devices.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">@mention emails</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">A teammate @-mentions you in an internal note.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${mentionEmailOn ? 'checked' : ''} data-change-action="settings.setMentionEmail">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div id="mention-email-msg" style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:8px;min-height:14px"></div>
    </div>
    ${settingsPushSection()}`;
}

async function setMentionEmailPref(enabled) {
  const msg = document.getElementById('mention-email-msg');
  if (msg) { msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)'; }
  try {
    const res = await apiPatch('/api/v1/me', { mention_email_enabled: enabled });
    ME_PREFS = res.user;
    if (msg) { msg.textContent = enabled ? '✓ Enabled' : '✓ Disabled'; msg.style.color = 'var(--green)'; }
  } catch (err) {
    if (msg) { msg.textContent = err?.message || 'Save failed'; msg.style.color = 'var(--red)'; }
    // Revert UI if the patch failed.
    ME_PREFS_LOADED = false;
    renderPage('settings');
  }
}

function toggleNotifPref(k, v) {
  NOTIF_PREFS[k] = v;
  localStorage.setItem('notif_prefs', JSON.stringify(NOTIF_PREFS));
  refreshNotifBadge();
}

function settingsAI() {
  const models = [
    {v:'claude-opus-4-7',  l:'Claude Opus 4.7'},
    {v:'claude-sonnet-4-6',l:'Claude Sonnet 4.6'},
    {v:'claude-haiku-4-5', l:'Claude Haiku 4.5'},
  ];
  // Warm the shared workspace-settings cache (the portal/branding tab reads
  // it); either tab triggers the fetch, whichever paints first.
  if (!WORKSPACE_SETTINGS_LOADED) {
    WORKSPACE_SETTINGS_LOADED = true;
    apiGet('/api/v1/workspace/settings')
      .then((res) => { WORKSPACE_SETTINGS = res.workspace; renderPage('settings'); })
      .catch((err) => { console.warn('[settings] workspace load failed:', err); });
  }
  return `
    <div class="settings-section">
      <div class="settings-h">Claude API</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Used by the <strong style="color:var(--ink2)">AI Draft</strong> button in the ticket composer. Stored locally in your browser — never sent to our servers.</div>
      <div class="form-row">
        <label class="form-label">API key</label>
        <input class="form-input" type="password" id="set-ai-key" value="${AI_API_KEY}" placeholder="sk-ant-…" data-input-action="settings.setAiKey" autocomplete="off"/>
      </div>
      <div class="form-row">
        <label class="form-label">Model</label>
        <select class="form-input" data-change-action="settings.setAiModel">
          ${models.map(m => `<option value="${m.v}" ${AI_MODEL===m.v?'selected':''}>${m.l}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:11px;color:${AI_API_KEY?'var(--green)':'var(--ink3)'};font-family:'DM Mono',monospace;margin-top:8px">
        ${AI_API_KEY ? '✓ Key saved' : 'No key configured — AI Draft will return a fallback message'}
      </div>
    </div>`;
}

function settingsKnowledgeBase() {
  const cfg = KB_INTEGRATION;
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const testState = KB_TEST_STATE || null;
  return `
    <div class="settings-section">
      <div class="settings-h">External Knowledge Base</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Connect a third-party KB so the composer can ground AI replies in your own articles. Configure the endpoint + JSON field mapping; the adapter is generic and works with any REST API that returns a list of articles per query.</div>
      <div style="font-size:11px;color:var(--amber);background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);padding:8px 10px;margin-bottom:14px;line-height:1.5">
        <strong>Security notes.</strong> The API key is held in browser <code style="font-family:'DM Mono',monospace">localStorage</code> on this device — anyone with access to this browser profile can read it. Point the base URL at an external KB only; internal IPs or non-HTTPS hosts are blocked from most browser fetch contexts and shouldn't be used. Audit your KB content for prompt-injection — KB excerpts are clearly marked as untrusted data when sent to Claude, but reviewers should still vet what the model can see.
      </div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Integration enabled</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">When on, the composer shows an "AI Reply with KB" action and the ticket sidebar lists matching articles.</div>
        </div>
        <label class="toggle"><input type="checkbox" ${cfg.enabled?'checked':''} data-change-action="settings.setKbCfg" data-key="enabled"><span class="toggle-slider"></span></label>
      </div>
      <div class="form-row"><label class="form-label">Base URL</label>
        <input class="form-input" id="kb-base-url" placeholder="https://kb.example.com/api/v1" value="${esc(cfg.baseUrl)}" data-input-action="settings.setKbCfg" data-key="baseUrl"/>
      </div>
      <div class="form-row"><label class="form-label">Search path <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:11px;font-weight:400">— use {query} as placeholder</span></label>
        <input class="form-input" id="kb-search-path" placeholder="/articles?q={query}&amp;limit=5" value="${esc(cfg.searchPath)}" data-input-action="settings.setKbCfg" data-key="searchPath"/>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Auth header (optional)</label>
          <input class="form-input" placeholder="Authorization" value="${esc(cfg.authHeader)}" data-input-action="settings.setKbCfg" data-key="authHeader"/>
        </div>
        <div class="form-row"><label class="form-label">Header prefix</label>
          <input class="form-input" placeholder="Bearer " value="${esc(cfg.authPrefix)}" data-input-action="settings.setKbCfg" data-key="authPrefix"/>
        </div>
      </div>
      <div class="form-row"><label class="form-label">API key / token (optional)</label>
        <input class="form-input" type="password" placeholder="—" value="${esc(cfg.apiKey)}" data-input-action="settings.setKbCfg" data-key="apiKey" autocomplete="off"/>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Response shape</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Tell the adapter where to find articles inside the JSON response. Field names support dot notation (e.g. <code style="font-family:'DM Mono',monospace">data.items</code>).</div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Results path</label>
          <input class="form-input" placeholder="(empty = response root)" value="${esc(cfg.resultsField)}" data-input-action="settings.setKbCfg" data-key="resultsField"/>
        </div>
        <div class="form-row"><label class="form-label">Max results</label>
          <input class="form-input" type="number" min="1" max="20" value="${cfg.maxResults}" data-input-action="settings.setKbCfg" data-key="maxResults"/>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">ID field</label><input class="form-input" value="${esc(cfg.idField)}" data-input-action="settings.setKbCfg" data-key="idField"/></div>
        <div class="form-row"><label class="form-label">Title field</label><input class="form-input" value="${esc(cfg.titleField)}" data-input-action="settings.setKbCfg" data-key="titleField"/></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Body field</label><input class="form-input" value="${esc(cfg.bodyField)}" data-input-action="settings.setKbCfg" data-key="bodyField"/></div>
        <div class="form-row"><label class="form-label">URL field</label><input class="form-input" value="${esc(cfg.urlField)}" data-input-action="settings.setKbCfg" data-key="urlField"/></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Test connection</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Send a sample query against the configured endpoint to verify the path, auth, and field mapping.</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="form-input" id="kb-test-q" placeholder="e.g. password reset" style="flex:1;min-width:200px" value="${esc(testState?.query || 'password reset')}"/>
        <button class="btn btn-sm" data-action="settings.testKb" ${cfg.enabled?'':'disabled'}>Run test</button>
      </div>
      ${testState ? `
        <div style="margin-top:14px;padding:12px;border:1px solid ${testState.error?'var(--red)':'var(--green)'};border-radius:var(--r);background:${testState.error?'var(--red-lt)':'var(--green-lt)'}">
          ${testState.error ? `<div style="font-size:12px;color:var(--red);font-family:'DM Mono',monospace">${window.escHtml(testState.error)}</div>` : `
            <div style="font-size:12px;color:var(--green);font-weight:500;margin-bottom:8px">✓ ${testState.articles.length} article${testState.articles.length===1?'':'s'} returned</div>
            ${testState.articles.map(a => `<div style="padding:6px 8px;background:var(--off);border:1px solid var(--rule);border-radius:3px;margin-bottom:4px"><div style="font-size:12px;font-weight:500;color:var(--ink)">${window.escHtml(a.title)}</div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${window.escHtml(a.id)} · ${window.escHtml(a.url || '(no url)')}</div></div>`).join('')}
          `}
        </div>` : ''}
    </div>`;
}

function setKbCfg(key, value) {
  KB_INTEGRATION[key] = value;
  saveKbIntegration();
  KB_TICKET_CACHE.clear();
}

async function testKbConnection() {
  const q = document.getElementById('kb-test-q')?.value?.trim() || 'password reset';
  KB_TEST_STATE = { query: q, loading: true };
  renderPage('settings');
  const result = await fetchKbArticles(q);
  KB_TEST_STATE = { query: q, articles: result.articles || [], error: result.error || null };
  renderPage('settings');
}

function settingsLanguage() {
  return `
    <div class="settings-section">
      <div class="settings-h">Your reading language</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">When ticket-thread translation is enabled (toggle above the conversation), customer messages render in this language. Replies you compose can also be auto-translated to the customer's language before sending. Detection and translation use the Claude API key configured in <span class="link" data-action="settings.setTab" data-tab="ai">AI Assistant</span>.</div>
      <div class="form-row">
        <label class="form-label">Preferred language</label>
        <select class="form-input" id="set-pref-lang" data-change-action="settings.setLang">
          ${TRANSLATOR_LANGS.map(l => `<option value="${l}" ${AGENT_PREFERRED_LANG===l?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:11px;color:${AI_API_KEY?'var(--green)':'var(--amber)'};font-family:'DM Mono',monospace;margin-top:8px">
        ${AI_API_KEY ? `✓ Currently set to ${AGENT_PREFERRED_LANG}` : 'Add an API key in AI Assistant to enable detection and translation.'}
      </div>
    </div>`;
}

// ─── Integrations panel (Slack) ──────────────────────────────────────────
function settingsIntegrations() {
  // Lazy load on first paint; trigger a re-render when the fetch lands.
  if (!SLACK_LOADED) {
    SLACK_LOADED = true;
    apiGet('/api/v1/integrations/slack')
      .then((res) => { SLACK_INTEGRATION = res.integration; renderPage('settings'); })
      .catch((err) => { console.warn('[settings] slack load failed:', err); });
  }
  const slack = SLACK_INTEGRATION;
  const events = slack?.events || ['ticket.resolved', 'ticket.escalated'];
  const checkbox = (k, l) => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px">
      <input type="checkbox" id="slack-evt-${k}" ${events.includes(k) ? 'checked' : ''}/>
      ${window.escHtml(l)}
    </label>`;
  return `
    <div class="settings-section">
      <div class="settings-h">Slack</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Post a message to a Slack channel when key ticket events fire.
        Paste your Slack <a href="https://api.slack.com/messaging/webhooks" target="_blank" style="color:var(--purple)">incoming-webhook URL</a> — it's the secret, so treat it like a password.
      </div>
      <div class="form-row">
        <label class="form-label">Webhook URL</label>
        <input class="form-input" id="slack-url" type="url" value="${window.escAttr(slack?.webhook_url || '')}" placeholder="https://hooks.slack.com/services/..." autocomplete="off"/>
      </div>
      <div class="form-row">
        <label class="form-label">Channel override (optional)</label>
        <input class="form-input" id="slack-channel" value="${window.escAttr(slack?.channel || '')}" placeholder="#support"/>
        <div style="font-size:11px;color:var(--ink3);margin-top:4px">Leave blank to use the channel the webhook is bound to in Slack.</div>
      </div>
      <div class="form-row">
        <label class="form-label">Events</label>
        ${SLACK_EVENTS.map((e) => checkbox(e.k, e.l)).join('')}
      </div>
      <div class="form-row" style="display:flex;align-items:center;gap:8px">
        <label class="toggle"><input type="checkbox" id="slack-active" ${slack?.active !== false ? 'checked' : ''}/><span class="toggle-slider"></span></label>
        <span style="font-size:13px;color:var(--ink2)">Active</span>
      </div>

      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
        <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px">Two-way sync (optional)</div>
        <div style="font-size:11px;color:var(--ink3);margin-bottom:12px;line-height:1.5">
          Lets agents reply directly from the Slack thread that the notification creates — replies are recorded on the ticket. Requires a Slack app with the <code style="font-family:'DM Mono',monospace;color:var(--ink2)">chat:write</code>, <code style="font-family:'DM Mono',monospace;color:var(--ink2)">users:read</code>, and <code style="font-family:'DM Mono',monospace;color:var(--ink2)">users:read.email</code> scopes plus the Events API URL pointed at <code style="font-family:'DM Mono',monospace;color:var(--ink2)">/api/v1/webhooks/slack/events</code>.
        </div>
        ${slack?.has_bot_token ? `
          <div style="margin-bottom:10px;padding:8px 10px;background:var(--green-lt);border:1px solid var(--green);border-radius:var(--r);font-size:11px;color:var(--green);display:flex;gap:8px;align-items:center">
            <span style="font-weight:600">Two-way ready</span>
            <span style="font-family:'DM Mono',monospace;color:var(--ink2)">xoxb-...${window.escHtml(slack.bot_token_suffix || '')}</span>
          </div>` : ''}
        <div class="form-row">
          <label class="form-label">Bot token</label>
          <input class="form-input" id="slack-bot-token" type="password" placeholder="${slack?.has_bot_token ? 'Paste a new token to rotate' : 'xoxb-...'}" autocomplete="off"/>
        </div>
        <div class="form-row">
          <label class="form-label">Signing secret</label>
          <input class="form-input" id="slack-signing-secret" type="password" placeholder="${slack?.has_signing_secret ? 'Paste a new secret to rotate' : 'app signing secret'}" autocomplete="off"/>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-solid btn-sm" data-action="settings.saveSlack">Save</button>
        ${slack ? '<button class="btn btn-sm btn-danger" data-action="settings.deleteSlack">Disconnect</button>' : ''}
        <span id="slack-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
      </div>
    </div>
    ${settingsOutgoingWebhooksSection()}
    ${settingsSuppressionListSection()}`;
}

// ─── Outgoing webhooks ──────────────────────────────────────────────────
//
// Multiple webhooks per workspace, distinct from Slack
// (which is single-instance). List + Create + Delete are exposed in
// this slice; rotating the secret = delete + recreate. Secrets are
// surfaced once at creation time via LAST_REVEALED_SECRET, then
// cleared on the next render so they can't be re-read by paging
// through DevTools.

function settingsOutgoingWebhooksSection() {
  if (!OUTGOING_WEBHOOKS_LOADED) {
    OUTGOING_WEBHOOKS_LOADED = true;
    apiGet('/api/v1/integrations/webhooks')
      .then((res) => { OUTGOING_WEBHOOKS = res.webhooks || []; renderPage('settings'); })
      .catch((err) => { console.warn('[settings] webhooks load failed:', err); });
  }
  const list = OUTGOING_WEBHOOKS;

  // One-time secret reveal — pulled out before render so the next
  // settings re-render starts clean and the user can't accidentally
  // re-read it by switching tabs.
  const revealedBanner = LAST_REVEALED_SECRET ? `
    <div style="margin-bottom:14px;padding:12px 14px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:12px">
      <div style="font-weight:600;color:var(--amber);margin-bottom:6px">Save this signing secret — it won't be shown again</div>
      <div style="font-family:'DM Mono',monospace;color:var(--ink);background:var(--off2);padding:8px 10px;border-radius:3px;word-break:break-all;user-select:all">${window.escHtml(LAST_REVEALED_SECRET)}</div>
      <div style="margin-top:6px;color:var(--ink3)">Use this with HMAC-SHA256 over <code>v0:&lt;X-Maestro-Timestamp&gt;:&lt;raw-body&gt;</code> and compare to the <code>X-Maestro-Signature</code> header.</div>
    </div>` : '';
  LAST_REVEALED_SECRET = null;

  const rows = list.length === 0 ? `
    <div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No outgoing webhooks configured.</div>
  ` : list.map((w) => {
    const last = w.last_delivery_at ? new Date(w.last_delivery_at).toISOString().slice(0, 19).replace('T', ' ') : '—';
    const statusColor = w.last_delivery_error
      ? 'var(--red)'
      : (w.last_delivery_status && w.last_delivery_status < 400 ? 'var(--green)' : 'var(--ink3)');
    const statusLabel = w.last_delivery_error
      ? `error · ${window.escHtml(w.last_delivery_error.slice(0, 40))}`
      : (w.last_delivery_status ? `HTTP ${w.last_delivery_status}` : 'no deliveries yet');
    return `
      <div style="padding:10px 0;border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;color:var(--ink);font-size:13px">${window.escHtml(w.name)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(w.url)}</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">
            <span style="color:${statusColor}">${statusLabel}</span>
            <span style="color:var(--ink4);margin-left:8px">last: ${last}</span>
            <span style="color:var(--ink4);margin-left:8px">${w.events.length} event${w.events.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <button class="btn btn-sm" data-action="settings.editWebhook" data-id="${window.escAttr(w.id)}">Edit</button>
        <button class="btn btn-sm" data-action="settings.webhookDeliveries" data-id="${window.escAttr(w.id)}" data-name="${window.escAttr(w.name)}">Deliveries</button>
        <button class="btn btn-sm btn-danger" data-action="settings.deleteWebhook" data-id="${window.escAttr(w.id)}">Delete</button>
      </div>`;
  }).join('');

  const eventCheckboxes = SLACK_EVENTS.map((e) => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
      <input type="checkbox" id="wh-evt-${e.k}" checked/>
      ${window.escHtml(e.l)}
    </label>`).join('');

  return `
    <div class="settings-section">
      <div class="settings-h">Outgoing webhooks</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Register HTTP endpoints to receive ticket-event POSTs. Generic alternative to the Slack integration — useful for piping events into a CRM, analytics pipeline, or homemade automation. Payloads are JSON, signed with HMAC-SHA256 using a secret generated at creation time.
      </div>
      ${revealedBanner}
      <div>${rows}</div>
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">
        <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:10px">Add webhook</div>
        <div class="form-row">
          <label class="form-label">Name</label>
          <input class="form-input" id="wh-name" placeholder="e.g. CRM sync"/>
        </div>
        <div class="form-row">
          <label class="form-label">URL</label>
          <input class="form-input" id="wh-url" type="url" placeholder="https://your-receiver.example.com/maestro"/>
        </div>
        <div class="form-row">
          <label class="form-label">Events</label>
          ${eventCheckboxes}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-solid btn-sm" data-action="settings.createWebhook">Create</button>
          <span id="wh-msg" style="margin-left:auto;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace"></span>
        </div>
      </div>
    </div>`;
}

async function createOutgoingWebhook() {
  if (!window.isAdmin()) return;
  const name   = document.getElementById('wh-name').value.trim();
  const url    = document.getElementById('wh-url').value.trim();
  const events = SLACK_EVENTS.filter((e) => document.getElementById(`wh-evt-${e.k}`)?.checked).map((e) => e.k);
  const msg = document.getElementById('wh-msg');
  if (!name) { msg.textContent = 'Name is required'; msg.style.color = 'var(--red)'; return; }
  if (!url)  { msg.textContent = 'URL is required';  msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Creating...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPost('/api/v1/integrations/webhooks', { name, url, events });
    LAST_REVEALED_SECRET = res.secret;
    // Re-fetch the list so the new row appears.
    const list = await apiGet('/api/v1/integrations/webhooks');
    OUTGOING_WEBHOOKS = list.webhooks || [];
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Create failed';
    msg.style.color = 'var(--red)';
  }
}

async function deleteOutgoingWebhook(id) {
  if (!window.isAdmin()) return;
  if (!confirm('Delete this webhook? Events will stop firing immediately.')) return;
  try {
    await apiDelete(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`);
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.filter((w) => w.id !== id);
    renderPage('settings');
  } catch (err) {
    alert(`Couldn't delete: ${err?.message || err}`);
  }
}

// ─── Postmark suppression list ──────────────────────────────────────────
//
// Surfaces every customer whose email is currently in hard or spam
// bounce state. Reset clears the local bounce summary; if the address
// is still suppressed at Postmark, the next send will bounce again
// and re-populate this list. Soft bounces aren't shown here — they're
// transient by nature and the count badge on the customer detail is
// enough.

function settingsSuppressionListSection() {
  const scope = suppressionScope();
  if (SUPPRESSED_SCOPE !== scope) {
    SUPPRESSED_SCOPE = scope;
    SUPPRESSED_CUSTOMERS = [];
    SUPPRESSED_LOADED = false;
  }
  if (!SUPPRESSED_LOADED) {
    SUPPRESSED_LOADED = true;
    apiGet('/api/v1/integrations/postmark/suppressed/contacts')
      .then((res) => {
        if (suppressionScope() !== scope) return;
        SUPPRESSED_CUSTOMERS = res.suppressed || [];
        renderPage('settings');
      })
      .catch((err) => {
        if (suppressionScope() !== scope) return;
        SUPPRESSED_LOADED = false;
        console.warn('[settings] suppression load failed:', err);
      });
  }
  const list = SUPPRESSED_CUSTOMERS;
  const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '—';
  const rows = list.length === 0 ? `
    <div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No suppressed addresses.</div>
  ` : list.map((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.display_id || '(no name)';
    const stateColor = c.email_bounce_state === 'spam' ? 'var(--red)' : 'var(--red)';
    return `
      <div style="padding:10px 0;border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;color:var(--ink);font-size:13px">${window.escHtml(name)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(c.email || '')}</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">
            <span style="color:${stateColor};font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">${window.escHtml(c.email_bounce_state)}</span>
            <span style="color:var(--ink4);margin-left:8px">${window.escHtml(c.email_last_bounce_type || '')}</span>
            <span style="color:var(--ink4);margin-left:8px">last: ${fmtTs(c.email_last_bounce_at)}</span>
            <span style="color:var(--ink4);margin-left:8px">${c.email_bounce_count} bounce${c.email_bounce_count === 1 ? '' : 's'}</span>
          </div>
        </div>
        <button class="btn btn-sm" data-action="settings.resetSuppressed" data-id="${window.escAttr(c.id)}" data-contact-id="${window.escAttr(c.contact_id || '')}">Reset</button>
      </div>`;
  }).join('');

  return `
    <div class="settings-section">
      <div class="settings-h">Postmark suppression list</div>
      <div class="settings-desc" style="margin-bottom:14px">
        Email addresses flagged by a bounce or spam complaint. Reset clears the flag for that address only. Postmark may still block delivery until its suppression is removed.
      </div>
      <div>${rows}</div>
    </div>`;
}

async function resetSuppressedCustomer(customerId, contactId) {
  if (!window.isAdmin()) return;
  const scope = suppressionScope();
  if (!confirm('Reset the bounce status for this email address? Respovia will allow sends to it again.')) return;
  try {
    const target = contactId ? `/contacts/${encodeURIComponent(contactId)}` : '';
    const result = await apiPost(`/api/v1/integrations/postmark/suppressed/${encodeURIComponent(customerId)}${target}/reset`);
    if (suppressionScope() !== scope) return;
    SUPPRESSED_CUSTOMERS = SUPPRESSED_CUSTOMERS.filter((c) => contactId ? c.contact_id !== contactId : c.id !== customerId);
    // Also clear the in-memory customer record so the badge disappears
    // on the customer detail without a full bootstrap reload.
    if (typeof CUSTOMERS !== 'undefined') {
      const cust = CUSTOMERS.find((c) => c._uuid === customerId);
      if (cust) {
        const address = cust.emails?.find((x) => contactId ? x.id === contactId : x.is_primary);
        if (address) {
          address.bounce_state = 'none';
          address.bounce_count = 0;
          address.bounce_last_at = null;
        }
        if (result.contact?.is_primary ?? !contactId) {
          cust.emailBounceState = 'none';
          cust.emailBounceCount = 0;
          cust.emailLastBounce  = null;
        }
      }
    }
    renderPage('settings');
  } catch (err) {
    alert(`Couldn't reset: ${err?.message || err}`);
  }
}

// ─── Delivery log modal ─────────────────────────────────────────────────
//
// Opens a modal listing the 50 most recent delivery attempts for one
// webhook. Renders empty-then-load (showModal first with a "loading"
// stub, then swap the inner container's HTML when the fetch resolves)
// so the user gets immediate feedback. No re-fetch or live update —
// this is a snapshot view, the user closes + reopens for a refresh.

function showOutgoingWebhookDeliveries(id, name) {
  showModal(
    `Deliveries · ${name}`,
    `<div id="wh-deliveries-body" data-webhook-id="${window.escAttr(id)}" style="min-height:120px;color:var(--ink3);font-size:12px">Loading…</div>`,
    null, null, true,
  );
  loadOutgoingWebhookDeliveries(id);
}

async function loadOutgoingWebhookDeliveries(id) {
  const container = document.getElementById('wh-deliveries-body');
  if (!container) return;
  try {
    const res = await apiGet(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}/deliveries`);
    container.innerHTML = renderDeliveryRows(id, res.deliveries || []);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);font-size:12px">${window.escHtml(err?.message || 'Failed to load')}</div>`;
  }
}

function renderDeliveryRows(webhookId, deliveries) {
  if (deliveries.length === 0) {
    return `<div style="color:var(--ink3);font-size:12px;text-align:center;padding:20px 0">No deliveries yet.</div>`;
  }
  const stateColor = (s) => s === 'success' ? 'var(--green)' : s === 'exhausted' ? 'var(--red)' : 'var(--amber)';
  const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : '—';
  return `
    <div style="display:grid;grid-template-columns:auto 1fr auto auto auto auto auto;gap:8px 12px;font-size:11px;align-items:baseline">
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">State</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Event</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Attempts</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Last status</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Last attempt</div>
      <div style="color:var(--ink3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Next attempt</div>
      <div></div>
      ${deliveries.map((d) => {
        const last = d.last_status
          ? `HTTP ${d.last_status}`
          : (d.last_error ? `<span title="${window.escAttr(d.last_error)}">err</span>` : '—');
        const retryBtn = d.state === 'exhausted'
          ? `<button class="btn btn-sm" data-action="settings.retryDelivery" data-webhook-id="${window.escAttr(webhookId)}" data-delivery-id="${window.escAttr(d.id)}">Retry</button>`
          : '';
        return `
          <div><span style="color:${stateColor(d.state)};font-weight:600;text-transform:uppercase;font-family:'DM Mono',monospace">${d.state}</span></div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink2)">${window.escHtml(d.event)}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink)">${d.attempts}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink2)">${last}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink3)">${fmtTs(d.last_attempt_at)}</div>
          <div style="font-family:'DM Mono',monospace;color:var(--ink3)">${d.state === 'pending' ? fmtTs(d.next_attempt_at) : '—'}</div>
          <div>${retryBtn}</div>
        `;
      }).join('')}
    </div>`;
}

async function retryWebhookDelivery(webhookId, deliveryId) {
  try {
    await apiPost(`/api/v1/integrations/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`);
    // Refresh the modal in-place so the row flips to pending with
    // attempts=0 and a fresh next_attempt_at. The worker tick will
    // fire on the next ~5s cycle.
    await loadOutgoingWebhookDeliveries(webhookId);
  } catch (err) {
    alert(`Couldn't re-queue: ${err?.message || err}`);
  }
}

// ─── Edit modal ─────────────────────────────────────────────────────────
//
// Opens a modal pre-populated from OUTGOING_WEBHOOKS (no server fetch
// needed — the list is already in module state). Form fields share an
// `we-*` prefix so we don't collide with the inline create form's
// `wh-*` fields. Save and Rotate-secret are separate actions; the
// rotate flow surfaces the new secret in the same one-shot banner
// the create flow uses.

function editOutgoingWebhook(id) {
  if (!window.isAdmin()) return;
  const w = OUTGOING_WEBHOOKS.find((x) => x.id === id);
  if (!w) return;
  const eventCheckboxes = SLACK_EVENTS.map((e) => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
      <input type="checkbox" id="we-evt-${e.k}" ${w.events.includes(e.k) ? 'checked' : ''}/>
      ${window.escHtml(e.l)}
    </label>`).join('');
  // onConfirm-with-callback is avoided here: showModal's .toString()
  // round-trip loses our module-scope imports (apiPatch in particular),
  // so the buttons are inlined into the body and routed through
  // data-action delegation (settings.saveWebhookEdit / rotateSecret /
  // closeModal) instead.
  showModal(`Edit webhook · ${w.name}`,
    `<input type="hidden" id="we-id" value="${window.escAttr(w.id)}"/>
     <div class="form-row">
       <label class="form-label">Name</label>
       <input class="form-input" id="we-name" value="${window.escAttr(w.name)}"/>
     </div>
     <div class="form-row">
       <label class="form-label">URL</label>
       <input class="form-input" id="we-url" type="url" value="${window.escAttr(w.url)}"/>
     </div>
     <div class="form-row">
       <label class="form-label">Events</label>
       ${eventCheckboxes}
     </div>
     <div class="form-row" style="display:flex;align-items:center;gap:8px">
       <label class="toggle"><input type="checkbox" id="we-active" ${w.active ? 'checked' : ''}/><span class="toggle-slider"></span></label>
       <span style="font-size:13px;color:var(--ink2)">Active</span>
     </div>
     <div style="display:flex;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--rule)">
       <button class="btn" data-action="settings.closeModal">Cancel</button>
       <button class="btn btn-solid" data-action="settings.saveWebhookEdit">Save</button>
       <span id="we-msg" style="margin-left:auto;font-size:11px;font-family:'DM Mono',monospace;color:var(--ink3)"></span>
     </div>
     <div style="margin-top:18px;padding:12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r)">
       <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px">Rotate signing secret</div>
       <div style="font-size:11px;color:var(--ink3);margin-bottom:10px;line-height:1.5">
         Generates a fresh secret and invalidates the old one immediately. In-flight retries will start failing HMAC verification at the receiver until you update its configuration.
       </div>
       <button class="btn btn-sm btn-danger" data-action="settings.rotateSecret">Rotate secret</button>
     </div>`,
    null, null, true,
  );
}

// Invoked from the edit modal's Save button via the settings.saveWebhookEdit
// delegated action. Reads the form by id rather than closing over the webhook
// record (see modal.js comment).
async function saveOutgoingWebhookEdit() {
  const id     = document.getElementById('we-id').value;
  const name   = document.getElementById('we-name').value.trim();
  const url    = document.getElementById('we-url').value.trim();
  const events = SLACK_EVENTS.filter((e) => document.getElementById(`we-evt-${e.k}`)?.checked).map((e) => e.k);
  const active = document.getElementById('we-active').checked;
  const msg = document.getElementById('we-msg');
  if (!name) { msg.textContent = 'Name is required'; msg.style.color = 'var(--red)'; return; }
  if (!url)  { msg.textContent = 'URL is required';  msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  try {
    const res = await apiPatch(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`, { name, url, events, active });
    // Replace the row in module state so the panel re-renders with
    // the new values without a full refetch.
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.map((w) => w.id === id ? { ...w, ...res.webhook } : w);
    closeModal();
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

async function rotateOutgoingWebhookSecret() {
  const id = document.getElementById('we-id').value;
  if (!confirm('Rotate the signing secret? The current secret will stop working immediately.')) return;
  const msg = document.getElementById('we-msg');
  msg.textContent = 'Rotating...'; msg.style.color = 'var(--ink3)';
  try {
    const res = await apiPatch(`/api/v1/integrations/webhooks/${encodeURIComponent(id)}`, { rotate_secret: true });
    // Surface the new secret via the same one-shot banner used by
    // create — close the modal so the user can see it on the panel.
    LAST_REVEALED_SECRET = res.secret;
    OUTGOING_WEBHOOKS = OUTGOING_WEBHOOKS.map((w) => w.id === id ? { ...w, ...res.webhook } : w);
    closeModal();
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Rotation failed';
    msg.style.color = 'var(--red)';
  }
}

async function saveSlackIntegration() {
  if (!window.isAdmin()) return;
  const url           = document.getElementById('slack-url').value.trim();
  const channel       = document.getElementById('slack-channel').value.trim();
  const active        = document.getElementById('slack-active').checked;
  const events        = SLACK_EVENTS.filter((e) => document.getElementById(`slack-evt-${e.k}`)?.checked).map((e) => e.k);
  const botToken      = document.getElementById('slack-bot-token')?.value.trim() || '';
  const signingSecret = document.getElementById('slack-signing-secret')?.value.trim() || '';
  const msg = document.getElementById('slack-msg');
  if (!url) { msg.textContent = 'Webhook URL is required'; msg.style.color = 'var(--red)'; return; }
  if (events.length === 0) { msg.textContent = 'Pick at least one event'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Saving...'; msg.style.color = 'var(--ink3)';
  try {
    // Only send bot_token / signing_secret when the user actually
    // typed something — sending undefined leaves the server-side value
    // alone, which is what we want for "save settings without
    // rotating credentials".
    const body = {
      webhook_url: url,
      channel:     channel || null,
      active,
      events,
    };
    if (botToken)      body.bot_token      = botToken;
    if (signingSecret) body.signing_secret = signingSecret;
    await apiPut('/api/v1/integrations/slack', body);
    const res = await apiGet('/api/v1/integrations/slack');
    SLACK_INTEGRATION = res.integration;
    document.getElementById('slack-bot-token').value = '';
    document.getElementById('slack-signing-secret').value = '';
    msg.textContent = 'Saved'; msg.style.color = 'var(--green)';
    renderPage('settings');
  } catch (err) {
    msg.textContent = err?.message || 'Save failed';
    msg.style.color = 'var(--red)';
  }
}

async function deleteSlackIntegration() {
  if (!window.isAdmin()) return;
  if (!confirm('Disconnect Slack? Future ticket events won\'t notify until you reconnect.')) return;
  try {
    await apiDelete('/api/v1/integrations/slack');
    SLACK_INTEGRATION = null;
    renderPage('settings');
  } catch (err) {
    alert(`Couldn't disconnect: ${err?.message || err}`);
  }
}

// ─── Delegated actions ──────────────────────────────────────────────────────
// All settings panels are injected via innerHTML, so the document-level
// dispatcher in core/event-delegation.js catches these. setSettingsTab is the
// one export that stays window-reachable (explicit app.js bridge entry) for
// notifications' cross-module reach.
const setKbCfgHandler = (ds, el) => {
  let v;
  if (el.type === 'checkbox')        v = el.checked;
  else if (ds.key === 'maxResults')  v = parseInt(el.value, 10) || 3;
  else                               v = el.value;
  setKbCfg(ds.key, v);
};

// ─── Categories (admin) ────────────────────────────────────────────────────
// Manage the workspace's ticket categories: disable a default (reversible —
// hidden from new tickets + AI triage, history preserved) or create a new one.
// Backed by /api/v1/categories. Admin-only (the tab is gated in renderSettings).
function settingsCategories() {
  if (!CATEGORIES_LOADED) {
    CATEGORIES_LOADED = true;
    refreshCategories().catch((err) => console.warn('[settings] categories load failed:', err));
  }
  const isAdmin = window.isAdmin();
  const sorted   = [...CATEGORIES].sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  const active   = sorted.filter((c) => c.is_active);
  const disabled = sorted.filter((c) => !c.is_active);

  const row = (c, nextActive) => `
    <div class="settings-row">
      <div style="font-size:13px;color:var(--ink)">${window.escHtml(c.label)}
        <span style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-left:6px">${window.escHtml(c.key)}</span>
      </div>
      <button class="btn btn-sm" data-action="settings.toggleCategory" data-key="${window.escAttr(c.key)}" data-next="${nextActive}" ${isAdmin ? '' : 'disabled'}>${nextActive === 'true' ? 'Enable' : 'Disable'}</button>
    </div>`;

  const activeList = active.length
    ? active.map((c) => row(c, 'false')).join('')
    : `<div style="font-size:12px;color:var(--ink3);padding:8px 0">No active categories yet.</div>`;
  const disabledList = disabled.length
    ? `<div class="settings-h" style="margin-top:18px">Disabled</div>
       <div style="font-size:12px;color:var(--ink3);margin-bottom:8px">Hidden from new tickets and AI triage; existing tickets keep the category. Re-enable any time.</div>
       ${disabled.map((c) => row(c, 'true')).join('')}`
    : '';

  return `
    <div class="settings-section">
      <div class="settings-h">Ticket categories</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">
        The categories agents and AI triage can assign to tickets. Disable one to retire it without losing history; create new ones for your workflows. Admins only.
      </div>
      ${activeList}
      ${disabledList}
      <div class="form-row" style="margin-top:18px">
        <label class="form-label">Add a category</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="form-input" id="new-cat-label" type="text" maxlength="64" placeholder="e.g. Withdrawals" ${isAdmin ? '' : 'disabled'} style="flex:1"/>
          <button class="btn btn-solid btn-sm" data-action="settings.addCategory" ${isAdmin ? '' : 'disabled'}>Add</button>
        </div>
        <span id="cat-msg" style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:6px;display:block"></span>
      </div>
    </div>`;
}

// Re-fetch the canonical category list (active + inactive) and repaint. The
// shared CATEGORIES array is mutated in place so the New-Ticket dropdown
// (which imports it) reflects changes too.
function refreshCategories() {
  return apiGet('/api/v1/categories').then((res) => {
    CATEGORIES.length = 0;
    for (const c of (res.categories || [])) CATEGORIES.push(c);
    renderPage('settings');
  });
}

// Write to the shared status line under the add-category form. Re-queries each
// call (refreshCategories repaints the panel) and no-ops safely if the element
// isn't present — both add + toggle route their feedback through here so an
// error is never dropped silently.
function setCatMsg(text, color) {
  const m = document.getElementById('cat-msg');
  if (m) { m.textContent = text; m.style.color = color; }
}

async function addCategory() {
  if (!window.isAdmin()) return;
  const input = document.getElementById('new-cat-label');
  const label = (input?.value || '').trim();
  if (!label) { setCatMsg('Enter a category name', 'var(--red)'); return; }
  setCatMsg('Adding…', 'var(--ink3)');
  try {
    await apiPost('/api/v1/categories', { label });
    await refreshCategories();   // repaints — clears the input + shows the new row
    setCatMsg('✓ Added', 'var(--green)');
  } catch (err) {
    // 409 carries a helpful message (incl. the re-enable hint for a disabled clash).
    setCatMsg(err?.message || 'Add failed', 'var(--red)');
  }
}

// nextActive is a real boolean here — the handler converts the stringy
// data-next attribute ('true'/'false') to a boolean before calling this.
async function toggleCategory(key, nextActive) {
  if (!window.isAdmin()) return;
  try {
    await apiPatch(`/api/v1/categories/${encodeURIComponent(key)}`, { is_active: nextActive });
    await refreshCategories();
  } catch (err) {
    setCatMsg(err?.message || 'Update failed', 'var(--red)');
  }
}

registerActions({
  'settings.setTab':             (ds) => setSettingsTab(ds.tab),
  'settings.logout':            () => window.logout(),
  'settings.resetCollapsed':    () => resetAllCollapsedSections(),
  // workspace branding / portal
  'settings.uploadLogo':        () => uploadWorkspaceLogo(),
  'settings.saveBranding':      () => saveWorkspaceBranding(),
  'settings.savePortalCopy':    () => savePortalCopy(),
  'settings.savePortalDomain':  () => savePortalDomain(),
  'settings.verifyPortalDomain':() => verifyPortalDomain(),
  // KB test
  'settings.testKb':            () => testKbConnection(),
  // integrations
  'settings.saveSlack':         () => saveSlackIntegration(),
  'settings.deleteSlack':       () => deleteSlackIntegration(),
  // outgoing webhooks
  'settings.createWebhook':     () => createOutgoingWebhook(),
  'settings.editWebhook':       (ds) => editOutgoingWebhook(ds.id),
  'settings.deleteWebhook':     (ds) => deleteOutgoingWebhook(ds.id),
  'settings.webhookDeliveries': (ds) => showOutgoingWebhookDeliveries(ds.id, ds.name),
  'settings.retryDelivery':     (ds) => retryWebhookDelivery(ds.webhookId, ds.deliveryId),
  'settings.saveWebhookEdit':   () => saveOutgoingWebhookEdit(),
  'settings.rotateSecret':      () => rotateOutgoingWebhookSecret(),
  'settings.closeModal':        () => closeModal(),
  // suppression list
  'settings.resetSuppressed':   (ds) => resetSuppressedCustomer(ds.id, ds.contactId),
  // categories (admin)
  'settings.addCategory':       () => addCategory(),
  'settings.toggleCategory':    (ds) => toggleCategory(ds.key, ds.next === 'true'),
});

registerChangeActions({
  'settings.toggleNotif':   (ds, el) => toggleNotifPref(ds.key, el.checked),
  'settings.setMentionEmail':(ds, el) => setMentionEmailPref(el.checked),
  'settings.setAiModel':    (ds, el) => setAIModel(el.value),
  'settings.setLang':       (ds, el) => setAgentPreferredLang(el.value),
  'settings.setKbCfg':      setKbCfgHandler,
});

registerInputActions({
  'settings.updateName':     (ds, el) => updateProfileName(el.value),
  'settings.updateInitials': (ds, el) => updateProfileInitials(el.value),
  'settings.setAiKey':       (ds, el) => setAIKey(el.value),
  'settings.setKbCfg':       setKbCfgHandler,
  // color picker → mirror its value into the hex text input
  'settings.syncBrandColor': (ds, el) => { const t = document.getElementById('brand-primary-color'); if (t) t.value = el.value; },
});
