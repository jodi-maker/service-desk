// ─── Ticket attachments ──────────────────────────────────────────────────────
// Real uploads. "Attach" opens a file picker, each file is uploaded straight
// away to POST /tickets/:uuid/attachments and held as a PENDING attachment
// until the reply is sent — at which point its id rides along in the request
// and the server binds it to the message. Anything an agent uploads and never
// sends is swept server-side after a day.
//
// Pending state is per ticket and lives only in this module: a draft's files
// are deliberately not restored across a reload (the ids would be swept), so
// the chips reflect exactly what the next send will carry.
//
// Demo personas (no `_uuid`) have no backend; the picker reports that instead
// of pretending, which is what the old mock list did.
//
// External reaches (interim, via window): escAttr, escHtml — still in app.js.

import { TICKETS } from '../core/data.js';
import { registerActions } from '../core/event-delegation.js';
import { apiDelete, apiUpload } from '../core/api-client.js';
import { showToast } from '../core/toast.js';
import { fmtBytes } from './attachment-chips.js';

// ticketId → [{ id, filename, size_bytes, mime_type, is_inline }]
const PENDING = new Map();

export function pendingAttachments(ticketId) { return PENDING.get(ticketId) || []; }
export function pendingAttachmentIds(ticketId) { return pendingAttachments(ticketId).map((a) => a.id); }
export function clearPendingAttachments(ticketId) { PENDING.delete(ticketId); renderPendingAttachments(ticketId); }

/** Repaint the chip row above the composer foot. */
export function renderPendingAttachments(ticketId) {
  const host = document.getElementById('pending-att-' + ticketId);
  if (!host || typeof host.innerHTML !== 'string') return;
  const list = pendingAttachments(ticketId);
  const hint = document.querySelector?.(`#ticket-page-${ticketId} .composer-launch-hint`);
  if (hint) hint.textContent = list.length ? `${list.length} ${list.length === 1 ? 'attachment' : 'attachments'} ready` : 'Write a reply…';
  if (!list.length) { host.innerHTML = ''; return; }
  host.innerHTML = list.map((a) => `
    <span class="att-chip att-chip-pending">
      ${window.escHtml(a.filename)}<span class="att-size">${fmtBytes(a.size_bytes)}</span>
      <button class="att-chip-x" title="Remove" data-action="att.remove" data-id="${window.escAttr(ticketId)}" data-att-id="${window.escAttr(a.id)}">×</button>
    </span>`).join('');
}

function ticketUuid(ticketId) {
  const t = TICKETS.find((x) => x.id === ticketId);
  return t && t._uuid ? t._uuid : null;
}

async function uploadFiles(ticketId, files) {
  const uuid = ticketUuid(ticketId);
  if (!uuid) { showToast('Attachments need a real ticket — demo tickets are local only.', 'warn', 5000); return; }
  const list = PENDING.get(ticketId) || [];
  PENDING.set(ticketId, list);
  for (const file of files) {
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const res = await apiUpload(`/api/v1/tickets/${uuid}/attachments`, form);
      list.push(res.attachment);
      renderPendingAttachments(ticketId);
    } catch (err) {
      showToast(`Couldn't attach ${file.name}: ${err?.message || err}`, 'error', 6000);
    }
  }
}

/** Open the OS file picker and upload whatever is chosen. */
export function showAttachPanel(ticketId) {
  if (typeof document.createElement !== 'function') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.remove();
    if (files.length) await uploadFiles(ticketId, files);
  });
  document.body.appendChild(input);
  input.click();
}

async function removePending(ticketId, attId) {
  const list = PENDING.get(ticketId) || [];
  const idx = list.findIndex((a) => a.id === attId);
  if (idx < 0) return;
  const [removed] = list.splice(idx, 1);
  renderPendingAttachments(ticketId);
  const uuid = ticketUuid(ticketId);
  if (!uuid) return;
  // Best-effort: if the delete fails the file is simply left for the
  // server-side sweep — it was never bound to a message.
  try { await apiDelete(`/api/v1/tickets/${uuid}/attachments/${removed.id}`); }
  catch (err) { console.warn('[attachments] remove failed:', err?.message || err); }
}

registerActions({
  'att.remove': (ds) => removePending(ds.id, ds.attId),
});
