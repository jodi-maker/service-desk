// Browser regression check for the ticket composer. Start scripts/serve-spa.js,
// sign into a local demo persona and open TK-001, then run via Playwright:
//   import check from './scripts/ticket-layout-browser-check.mjs';
//   await page.evaluate(check);
// Upload/message responses are mocked; this never sends customer mail.
export default async function () {
  if (location.hostname !== 'localhost') throw new Error('Local fixture only');
  const { TICKETS } = await import('/js/core/data.js');
  const d = await import('/js/tickets/detail.js');
  const c = await import('/js/tickets/composer.js');
  const a = await import('/js/tickets/attachments.js');
  const tick = () => new Promise(resolve => setTimeout(resolve, 50));
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const t = TICKETS.find(t => t.id === 'TK-001');
  const originalFetch = window.fetch;
  const inputClick = HTMLInputElement.prototype.click;
  const payloads = [];
  t._uuid = '00000000-0000-4000-8000-000000000001'; t._detailLoaded = true;
  window.fetch = async (url, opts = {}) => {
    if (String(url).includes(t._uuid) && String(url).endsWith('/attachments')) return Response.json({ attachment: { id: 'layout-attachment', filename: 'layout-test.txt', size_bytes: 12, mime_type: 'text/plain' } });
    if (String(url).includes(t._uuid) && String(url).endsWith('/messages')) {
      const p = JSON.parse(opts.body); payloads.push(p);
      return Response.json({ message: { author_label: 'Jodi', role: p.role, body: p.body, body_html: p.body_html, attachments: [], created_at: new Date().toISOString() } });
    }
    return originalFetch(url, opts);
  };
  try {
    document.querySelector('[data-compose-launch][data-tab="reply"]').click();
    c.setText(t.id, 'Public reply fixture'); d.onComposeInput(t.id);
    HTMLInputElement.prototype.click = function () { if (this.type !== 'file') inputClick.call(this); };
    a.showAttachPanel(t.id);
    HTMLInputElement.prototype.click = inputClick;
    const input = document.querySelector('input[type="file"]');
    const dt = new DataTransfer(); dt.items.add(new File(['attachment'], 'layout-test.txt', { type: 'text/plain' }));
    input.files = dt.files; input.dispatchEvent(new Event('change'));
    await tick();
    document.querySelector('[data-action="tl.minimise"]').click();
    check(a.pendingAttachmentIds(t.id).length === 1, 'Minimising lost upload');
    document.querySelector('[data-compose-launch][data-tab="note"]').click();
    const note = document.querySelector('textarea.compose-area'); note.value = 'Private note fixture'; note.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="td.send"]').click(); await tick();
    check(payloads[0].role === 'note' && !payloads[0].attachment_ids && !payloads[0].body_html, 'Note leaked public content');
    check(a.pendingAttachmentIds(t.id).length === 1, 'Note send cleared reply attachment');
    document.querySelector('.composer-tabs [data-tab="reply"]').click(); await tick();
    check(c.getPlainText(t.id) === 'Public reply fixture', 'Reply draft lost across note send');
    document.querySelector('[data-action="td.send"]').click(); await tick();
    check(payloads[1].role === 'agent' && payloads[1].attachment_ids[0] === 'layout-attachment', 'Reply attachment not sent');
    check(a.pendingAttachmentIds(t.id).length === 0, 'Sent attachment not cleared');
    check(!localStorage.getItem('draft:' + t.id + ':reply'), 'Sent draft not cleared');
    return { passed: true, assertions: 7, payloads };
  } finally { window.fetch = originalFetch; HTMLInputElement.prototype.click = inputClick; delete t._uuid; }
}

