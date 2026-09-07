// ─── Compose box adapter ─────────────────────────────────────────────────────
// One interface over the two editors the composer uses:
//
//   • Reply tab        → Quill (rich text: bold/italic/lists/links/images)
//   • Internal note    → the original <textarea> (mentions rely on
//                        selectionStart, and a note is never emailed)
//
// Everything that used to poke `document.getElementById('compose-'+id).value`
// goes through here — detail.js, ai/reply.js, macros.js, mentions.js — so the
// editor can change without those modules caring.
//
// Quill is vendored (web/js/vendor/quill.js, UMD) and loaded LAZILY on first
// use: the CI smokes render every ticket against a stub DOM, so nothing here
// may touch the real editor before mount() has checked the DOM is real. If the
// load fails for any reason the composer silently falls back to a plain
// textarea — an agent must never be unable to reply because an editor did not
// download.

const QUILL_JS = new URL('../vendor/quill.js', import.meta.url).href;
const QUILL_CSS = 'styles/quill.snow.css';

// ticketId → Quill instance.
const EDITORS = new Map();
let quillLoad = null;

// The formats an agent can produce. Deliberately narrow: it maps onto what the
// server-side email sanitiser keeps, and onto what mail clients render.
const FORMATS = ['bold', 'italic', 'underline', 'strike', 'list', 'link', 'image', 'blockquote', 'code-block'];
const TOOLBAR = [
  ['bold', 'italic', 'underline'],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['link', 'image', 'blockquote'],
  ['clean'],
];

function el(id) { return document.getElementById('compose-' + id); }
function isRichHost(node) { return !!node && node.dataset && node.dataset.rich === '1'; }

// Is this a real browser DOM (not the smoke shim, not a torn-down node)?
function domIsReal(node) {
  return !!node && typeof node.appendChild === 'function' && typeof node.querySelector === 'function'
    && typeof document.createElement === 'function' && !!document.head;
}

async function loadQuill() {
  if (window.Quill) return window.Quill;
  if (!quillLoad) {
    quillLoad = (async () => {
      // The stylesheet is only needed once the editor actually mounts.
      if (!document.querySelector('link[data-quill]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = QUILL_CSS;
        link.setAttribute('data-quill', '1');
        document.head.appendChild(link);
      }
      // The UMD bundle assigns window.Quill when neither CommonJS nor AMD is
      // present, which is the case inside an ES module.
      await import(/* @vite-ignore */ QUILL_JS);
      return window.Quill;
    })().catch((err) => {
      console.warn('[composer] rich editor unavailable, falling back to plain text:', err);
      quillLoad = null;
      return null;
    });
  }
  return quillLoad;
}

/**
 * Attach the editor for a ticket's compose box. Safe to call on every render:
 * an existing instance for the same host element is reused.
 * @param {string} id ticket id
 * @param {{ initialHtml?: string, onChange?: () => void }} opts
 */
export async function mountComposer(id, opts = {}) {
  const host = el(id);
  if (!isRichHost(host) || !domIsReal(host)) return null;   // note tab, or the smoke's stub DOM
  if (EDITORS.has(id) && host.querySelector('.ql-editor')) return EDITORS.get(id);

  const Quill = await loadQuill();
  if (!Quill) { EDITORS.delete(id); return null; }
  // The host may have been re-rendered while Quill was loading.
  const current = el(id);
  if (!isRichHost(current)) return null;

  const quill = new Quill(current, {
    theme: 'snow',
    formats: FORMATS,
    placeholder: opts.placeholder || 'Write a reply…',
    modules: { toolbar: TOOLBAR },
  });
  if (opts.initialHtml) {
    quill.clipboard.dangerouslyPasteHTML(0, opts.initialHtml, 'silent');
  }
  if (opts.onChange) quill.on('text-change', () => opts.onChange());
  EDITORS.set(id, quill);
  return quill;
}

export function disposeComposer(id) { EDITORS.delete(id); }

function quillFor(id) {
  const q = EDITORS.get(id);
  // A stale instance from a previous render of the same ticket.
  if (q && !isRichHost(el(id))) { EDITORS.delete(id); return null; }
  return q || null;
}

/** True when this ticket's compose box is the rich editor. */
export function isRich(id) { return !!quillFor(id); }

/** The HTML an agent authored, or null for a plain-text box / empty editor. */
export function getHtml(id) {
  const q = quillFor(id);
  if (!q) return null;
  if (isEmpty(id)) return null;
  // getSemanticHTML emits plain tags (<strong>, <em>, <ul>) rather than Quill's
  // internal classes — that is what goes into the email. It also encodes EVERY
  // space as &nbsp;, which stops mail clients wrapping long lines, so those are
  // turned back into ordinary spaces.
  const html = typeof q.getSemanticHTML === 'function' ? q.getSemanticHTML() : q.root.innerHTML;
  return html.replace(/&nbsp;/g, ' ');
}

/** What the agent typed, as plain text — for drafts, char count and the API. */
export function getPlainText(id) {
  const q = quillFor(id);
  if (q) return q.getText().replace(/\n+$/, '');
  const node = el(id);
  return node ? (node.value || '') : '';
}

export function isEmpty(id) {
  const q = quillFor(id);
  if (q) {
    const hasEmbed = /<img|<video/i.test(q.root ? q.root.innerHTML : '');
    return !q.getText().trim() && !hasEmbed;
  }
  return !getPlainText(id).trim();
}

/** Replace the whole content with plain text (AI drafts, macros, restores). */
export function setText(id, text) {
  const q = quillFor(id);
  if (q) { q.setText(text ?? ''); focusEnd(id); return; }
  const node = el(id);
  if (node) node.value = text ?? '';
}

/** Append text on a new paragraph (macros appending a canned response). */
export function appendText(id, text) {
  const q = quillFor(id);
  if (q) {
    const at = q.getLength() ? q.getLength() - 1 : 0;
    q.insertText(at, (at ? '\n\n' : '') + (text ?? ''), 'user');
    focusEnd(id);
    return;
  }
  const node = el(id);
  if (!node) return;
  node.value = node.value ? `${node.value}\n\n${text}` : text;
  focusEnd(id);
}

/** Insert at the caret (the {name}/{ticket} insert-variable buttons). */
export function insertAtCursor(id, text) {
  const q = quillFor(id);
  if (q) {
    const range = q.getSelection(true);
    const at = range ? range.index : q.getLength() - 1;
    if (range && range.length) q.deleteText(at, range.length, 'user');
    q.insertText(at, text ?? '', 'user');
    q.setSelection(at + (text ? text.length : 0), 0);
    return;
  }
  const node = el(id);
  if (!node) return;
  node.focus();
  const start = node.selectionStart || 0;
  const end = node.selectionEnd || 0;
  node.value = node.value.slice(0, start) + text + node.value.slice(end);
  const pos = start + text.length;
  node.setSelectionRange(pos, pos);
}

export function clear(id) {
  const q = quillFor(id);
  if (q) { q.setText(''); return; }
  const node = el(id);
  if (node) node.value = '';
}

export function focusEnd(id) {
  const q = quillFor(id);
  if (q) { q.setSelection(Math.max(q.getLength() - 1, 0), 0); return; }
  const node = el(id);
  if (!node || typeof node.focus !== 'function') return;
  node.focus();
  if (typeof node.setSelectionRange === 'function') {
    const pos = (node.value || '').length;
    node.setSelectionRange(pos, pos);
  }
}
