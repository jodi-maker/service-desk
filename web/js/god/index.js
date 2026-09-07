// God panel — platform-admin UI for managing white-label brands.
//
// First real-API surface in the SPA. Talks to /api/v1/god/* (gated by
// requirePlatformAdmin on the server). Auth is the standard Bearer-JWT
// flow set up by core/auth-client + core/api-client.
//
// Views:
//   - List: every non-system brand with quick stats + suspend toggle.
//   - Detail: single brand with full config, domains, ticket/member counts.
// New-brand creation lives in a separate module (PR G); this one is
// browse + edit only.
//
// State management:
//   The renderPage hook in app.js is synchronous, but the god panel
//   needs async fetches. Pattern: renderGod() returns a loading state
//   immediately and kicks off a fetch that calls reRender() when done.
//   Subsequent calls (e.g. after switching brands) reuse the cached list
//   when fresh and refresh detail on demand.
//
// All actions wire through core/event-delegation (data-action="god.X").

import { nav, updateNavBadges } from '../core/router.js';
import { apiGet, apiPatch, apiPost, apiDelete, setWorkspaceId, setBrandId } from '../core/api-client.js';
import { registerActions, registerInputActions } from '../core/event-delegation.js';
import { loadWorkspaceData } from '../core/bootstrap.js';
import { showModal, closeModal } from '../core/modal.js';
import { renderNewBrand, resetForm as resetNewBrandForm, setOnClose as setNewBrandOnClose } from './new-brand.js';

// ─── State ────────────────────────────────────────────────────────────────

const STATE = {
  view: 'list',          // 'list' | 'detail' | 'new-brand'
  brandsLoading: false,
  brands: [],
  brandsError: null,
  selectedId: null,
  detail: null,          // { brand, domains, counts }
  detailLoading: false,
  detailError: null,
  actionPending: false,  // true while a suspend/update is in flight
  enterPending: false,   // true while we're loading workspace data for an "Enter" click
  // Inline add-domain form state on detail view
  addDomainInput: '',
  addDomainPending: false,
  addDomainError: null,
  addDomainResult: null, // last successful add { domain, dns_setup }
  // Per-domain action state (verifying / deleting / verify result)
  domainAction: {}, // { [domainId]: { pending: bool, error: string|null, dns: {} | null } }
};

// ─── Entry point (called from app.js renderPage) ──────────────────────────

export function renderGod() {
  // Entering the god panel = leaving any in-progress workspace context.
  // Clear workspace_id so a refresh-from-god lands back on god (via the
  // platform-admin auto-resume) rather than slipping into the agent
  // shell of whichever brand the user last entered. Also clear the Maestro
  // brand context so it can't leak into the next brand the god enters.
  setWorkspaceId(null);
  setBrandId(null);
  // First render → kick off the list fetch.
  if (!STATE.brandsLoading && STATE.brands.length === 0 && !STATE.brandsError && STATE.view === 'list') {
    refreshList();
  }
  document.body.dataset.godView = STATE.view;
  if (STATE.view === 'new-brand') return renderNewBrand();
  return renderHtml();
}

function reRender() {
  const main = document.getElementById('main-area');
  if (!main || document.body.dataset.currentPage !== 'god') return;
  document.body.dataset.godView = STATE.view;
  main.innerHTML = STATE.view === 'new-brand' ? renderNewBrand() : renderHtml();
}

// New-brand form calls this when the user cancels/abandons it.
setNewBrandOnClose(() => {
  STATE.view = 'list';
  reRender();
});

// ─── HTML ─────────────────────────────────────────────────────────────────

