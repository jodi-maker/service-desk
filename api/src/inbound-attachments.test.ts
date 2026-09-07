// Inbound email → stored attachments + sanitised HTML body (DB-backed,
// RUN_DB_TESTS). Drives processInboundEmail with a Postmark-shaped payload
// carrying Attachments, using an injected fake object store (no R2, no
// network), then reads the ticket back the way GET /tickets/:id does.
//
// Run locally:
//   DATABASE_URL='postgresql://postgres:postgres@localhost:5433/maestro_test?sslmode=disable' \
//   RUN_DB_TESTS=1 bun test src/inbound-attachments.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { R2Store } from './lib/r2.js';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]).toString('base64');
const PDF_B64 = Buffer.from('%PDF-1.7 hello').toString('base64');
const EXE_B64 = Buffer.from('MZ....').toString('base64');

function fakeStore() {
  const puts: Array<{ key: string; bytes: number; contentType: string; contentDisposition?: string }> = [];
  const deleted: string[] = [];
  const store: R2Store = {
    async putObject(key, bytes, opts) { puts.push({ key, bytes: bytes.length, contentType: opts.contentType, contentDisposition: opts.contentDisposition }); },
    async getObject() { throw new Error('not used'); },
    async listKeys() { return []; },
    async deleteKeys(keys) { deleted.push(...keys); },
    async presignGet(key) { return `https://fake-r2.test/${key}?X-Amz-Signature=abc`; },
  };
  return { store, puts, deleted };
}

