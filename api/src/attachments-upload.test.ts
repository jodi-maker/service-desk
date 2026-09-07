// Agent attachment uploads: storing, claiming onto a message, deleting an
// unsent upload, and the unclaimed sweep (DB-backed, RUN_DB_TESTS). Uses an
// injected fake object store — no R2, no network.
//
// Run locally:
//   DATABASE_URL='postgresql://postgres:postgres@localhost:5433/maestro_test?sslmode=disable' \
//   RUN_DB_TESTS=1 bun test src/attachments-upload.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { R2Store } from './lib/r2.js';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PDF = new Uint8Array([...'%PDF-1.7 hello'].map((c) => c.charCodeAt(0)));
const HTML = new Uint8Array([...'<!doctype html><script>alert(1)</script>'].map((c) => c.charCodeAt(0)));

// bun's expect(...).rejects HANGS on a promise backed by a postgres.js query
// (learned the hard way in the customer-contacts work), so rejections are
// asserted with try/catch throughout this file.
async function expectRejection(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  let err: unknown;
  try { await fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(match);
}
function fakeStore() {
  const puts: Array<{ key: string; contentType: string; contentDisposition?: string }> = [];
  const deleted: string[] = [];
  const store: R2Store = {
    async putObject(key, _bytes, opts) { puts.push({ key, contentType: opts.contentType, contentDisposition: opts.contentDisposition }); },
    async getObject() { return { bytes: PDF, contentType: 'application/pdf' }; },
    async listKeys() { return []; },
    async deleteKeys(keys) { deleted.push(...keys); },
    async presignGet(key) { return `https://fake-r2.test/${key}?sig=1`; },
  };
  return { store, puts, deleted };
}

runDbTests('agent attachment uploads (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let lib: typeof import('./lib/message-attachments.js');
  const RUN = Date.now();
  const ctx = {} as Record<string, string>;

  async function seedTicket(display: string): Promise<string> {
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name) values (${ctx.ws}, ${'C-' + display}, 'C') returning id`;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ctx.ws}, ${display}, 'S', ${cust.id}, 'open', 'normal') returning id`;
    return t.id;
  }
  async function seedMessage(ticketId: string): Promise<string> {
    const [m] = await sql<{ id: string }[]>`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
      values (${ctx.ws}, ${ticketId}, 'agent', 'A', 'reply') returning id`;
    return m.id;
  }
  const upload = (ticketId: string, filename: string, bytes: Uint8Array, mime: string, store: R2Store, isInline = false) =>
    lib.storeUpload(sql, {
      workspaceId: ctx.ws, ticketId, uploadedByUserId: null,
      filename, declaredMime: mime, bytes, maxBytes: 10 * 1024 * 1024, isInline,
    }, { store });

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    lib = await import('./lib/message-attachments.js');
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'up-' + RUN}, ${'up-' + RUN}) as provision_brand`;
    ctx.ws = ws;
    ctx.ticket = await seedTicket('TU-' + RUN);
    ctx.other = await seedTicket('TO-' + RUN);
  }, 30000);

  afterAll(async () => {
    if (ctx.ws) await sql`delete from workspaces where id = ${ctx.ws}`;
  });

  it('stores an accepted file as unclaimed, with a key scoped to the ticket', async () => {
    const fake = fakeStore();
    const res = await upload(ctx.ticket, 'invoice.pdf', PDF, 'application/pdf', fake.store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    ctx.pdfId = res.row.id;
    expect(res.row).toMatchObject({ filename: 'invoice.pdf', mime_type: 'application/pdf', is_inline: false, disposition: 'attachment' });
    expect(fake.puts[0].key).toBe(`att/${ctx.ws}/${ctx.ticket}/${res.row.id}/invoice.pdf`);
    expect(fake.puts[0].contentDisposition).toMatch(/^attachment; filename="invoice.pdf"/);
    const [row] = await sql<{ message_id: string | null; uploaded_by_user_id: string | null }[]>`
      select message_id, uploaded_by_user_id from ticket_attachments where id = ${res.row.id}`;
    expect(row.message_id).toBeNull();     // unclaimed until a reply is posted
  });

  it('refuses blocked types, lying image types, and non-images asked to be inline', async () => {
    const fake = fakeStore();
    expect(await upload(ctx.ticket, 'setup.exe', PDF, 'application/octet-stream', fake.store)).toEqual({ ok: false, reason: 'blocked type' });
    expect(await upload(ctx.ticket, 'page.html', HTML, 'text/html', fake.store)).toEqual({ ok: false, reason: 'blocked type' });
    // Declared as an image, bytes are not: stored as a plain download, never inline.
    const lying = await upload(ctx.ticket, 'photo.png', PDF, 'image/png', fake.store);
    expect(lying).toMatchObject({ ok: true, row: { disposition: 'attachment', mime_type: 'application/octet-stream' } });
    // The same file requested as an inline image is refused outright.
    expect(await upload(ctx.ticket, 'photo2.png', PDF, 'image/png', fake.store, true)).toEqual({ ok: false, reason: 'not an image' });
    // A real PNG asked to be inline is accepted and served inline.
    const real = await upload(ctx.ticket, 'shot.png', PNG, 'image/png', fake.store, true);
    expect(real).toMatchObject({ ok: true, row: { disposition: 'inline', is_inline: true, mime_type: 'image/png' } });
    if (real.ok) {
      const [r] = await sql<{ content_id: string }[]>`select content_id from ticket_attachments where id = ${real.row.id}`;
      expect(r.content_id).toBe(real.row.id);   // its own cid token
      ctx.inlineId = real.row.id;
    }
  });

  it('refuses a file over the per-upload cap', async () => {
    const fake = fakeStore();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF, 0);
    expect(await upload(ctx.ticket, 'big.pdf', big, 'application/pdf', fake.store)).toEqual({ ok: false, reason: 'too large' });
  });

  it('claims uploads onto a message exactly once', async () => {
    const messageId = await seedMessage(ctx.ticket);
    const claimed = await lib.claimAttachments(sql, { workspaceId: ctx.ws, ticketId: ctx.ticket, messageId, ids: [ctx.pdfId] });
    expect(claimed).toHaveLength(1);
    const [row] = await sql<{ message_id: string }[]>`select message_id from ticket_attachments where id = ${ctx.pdfId}`;
    expect(row.message_id).toBe(messageId);

    // A second claim of the same (now-sent) file is refused.
    const second = await seedMessage(ctx.ticket);
    await expectRejection(() => lib.claimAttachments(sql, { workspaceId: ctx.ws, ticketId: ctx.ticket, messageId: second, ids: [ctx.pdfId] }), /already sent|unknown/);
  });

  it('refuses an attachment id belonging to another ticket, and an unknown id', async () => {
    const fake = fakeStore();
    const other = await upload(ctx.other, 'other.pdf', PDF, 'application/pdf', fake.store);
    expect(other.ok).toBe(true);
    const messageId = await seedMessage(ctx.ticket);
    if (other.ok) {
      await expectRejection(() => lib.claimAttachments(sql, { workspaceId: ctx.ws, ticketId: ctx.ticket, messageId, ids: [other.row.id] }), /another ticket|unknown/);
      // …and it is still unclaimed on its own ticket.
      const [row] = await sql<{ message_id: string | null }[]>`select message_id from ticket_attachments where id = ${other.row.id}`;
      expect(row.message_id).toBeNull();
    }
    await expectRejection(() => lib.claimAttachments(sql, { workspaceId: ctx.ws, ticketId: ctx.ticket, messageId, ids: [crypto.randomUUID()] }), /unknown|already sent|another ticket/);
  });

  it('loads the bytes of a message’s files for Postmark, tagging inline ones with a cid', async () => {
    const fake = fakeStore();
    const messageId = await seedMessage(ctx.ticket);
    await lib.claimAttachments(sql, { workspaceId: ctx.ws, ticketId: ctx.ticket, messageId, ids: [ctx.inlineId] });
    const rows = await lib.listAttachmentsForMessage(ctx.ws, messageId);
    const files = await lib.loadOutboundFiles(rows, { store: fake.store });
    expect(files).toHaveLength(1);
    expect(files[0].contentId).toBe(`cid:${ctx.inlineId}`);
    expect(files[0].filename).toBe('shot.png');
    expect(files[0].base64).toBe(Buffer.from(PDF).toString('base64'));   // whatever the store returns
  });

  it('sweeps uploads nobody sent, and leaves claimed ones alone', async () => {
    const fake = fakeStore();
    const stale = await upload(ctx.ticket, 'forgotten.pdf', PDF, 'application/pdf', fake.store);
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    await sql`update ticket_attachments set created_at = now() - interval '2 days' where id = ${stale.row.id}`;
    // A claimed file of the same age must survive.
    const messageId = await seedMessage(ctx.ticket);
    const keep = await upload(ctx.ticket, 'kept.pdf', PDF, 'application/pdf', fake.store);
    if (!keep.ok) return;
    await lib.claimAttachments(sql, { workspaceId: ctx.ws, ticketId: ctx.ticket, messageId, ids: [keep.row.id] });
    await sql`update ticket_attachments set created_at = now() - interval '2 days' where id = ${keep.row.id}`;

    const { removed } = await lib.sweepUnclaimedAttachments(24, { store: fake.store });
    expect(removed).toBeGreaterThanOrEqual(1);
    const [gone] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where id = ${stale.row.id}`;
    expect(gone.n).toBe(0);
    const [kept] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where id = ${keep.row.id}`;
    expect(kept.n).toBe(1);
    expect(fake.deleted).toContain(`att/${ctx.ws}/${ctx.ticket}/${stale.row.id}/forgotten.pdf`);
  });
});