function renderHtml() {
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Platform · Brands</div>
        <div class="tb-actions">
          <button class="btn btn-ghost" data-action="god.refresh" ${STATE.brandsLoading ? 'disabled' : ''}>
            ${STATE.brandsLoading ? 'Loading…' : 'Refresh'}
          </button>
          <button class="btn btn-solid" data-action="god.newBrand">+ New brand</button>
        </div>
      </div>
      <div class="page-scroll">
        ${STATE.view === 'list' ? renderList() : renderDetail()}
      </div>
    </div>`;
}

function renderList() {
  if (STATE.brandsError) {
    return errorBanner(STATE.brandsError, 'god.refresh');
  }
  if (STATE.brandsLoading && STATE.brands.length === 0) {
    return `<div class="card"><div style="padding:24px;color:var(--ink3)">Loading brands…</div></div>`;
  }
  if (STATE.brands.length === 0) {
    return `
      <div class="card" style="max-width:520px;margin:40px auto;text-align:center">
        <div class="card-title" style="margin-bottom:10px">No brands yet</div>
        <div style="font-size:13px;color:var(--ink3);line-height:1.6">
          Use the brand-creation wizard or POST /api/v1/god/brands to provision the first one.
        </div>
      </div>`;
  }
  return `
    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>Brand</th><th>Slug</th><th>Plan</th><th>AI credits</th><th>Status</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${STATE.brands.map(brandRow).join('')}
        </tbody>
      </table>
    </div>`;
}

function brandRow(b) {
  const status = b.suspended_at
    ? `<span class="badge badge-red">Suspended</span>`
    : `<span class="badge badge-green">Active</span>`;
  return `
    <tr>
      <td>
        <a class="link" href="javascript:void(0)" data-action="god.openBrand" data-id="${b.id}">
          ${escAttr(b.name)}
        </a>
      </td>
      <td><code>${escAttr(b.slug)}</code></td>
      <td>${escAttr(b.plan)}</td>
      <td>${fmtMicroUsd(b.ai_credits_micro)}</td>
      <td>${status}</td>
      <td>${fmtDate(b.created_at)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" data-action="god.enterBrand" data-id="${b.id}" ${STATE.enterPending ? 'disabled' : ''} title="View this brand's data as an agent">Enter</button>
        ${b.suspended_at
          ? `<button class="btn btn-sm" data-action="god.unsuspend" data-id="${b.id}" ${STATE.actionPending ? 'disabled' : ''}>Unsuspend</button>`
          : `<button class="btn btn-sm btn-danger" data-action="god.suspend" data-id="${b.id}" ${STATE.actionPending ? 'disabled' : ''}>Suspend</button>`}
      </td>
    </tr>`;
}

function renderDetail() {
  if (STATE.detailError) {
    return `
      <div style="margin-bottom:12px">
        <button class="btn btn-ghost btn-sm" data-action="god.backToList">← Back to brands</button>
      </div>
      ${errorBanner(STATE.detailError, 'god.refreshDetail')}`;
  }
  if (STATE.detailLoading || !STATE.detail) {
    return `<div class="card"><div style="padding:24px;color:var(--ink3)">Loading…</div></div>`;
  }
  const { brand, domains, counts } = STATE.detail;
  return `
    <div style="margin-bottom:12px">
      <button class="btn btn-ghost btn-sm" data-action="god.backToList">← Back to brands</button>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">${escAttr(brand.name)}</div>
      <div class="grid-2">
        <div><div class="label">Slug</div><div><code>${escAttr(brand.slug)}</code></div></div>
        <div><div class="label">Plan</div><div>${escAttr(brand.plan)}</div></div>
        <div><div class="label">Created</div><div>${fmtDate(brand.created_at)}</div></div>
        <div><div class="label">Status</div><div>
          ${brand.suspended_at
            ? `<span class="badge badge-red">Suspended ${fmtDate(brand.suspended_at)}</span>`
            : `<span class="badge badge-green">Active</span>`}
        </div></div>
        <div><div class="label">AI credits</div><div>${fmtMicroUsd(brand.ai_credits_micro)}</div></div>
        <div><div class="label">Auto-reply</div><div>${fmtAutoReply(brand)}</div></div>
        <div><div class="label">Display name</div><div>${escAttr(brand.support_email_display_name || '— (falls back to brand name)')}</div></div>
        <div><div class="label">Primary colour</div><div>
          ${brand.primary_color
            ? `<span style="display:inline-block;width:14px;height:14px;background:${escAttr(brand.primary_color)};vertical-align:middle;border-radius:3px;border:1px solid var(--rule)"></span>
               <code style="margin-left:6px">${escAttr(brand.primary_color)}</code>`
            : '— (uses Maestro default)'}
        </div></div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px">
        ${brand.suspended_at
          ? `<button class="btn" data-action="god.unsuspend" data-id="${brand.id}" ${STATE.actionPending ? 'disabled' : ''}>Unsuspend brand</button>`
          : `<button class="btn btn-danger" data-action="god.suspend" data-id="${brand.id}" ${STATE.actionPending ? 'disabled' : ''}>Suspend brand</button>`}
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Email domains (${domains.length})</div>
      ${domains.length === 0
        ? `<div style="color:var(--ink3);font-size:13px;margin-bottom:12px">No domains configured yet. Brand can't receive or send mail until at least one is added + verified.</div>`
        : `<table class="tbl" style="margin-bottom:12px">
            <thead><tr><th>Domain</th><th>Verified</th><th>Postmark ID</th><th>Added</th><th></th></tr></thead>
            <tbody>
              ${domains.map((d) => renderDomainRow(brand.id, d)).join('')}
            </tbody>
          </table>`}
      ${renderAddDomainForm(brand.id)}
      ${STATE.addDomainResult ? renderAddDomainResult(STATE.addDomainResult) : ''}
    </div>

    <div class="card">
      <div class="card-title">Activity</div>
      <div class="grid-2">
        <div><div class="label">Tickets</div><div style="font-size:22px;font-weight:600">${counts.tickets}</div></div>
        <div><div class="label">Members</div><div style="font-size:22px;font-weight:600">${counts.members}</div></div>
      </div>
    </div>`;
}

function errorBanner(err, retryAction) {
  return `
    <div class="card" style="border-left:3px solid var(--red);padding:16px">
      <div style="color:var(--red);font-weight:600;margin-bottom:6px">Error</div>
      <div style="font-size:13px;color:var(--ink2);margin-bottom:10px">${escAttr(err)}</div>
      <button class="btn btn-sm" data-action="${retryAction}">Retry</button>
    </div>`;
}

// ─── Domain row + inline forms ────────────────────────────────────────────

function renderDomainRow(brandId, d) {
  const act = STATE.domainAction[d.id] || {};
  const pending = act.pending ? 'disabled' : '';
  return `
    <tr>
      <td><code>${escAttr(d.domain)}</code></td>
      <td>${d.verified_at
        ? `<span class="badge badge-green">Verified ${fmtDate(d.verified_at)}</span>`
        : `<span class="badge badge-amber">Pending</span>`}</td>
      <td>${d.postmark_domain_id ? `<code>${escAttr(d.postmark_domain_id)}</code>` : '— (not provisioned)'}</td>
      <td>${fmtDate(d.created_at)}</td>
      <td style="text-align:right;white-space:nowrap">
        ${d.verified_at
          ? ''
          : `<button class="btn btn-sm" data-action="god.verifyDomain" data-brand="${escAttr(brandId)}" data-id="${escAttr(d.id)}" ${pending}>
              ${act.pending ? 'Verifying…' : 'Verify'}
            </button>`}
        <button class="btn btn-sm btn-danger" data-action="god.removeDomain" data-brand="${escAttr(brandId)}" data-id="${escAttr(d.id)}" data-domain="${escAttr(d.domain)}" ${pending}>Remove</button>
      </td>
    </tr>
    ${act.error ? `<tr><td colspan="5" style="color:var(--red);font-size:12px;padding-top:0">${escAttr(act.error)}</td></tr>` : ''}
    ${act.dns ? `<tr><td colspan="5" style="padding-top:0">${renderDnsTable(act.dns)}</td></tr>` : ''}`;
}

function renderAddDomainForm(brandId) {
  const disabled = STATE.addDomainPending ? 'disabled' : '';
  return `
    <div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:8px">
      <input class="form-input" placeholder="acme.com" value="${escAttr(STATE.addDomainInput)}" data-input-action="god.addDomainInput" style="flex:1" ${disabled}/>
      <button class="btn" data-action="god.addDomain" data-brand="${escAttr(brandId)}" ${disabled}>
        ${STATE.addDomainPending ? 'Adding…' : 'Add domain'}
      </button>
    </div>
    ${STATE.addDomainError
      ? `<div style="color:var(--red);font-size:12px;margin-bottom:8px">${escAttr(STATE.addDomainError)}</div>`
      : ''}`;
}

function renderAddDomainResult(result) {
  return `
    <div style="border-left:3px solid var(--green);padding:8px 12px;margin-top:10px">
      <div style="font-size:13px;color:var(--ink2);margin-bottom:6px">
        Added <code>${escAttr(result.domain.domain)}</code>. ${result.dns_setup ? 'DNS records below — share with the brand owner.' : 'No DNS records returned (Postmark not configured).'}
      </div>
      ${result.dns_setup ? renderDnsTable(result.dns_setup) : ''}
    </div>`;
}

function renderDnsTable(dns) {
  return `
    <table class="tbl" style="font-family:'DM Mono',monospace;font-size:11px;margin-top:6px">
      <thead><tr><th>Type</th><th>Host</th><th>Value</th><th>Priority</th></tr></thead>
      <tbody>
        ${dnsRow('DKIM',         dns.dkim)}
        ${dnsRow('Return-Path',  dns.return_path)}
        ${dnsRow('SPF',          dns.spf)}
        ${dnsRow('DMARC',        dns.dmarc)}
      </tbody>
    </table>`;
}

function dnsRow(label, rec) {
  const priColor = rec.priority === 'required' ? 'var(--red)' : 'var(--amber)';
  return `
    <tr>
      <td>${escAttr(rec.type)} <span style="color:var(--ink3);font-size:10px">(${escAttr(label)})</span></td>
      <td>${escAttr(rec.host)}</td>
      <td style="word-break:break-all">${escAttr(rec.value)}</td>
      <td><span style="color:${priColor}">${escAttr(rec.priority)}</span></td>
    </tr>`;
}

// ─── Data loaders ─────────────────────────────────────────────────────────

async function refreshList() {
  STATE.brandsLoading = true;
  STATE.brandsError = null;
  reRender();
  try {
    const res = await apiGet('/api/v1/god/brands');
    STATE.brands = res.brands || [];
  } catch (err) {
    STATE.brandsError = err.message || 'Failed to load brands';
  } finally {
    STATE.brandsLoading = false;
    reRender();
  }
}

async function refreshDetail(brandId) {
  STATE.detailLoading = true;
  STATE.detailError = null;
  reRender();
  try {
    STATE.detail = await apiGet(`/api/v1/god/brands/${brandId}`);
  } catch (err) {
    STATE.detailError = err.message || 'Failed to load brand';
  } finally {
    STATE.detailLoading = false;
    reRender();
  }
}

// Slug the user must type to confirm an in-progress suspend. Held module-local
// so the modal's input handler + confirm callback can both reach it.
let _suspendSlug = null;

// Suspending a live brand takes real players offline — too dangerous for a
// one-click button sitting next to "Enter". Gate it behind a type-the-slug
// modal: the Suspend button stays disabled until the typed text matches the
// brand slug exactly, so it can't be triggered by a reflexive click or stray
// Enter. Unsuspend is non-destructive (restores service) and stays one-click.
function confirmSuspend(brandId) {
  const brand = STATE.brands.find((b) => b.id === brandId)
    || (STATE.detail?.brand?.id === brandId ? STATE.detail.brand : null);
  if (!brand) return; // button only renders for brands we already hold

  _suspendSlug = (brand.slug || '').trim();
  const body = `
    <div style="font-size:13px;color:var(--ink2);line-height:1.6;margin-bottom:14px">
      Real players on <strong>${escAttr(brand.name)}</strong> lose access
      immediately — sign-in, tickets, and live updates all stop — until you
      unsuspend it. No data is deleted.
    </div>
    <div class="label" style="margin-bottom:6px">
      Type the slug <code>${escAttr(brand.slug)}</code> to confirm:
    </div>
    <input class="form-input" id="god-suspend-input"
           data-input-action="god.suspendInput"
           placeholder="${escAttr(brand.slug)}" autocomplete="off"
           autocapitalize="off" spellcheck="false" style="width:100%"/>`;

  showModal(`Suspend "${brand.name}"?`, body, () => {
    const el = document.getElementById('god-suspend-input');
    if (!el || el.value.trim() !== _suspendSlug) return; // guard; button is disabled anyway
    closeModal();
    setSuspended(brandId, true);
  }, 'Suspend brand');

  // showModal renders the confirm button enabled + btn-solid. Re-style it as a
  // danger action and disable it until the slug matches (see god.suspendInput).
  const btn = document.querySelector('#modal-container [data-action="modal.confirm"]');
  if (btn) {
    btn.disabled = true;
    btn.classList.remove('btn-solid');
    btn.classList.add('btn-danger');
  }
  document.getElementById('god-suspend-input')?.focus();
}

async function setSuspended(brandId, suspend) {
  STATE.actionPending = true;
  reRender();
  try {
    const res = await apiPatch(`/api/v1/god/brands/${brandId}`, {
      suspended_at: suspend ? 'now' : null,
    });
    // Update list cache.
    const idx = STATE.brands.findIndex((b) => b.id === brandId);
    if (idx >= 0) STATE.brands[idx] = { ...STATE.brands[idx], suspended_at: res.brand.suspended_at };
    // Update detail cache if viewing this brand.
    if (STATE.detail?.brand?.id === brandId) STATE.detail.brand = res.brand;
  } catch (err) {
    alert(`Failed: ${err.message || err}`);
  } finally {
    STATE.actionPending = false;
    reRender();
  }
}

// Step into a brand as if signing in as an agent — set the workspace_id
// header, load that workspace's data from the API, and navigate to the
// dashboard. The platform admin keeps the god nav (always shown for platform
// admins, via app.js login), so they can return any time. On refresh, a
// platform admin resumes into the God view by default — autoResumeAgent skips
// platform admins (app.js startup) — and re-enters the brand from there.
async function enterBrand(brandId) {
  if (STATE.enterPending) return;
  STATE.enterPending = true;
  reRender();
  try {
    setWorkspaceId(brandId);
    // Carry the Maestro brand context (X-Brand-Id) when the entered workspace
    // is a Maestro brand, so brand-scoped features (e.g. player lookup) work
    // the same as via the agent "Sign in with Maestro" flow. Non-Maestro
    // workspaces (e.g. the internal Respovia workspace) have no maestro_brand_id, so
    // this clears it.
    const entered = STATE.brands.find((b) => b.id === brandId)
      || (STATE.detail?.brand?.id === brandId ? STATE.detail.brand : null);
    setBrandId(entered?.maestro_brand_id || null);
    await loadWorkspaceData();
    if (typeof updateNavBadges === 'function') updateNavBadges();
    nav('dashboard', document.getElementById('nav-dashboard'));
  } catch (err) {
    // Clear the workspace selection so a refresh doesn't leave the user
    // stuck trying to resume into a half-loaded workspace.
    setWorkspaceId(null);
    setBrandId(null);
    alert(`Couldn't enter workspace: ${err?.message || err}`);
  } finally {
    STATE.enterPending = false;
    // Only re-render the god panel if we're still on it — if loadWorkspaceData
    // succeeded we've already navigated away.
    if (document.body.dataset.currentPage === 'god') reRender();
  }
}