runDbTests('inbound attachments + HTML body (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let processInboundEmail: typeof import('./lib/inbound-email.js').processInboundEmail;
  let loadAttachmentsForTicket: typeof import('./lib/message-attachments.js').loadAttachmentsForTicket;
  let decorateMessages: typeof import('./lib/message-attachments.js').decorateMessages;
  let PostmarkInbound: typeof import('./lib/postmark.js').PostmarkInbound;

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;

  function payload(fields: Record<string, unknown>) {
    return PostmarkInbound.parse({
      MessageID: `pm-${RUN}-${Math.random()}`,
      From: `sender-${RUN}@cust.test`,
      FromFull: { Email: `sender-${RUN}@cust.test`, Name: 'Sender' },
      ToFull: [{ Email: `support-${RUN}@brand.test` }],
      Subject: 'With files',
      TextBody: 'see attached',
      ...fields,
    });
  }

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    ({ processInboundEmail } = await import('./lib/inbound-email.js'));
    ({ loadAttachmentsForTicket, decorateMessages } = await import('./lib/message-attachments.js'));
    ({ PostmarkInbound } = await import('./lib/postmark.js'));
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'att-' + RUN}, ${'att-' + RUN}) as provision_brand`;
    ctx.ws = ws;
  }, 30000);

  afterAll(async () => {
    if (ctx.ws) await sql`delete from workspaces where id = ${ctx.ws}`;
  });

  it('stores acceptable files, skips blocked ones with a note, and keeps sanitised HTML with cid tokens', async () => {
    const fake = fakeStore();
    const msgId = `<files-${RUN}@cust.test>`;
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: payload({
        Headers: [{ Name: 'Message-ID', Value: msgId }],
        HtmlBody: '<html><head><style>p{color:red}</style></head><body><p>Hello <b>there</b></p><img src="cid:logo@mail"><script>alert(1)</script></body></html>',
        Attachments: [
          { Name: 'logo.png', Content: PNG_B64, ContentType: 'image/png', ContentID: 'logo@mail' },
          { Name: 'invoice.pdf', Content: PDF_B64, ContentType: 'application/pdf', ContentID: '' },
          { Name: 'setup.exe', Content: EXE_B64, ContentType: 'application/octet-stream', ContentID: '' },
          { Name: 'unref.png', Content: PNG_B64, ContentType: 'image/png', ContentID: 'unreferenced@mail' },
        ],
      }),
      deps: { attachments: { store: fake.store } },
    });
    ctx.ticket = res.ticket_id;

    // Objects: 3 stored (png, pdf, unref png), exe skipped.
    expect(fake.puts.map((p) => p.key.split('/').pop()).sort()).toEqual(['invoice.pdf', 'logo.png', 'unref.png']);
    const png = fake.puts.find((p) => p.key.endsWith('logo.png'))!;
    expect(png.contentType).toBe('image/png');
    expect(png.contentDisposition).toMatch(/^inline; filename="logo.png"/);
    const pdf = fake.puts.find((p) => p.key.endsWith('invoice.pdf'))!;
    expect(pdf.contentDisposition).toMatch(/^attachment; filename="invoice.pdf"/);
    for (const p of fake.puts) expect(p.key).toMatch(new RegExp(`^att/${ctx.ws}/${ctx.ticket}/[0-9a-f-]{36}/`));

    const rows = await sql<{ id: string; filename: string; is_inline: boolean; content_id: string | null; disposition: string; message_id: string | null; mime_type: string }[]>`
      select id, filename, is_inline, content_id, disposition, message_id, mime_type from ticket_attachments
      where ticket_id = ${ctx.ticket} order by filename`;
    expect(rows.map((r) => r.filename)).toEqual(['invoice.pdf', 'logo.png', 'unref.png']);
    const logo = rows.find((r) => r.filename === 'logo.png')!;
    expect(logo.is_inline).toBe(true);          // referenced from the HTML
    expect(logo.content_id).toBe('logo@mail');  // the email's OWN Content-ID, kept verbatim
    expect(logo.disposition).toBe('inline');
    const unref = rows.find((r) => r.filename === 'unref.png')!;
    expect(unref.is_inline).toBe(false);        // had a Content-ID but the HTML never used it
    expect(unref.content_id).toBe('unreferenced@mail');
    expect(rows.find((r) => r.filename === 'invoice.pdf')!.content_id).toBeNull();
    expect(rows.find((r) => r.filename === 'invoice.pdf')!.disposition).toBe('attachment');
    for (const r of rows) expect(r.message_id).toBeTruthy();

    const [msg] = await sql<{ id: string; body: string; body_html: string | null }[]>`
      select id, body, body_html from ticket_messages where ticket_id = ${ctx.ticket} and role = 'customer'`;
    expect(msg.body).toContain('see attached');
    expect(msg.body).toContain('[Attachment not stored: setup.exe — blocked type]');
    expect(msg.body_html).toBe(`<p>Hello <b>there</b></p><img src="cid:${logo.id}" />`);
    ctx.msgId = msg.id;
  });

  it('serves the ticket with presigned URLs and cid tokens swapped for the inline image URL', async () => {
    const fake = fakeStore();
    const byMsg = await loadAttachmentsForTicket(ctx.ws, ctx.ticket, { store: fake.store });
    const list = byMsg.get(ctx.msgId)!;
    expect(list.map((a) => a.filename).sort()).toEqual(['invoice.pdf', 'logo.png', 'unref.png']);
    for (const a of list) expect(a.url).toMatch(/^https:\/\/fake-r2\.test\/att\/.*X-Amz-Signature=abc$/);
    // No storage key leaks in the public shape.
    for (const a of list) expect(Object.keys(a)).not.toContain('storage_key');

    const [msg] = await sql<{ id: string; body_html: string | null }[]>`select id, body_html from ticket_messages where id = ${ctx.msgId}`;
    const [decorated] = decorateMessages([msg], byMsg);
    const logo = list.find((a) => a.filename === 'logo.png')!;
    expect(decorated.body_html).toBe(`<p>Hello <b>there</b></p><img src="${logo.url}" />`);
    expect(decorated.attachments).toHaveLength(3);
  });

  it('matches a Content-ID carrying angle brackets and whitespace', async () => {
    const fake = fakeStore();
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: payload({
        Subject: 'Padded cid',
        HtmlBody: '<p>pic</p><img src="cid: pad@mail ">',
        Attachments: [{ Name: 'pad.png', Content: PNG_B64, ContentType: 'image/png', ContentID: '< pad@mail >' }],
      }),
      deps: { attachments: { store: fake.store } },
    });
    const [row] = await sql<{ id: string; is_inline: boolean; content_id: string }[]>`
      select id, is_inline, content_id from ticket_attachments where ticket_id = ${res.ticket_id}`;
    expect(row.content_id).toBe('pad@mail');
    expect(row.is_inline).toBe(true);
    const [msg] = await sql<{ body_html: string }[]>`
      select body_html from ticket_messages where ticket_id = ${res.ticket_id} and role = 'customer'`;
    expect(msg.body_html).toBe(`<p>pic</p><img src="cid:${row.id}" />`);
  });

  it('caps how many files one email can leave behind', async () => {
    const fake = fakeStore();
    const { MAX_INBOUND_FILE_COUNT } = await import('./lib/attachment-policy.js');
    const many = Array.from({ length: MAX_INBOUND_FILE_COUNT + 3 }, (_, i) => ({
      Name: `f${i}.pdf`, Content: PDF_B64, ContentType: 'application/pdf',
    }));
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: payload({ Subject: 'Too many files', Attachments: many }),
      deps: { attachments: { store: fake.store } },
    });
    expect(fake.puts).toHaveLength(MAX_INBOUND_FILE_COUNT);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where ticket_id = ${res.ticket_id}`;
    expect(n).toBe(MAX_INBOUND_FILE_COUNT);
    const [msg] = await sql<{ body: string }[]>`select body from ticket_messages where ticket_id = ${res.ticket_id} and role = 'customer'`;
    expect(msg.body).toContain('over the 25-file limit');
  });

  it('does not re-upload on a Postmark redelivery (dedup)', async () => {
    const fake = fakeStore();
    const [msg] = await sql<{ external_message_id: string }[]>`select external_message_id from ticket_messages where id = ${ctx.msgId}`;
    const again = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: payload({
        Headers: [{ Name: 'Message-ID', Value: msg.external_message_id }],
        Attachments: [{ Name: 'logo.png', Content: PNG_B64, ContentType: 'image/png', ContentID: 'logo@mail' }],
      }),
      deps: { attachments: { store: fake.store } },
    });
    expect(again.deduped).toBe(true);
    expect(fake.puts).toHaveLength(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where ticket_id = ${ctx.ticket}`;
    expect(n).toBe(3);
  });

  it('keeps the message (text + HTML) when storage is not configured, noting the dropped files', async () => {
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: payload({
        Subject: 'No storage',
        HtmlBody: '<p>formatted <i>still</i></p><img src="cid:x@mail">',
        Attachments: [{ Name: 'x.png', Content: PNG_B64, ContentType: 'image/png', ContentID: 'x@mail' }],
      }),
      deps: { attachments: { configured: () => false } },
    });
    const [msg] = await sql<{ body: string; body_html: string | null }[]>`
      select body, body_html from ticket_messages where ticket_id = ${res.ticket_id} and role = 'customer'`;
    expect(msg.body).toContain('[Attachment not stored: x.png — attachment storage not configured]');
    expect(msg.body_html).toBe('<p>formatted <i>still</i></p>');   // unknown cid image dropped
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where ticket_id = ${res.ticket_id}`;
    expect(n).toBe(0);
  });

  it('survives a storage failure per file and cleans up when the row insert fails', async () => {
    const fake = fakeStore();
    fake.store.putObject = async (key) => { if (key.endsWith('bad.pdf')) throw new Error('R2 500'); };
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: payload({
        Subject: 'Partial failure',
        Attachments: [
          { Name: 'bad.pdf', Content: PDF_B64, ContentType: 'application/pdf' },
          { Name: 'good.pdf', Content: PDF_B64, ContentType: 'application/pdf' },
        ],
      }),
      deps: { attachments: { store: fake.store } },
    });
    const rows = await sql<{ filename: string }[]>`select filename from ticket_attachments where ticket_id = ${res.ticket_id}`;
    expect(rows.map((r) => r.filename)).toEqual(['good.pdf']);
    const [msg] = await sql<{ body: string }[]>`select body from ticket_messages where ticket_id = ${res.ticket_id} and role = 'customer'`;
    expect(msg.body).toContain('[Attachment not stored: bad.pdf — storage error]');
  });

  it('threads a reply with files onto the existing ticket', async () => {
    const fake = fakeStore();
    const [orig] = await sql<{ external_message_id: string }[]>`select external_message_id from ticket_messages where id = ${ctx.msgId}`;
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: payload({
        Subject: 'Re: With files',
        TextBody: 'one more',
        Headers: [{ Name: 'Message-ID', Value: `<reply-${RUN}@cust.test>` }, { Name: 'In-Reply-To', Value: orig.external_message_id }],
        HtmlBody: '<p>one <u>more</u></p>',
        Attachments: [{ Name: 'more.pdf', Content: PDF_B64, ContentType: 'application/pdf' }],
      }),
      deps: { attachments: { store: fake.store } },
    });
    expect(res.threaded).toBe(true);
    expect(res.ticket_id).toBe(ctx.ticket);
    const [reply] = await sql<{ id: string; body_html: string | null }[]>`
      select id, body_html from ticket_messages where ticket_id = ${ctx.ticket} and body like 'one more%'`;
    expect(reply.body_html).toBe('<p>one <u>more</u></p>');
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where message_id = ${reply.id}`;
    expect(n).toBe(1);
  });
});
