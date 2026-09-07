// View-only controls. Minimising never removes the editor or pending uploads.
import { registerActions } from '../core/event-delegation.js';

function page(id) { return document.getElementById('ticket-page-' + id); }

export function captureTicketLayout(id) {
  const root = page(id);
  return {
    mode: root?.dataset?.composeMode || 'read',
    details: root?.dataset?.details || 'auto',
    languageOpen: !!root?.querySelector?.('.ticket-language[open]'),
  };
}

export function setComposerMode(id, mode, focus = false) {
  const root = page(id);
  if (!root?.querySelector) return;
  const thread = root.querySelector('.thread');
  const top = thread?.scrollTop || 0;
  root.dataset.composeMode = mode;
  root.querySelectorAll('[data-compose-launch]').forEach(button => {
    button.setAttribute('aria-expanded', String(mode !== 'read'));
  });
  const expand = root.querySelector('[data-action="tl.expand"]');
  if (expand) {
    expand.textContent = mode === 'expanded' ? 'Restore' : 'Expand';
    expand.setAttribute('aria-expanded', String(mode === 'expanded'));
  }
  if (thread) thread.scrollTop = top;
  if (focus) {
    const target = mode === 'read'
      ? root.querySelector('[data-compose-launch]')
      : root.querySelector('.ql-editor, textarea.compose-area');
    if (target) target.focus({ preventScroll: true });
    else root.dataset.focusComposer = 'true';
  }
}

function toggleDetails(id, close = false) {
  const root = page(id);
  if (!root?.querySelector) return;
  const sidebar = root.querySelector('.ticket-sidebar');
  const button = root.querySelector('[data-action="tl.details"]');
  if (!sidebar || !button) return;
  const visible = getComputedStyle(sidebar).display !== 'none';
  root.dataset.details = close || visible ? 'hide' : 'show';
  button.setAttribute('aria-expanded', String(root.dataset.details === 'show'));
  syncTicketLayout(id);
  if (root.dataset.details === 'show') sidebar.querySelector('button')?.focus();
  else button.focus();
}

export function syncTicketLayout(id) {
  const root = page(id);
  if (!root?.querySelector) return; // render-smoke DOM
  const button = root.querySelector('[data-action="tl.details"]');
  const sidebar = root.querySelector('.ticket-sidebar');
  if (button && sidebar) {
    const visible = getComputedStyle(sidebar).display !== 'none';
    button.setAttribute('aria-expanded', String(visible));
    const main = root.querySelector('.ticket-main');
    if (main) {
      main.inert = visible && window.matchMedia('(max-width:1100px)').matches;
      if (main.inert && main.contains(document.activeElement)) sidebar.querySelector('button')?.focus();
    }
  }
  if (root.dataset.focusComposer === 'true' && root.dataset.composeMode !== 'read') {
    const editor = root.querySelector('.ql-editor, textarea.compose-area');
    if (editor) {
      delete root.dataset.focusComposer;
      editor.focus({ preventScroll: true });
    }
  }
}

registerActions({
  'tl.minimise': ds => setComposerMode(ds.ticketId, 'read', true),
  'tl.expand': ds => setComposerMode(ds.ticketId, page(ds.ticketId)?.dataset.composeMode === 'expanded' ? 'edit' : 'expanded', true),
  'tl.details': ds => toggleDetails(ds.ticketId),
  'tl.closeDetails': ds => toggleDetails(ds.ticketId, true),
});

// Macros and AI may populate an editor while the reader has it minimised.
document.addEventListener('ticket:reveal-composer', event => {
  const root = page(event.detail.id);
  if (root?.dataset.composeMode === 'read') setComposerMode(event.detail.id, 'edit');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = event.target.closest?.('.ticket-popover[open]');
  if (menu) {
    menu.open = false;
    menu.querySelector('summary')?.focus();
    event.preventDefault();
  } else if (event.target.closest?.('.ticket-sidebar')) {
    const root = event.target.closest('.ticket-page');
    if (root) toggleDetails(root.dataset.ticketId, true);
    event.preventDefault();
  }
});
document.addEventListener('click', event => {
  document.querySelectorAll?.('.ticket-popover[open]').forEach(menu => {
    if (!menu.contains(event.target) || event.target.closest('[data-action]')) menu.open = false;
  });
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const root = document.querySelector('.ticket-page');
    if (root) syncTicketLayout(root.dataset.ticketId);
  }, 100);
});