// ─── Action handlers ──────────────────────────────────────────────────────

registerActions({
  'god.refresh':       () => refreshList(),
  'god.refreshDetail': () => STATE.selectedId && refreshDetail(STATE.selectedId),
  'god.openBrand':     (ds) => openBrand(ds.id),
  'god.backToList': () => {
    STATE.view = 'list';
    STATE.detail = null;
    STATE.selectedId = null;
    STATE.addDomainInput = '';
    STATE.addDomainError = null;
    STATE.addDomainResult = null;
    STATE.domainAction = {};
    reRender();
  },
  'god.suspend':   (ds) => confirmSuspend(ds.id),
  'god.unsuspend': (ds) => setSuspended(ds.id, false),
  'god.enterBrand': (ds) => enterBrand(ds.id),
  // New-brand wizard
  'god.newBrand': () => {
    resetNewBrandForm();
    STATE.view = 'new-brand';
    reRender();
  },
  'god.openCreatedBrand': (ds) => {
    resetNewBrandForm();
    // Refresh list so the new brand appears, then jump to detail.
    STATE.brands = [];
    openBrand(ds.id);
  },
  // Add-domain + verify + remove on the detail view
  'god.addDomain':    (ds) => addDomain(ds.brand),
  'god.verifyDomain': (ds) => verifyDomain(ds.brand, ds.id),
  'god.removeDomain': (ds) => removeDomain(ds.brand, ds.id, ds.domain),
});

