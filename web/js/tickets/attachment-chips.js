// ─── Attachment chips under a message ────────────────────────────────────────
// One row of "open in a new tab" links per message. The href is the presigned
// URL minted by the API (api/src/lib/message-attachments.ts) — the SPA's Bearer
// token can't ride on a plain <a>/<img>, so the signed URL IS the credential.
// It expires; re-opening the ticket mints a fresh one.
//
// Whether a file opens in the browser or downloads is decided server-side by
// the object's stored Content-Disposition (images inline, everything else
// attachment), not here — a `download` attribute wouldn't survive the
// cross-origin hop anyway.
//
// External reaches (interim, via window): escAttr, escHtml — still in app.js.

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const PAPERCLIP = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M9.5 4.5 5 9a1.5 1.5 0 0 0 2.1 2.1l4.6-4.6a3 3 0 0 0-4.2-4.2L2.8 6.9a4.5 4.5 0 0 0 6.4 6.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Chips for one message's attachments. Inline images already appear inside the
 * body, so they are listed after the rest and labelled — an agent still needs a
 * way to open or save them.
 * @param {Array} attachments PublicAttachment[] from the API
 */
export function renderAttachmentChips(attachments) {
  const list = attachments || [];
  if (!list.length) return '';
  const ordered = [...list].sort((a, b) => Number(a.is_inline) - Number(b.is_inline));
  const chips = ordered.map((a) => {
    const size = fmtBytes(a.size_bytes);
    const label = `${window.escHtml(a.filename)}${size ? ` <span class="att-size">${size}</span>` : ''}`;
    const inline = a.is_inline ? ' · shown above' : '';
    if (!a.url) {
      return `<span class="att-chip att-chip-dead" title="File storage is not configured">${PAPERCLIP}${label}</span>`;
    }
    return `<a class="att-chip" href="${window.escAttr(a.url)}" target="_blank" rel="noopener noreferrer"
      title="${window.escAttr(a.filename + (a.mime_type ? ` (${a.mime_type})` : '') + inline)}">${PAPERCLIP}${label}</a>`;
  }).join('');
  return `<div class="att-row">${chips}</div>`;
}