registerInputActions({
  'god.addDomainInput': (_ds, el) => { STATE.addDomainInput = el.value; },
  // Enable the modal's Suspend button only when the typed slug matches exactly.
  'god.suspendInput': (_ds, el) => {
    const btn = document.querySelector('#modal-container [data-action="modal.confirm"]');
    if (btn) btn.disabled = el.value.trim() !== _suspendSlug;
  },
});

function openBrand(id) {
  STATE.selectedId = id;
  STATE.view = 'detail';
  STATE.detail = null;
  STATE.addDomainInput = '';
  STATE.addDomainError = null;
  STATE.addDomainResult = null;
  STATE.domainAction = {};
  refreshDetail(id);
}

// ─── Domain mutations ─────────────────────────────────────────────────────

async function addDomain(brandId) {
  const domain = (STATE.addDomainInput || '').trim().toLowerCase();
  if (!domain) {
    STATE.addDomainError = 'Enter a domain.';
    reRender();
    return;
  }
  if (!domain.includes('.')) {
    STATE.addDomainError = 'Domain must contain a dot.';
    reRender();
    return;
  }

  STATE.addDomainPending = true;
  STATE.addDomainError = null;
  reRender();
  try {
    const res = await apiPost(`/api/v1/god/brands/${brandId}/domains`, { domain });
    STATE.addDomainResult = res;
    STATE.addDomainInput = '';
    // Refresh detail to pick up the new domain in the table.
    await refreshDetail(brandId);
  } catch (err) {
    STATE.addDomainError = err?.message || 'Add domain failed';
  } finally {
    STATE.addDomainPending = false;
    reRender();
  }
}

async function verifyDomain(brandId, domainId) {
  STATE.domainAction[domainId] = { pending: true, error: null, dns: null };
  reRender();
  try {
    const res = await apiPost(`/api/v1/god/brands/${brandId}/domains/${domainId}/verify`);
    // Update the in-place row state so verified status flips immediately
    // if both DKIM + Return-Path resolved. The detail refresh below also
    // catches the verified_at stamp.
    STATE.domainAction[domainId] = {
      pending: false,
      error: res.fully_verified ? null : 'Still pending — DNS may not have propagated yet.',
      dns: res.dns_setup,
    };
    if (res.fully_verified) await refreshDetail(brandId);
  } catch (err) {
    STATE.domainAction[domainId] = { pending: false, error: err?.message || 'Verify failed', dns: null };
  } finally {
    reRender();
  }
}

async function removeDomain(brandId, domainId, domainStr) {
  if (!confirm(`Remove domain ${domainStr}? This deletes it from Postmark too.`)) return;
  STATE.domainAction[domainId] = { pending: true, error: null, dns: null };
  reRender();
  try {
    await apiDelete(`/api/v1/god/brands/${brandId}/domains/${domainId}`);
    delete STATE.domainAction[domainId];
    await refreshDetail(brandId);
  } catch (err) {
    STATE.domainAction[domainId] = { pending: false, error: err?.message || 'Remove failed', dns: null };
  } finally {
    reRender();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtMicroUsd(micro) {
  if (micro == null) return '—';
  const usd = micro / 1_000_000;
  return `$${usd.toFixed(2)}`;
}

function fmtAutoReply(b) {
  if (b.auto_reply_min_confidence == null) return 'Disabled';
  const cats = (b.auto_reply_categories || []).join(', ') || '— (no categories whitelisted)';
  return `≥${b.auto_reply_min_confidence}% confidence · ${cats}`;
}
