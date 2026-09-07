// GDPR erasure — DB-backed integration test. Drives the real Hono app against a
// real Postgres (same harness as tenant-isolation.test.ts): gated behind
// RUN_DB_TESTS (set in CI). Seeds a customer with PII across every surface, calls
// POST /api/v1/customers/:id/erase, and asserts the personal data is gone.
//
// Run locally:
//   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=maestro_test -p 5432:5432 postgres:17
//   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/maestro_test?sslmode=disable' bun run migrate
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/gdpr-erasure.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('GDPR erasure (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const slug = `era-${RUN}`;
  const admin = { email: `era-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `era-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({
      body: { email, password: 'password-12345', name: email },
      returnHeaders: true,
    });
    return { id: r.response.user.id, token: r.response.token };
  }

  function as(token: string | null, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', ctx.wsId);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${slug}, ${slug}) as provision_brand
    `;
    ctx.wsId = wsId;

    const [adminRole] = await sql<{ id: string }[]>`
      select id from roles where workspace_id = ${wsId} and is_admin = true limit 1
    `;
    const [roRole] = await sql<{ id: string }[]>`
      select id from roles where workspace_id = ${wsId} and coalesce(is_admin,false) = false limit 1
    `;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${agent.userId}, ${roRole.id}, true)`;

    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, username, email, mobile, kyc_status, jurisdiction, backoffice_url, brand,
                             maestro_user_id, maestro_member_id, player_lookup_at)
      values (${wsId}, ${'M-' + slug}, 'Jane', 'Doe', 'janed', ${'jane-' + slug + '@player.test'}, '+15551234', 'verified', 'MT', 'https://bo.example/p/1', 'Acme',
              'mu-jane-0001', '4711', now())
      returning id
    `;
    ctx.customerId = cust.id;

    const [tk] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, csat_comment, snooze_reason)
      values (${wsId}, ${'TK-' + slug}, 'My real name is Jane Doe', ${cust.id}, 'open', 'normal', 'Agent Jane was great', 'waiting on Jane')
      returning id
    `;
    ctx.ticketId = tk.id;

    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body) values (${wsId}, ${tk.id}, 'customer', 'Jane Doe', 'Hi, my email is jane@player.test')`;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body) values (${wsId}, ${tk.id}, 'agent', 'Support Agent', 'Replied to Jane')`;
    await sql`insert into customer_notes (workspace_id, customer_id, text) values (${wsId}, ${cust.id}, 'VIP, lives in Valletta')`;

    const [ch] = await sql<{ id: string }[]>`
      insert into channels (workspace_id, display_id, name, type) values (${wsId}, ${'CH-' + slug}, 'Support Inbox', 'email') returning id
    `;
    await sql`
      insert into inbox_messages (workspace_id, channel_id, from_name, from_email, subject, body, received_at, converted_ticket_id)
      values (${wsId}, ${ch.id}, 'Jane Doe', ${'jane-' + slug + '@player.test'}, 'Help', 'my number is +15551234', now(), ${tk.id})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    if (ctx.wsId) await sql`delete from workspaces where id = ${ctx.wsId}`;
    const ids = [admin.userId, agent.userId].filter(Boolean);
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('non-admin members are refused (403)', async () => {
    const res = await as(agent.token, `/api/v1/customers/${ctx.customerId}/erase`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });

  it('404s an unknown customer id', async () => {
    const res = await as(admin.token, `/api/v1/customers/00000000-0000-0000-0000-000000000000/erase`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('erases all PII surfaces and writes the audit row', async () => {
    // Contacts model: a primary + a secondary address on the profile.
    await sql`
      insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary) values
        (${ctx.wsId}, ${ctx.customerId}, 'email', ${'jane-' + slug + '@player.test'}, true),
        (${ctx.wsId}, ${ctx.customerId}, 'email', ${'jane-alt-' + slug + '@player.test'}, false)
    `;
    const res = await as(admin.token, `/api/v1/customers/${ctx.customerId}/erase`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'DSAR #1' }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.erased).toBe(true);
    expect(body.alreadyErased).toBe(false);
    expect(body.messagesRedacted).toBe(2);
    expect(body.notesDeleted).toBe(1);
    expect(body.inboxRedacted).toBeGreaterThanOrEqual(1);

    const [cust] = await sql<any[]>`select * from customers where id = ${ctx.customerId}`;
    expect(cust.first_name).toBeNull();
    expect(cust.last_name).toBeNull();
    expect(cust.email).toBeNull();
    expect(cust.mobile).toBeNull();
    // Still asserted after Phase 4 removed KYC from the product: the column
    // survives until its drop migration, so erasure must keep nulling it.
    expect(cust.kyc_status).toBeNull();
    expect(cust.jurisdiction).toBeNull();
    // Maestro player ids name the subject's casino account — erased too, and
    // the lookup stamp goes with them so nothing re-links an erased profile.
    expect(cust.maestro_user_id).toBeNull();
    expect(cust.maestro_member_id).toBeNull();
    expect(cust.player_lookup_at).toBeNull();
    expect(cust.erased_at).not.toBeNull();
    expect(cust.brand).toBe('Acme'); // non-identifying, retained

    const [tk] = await sql<any[]>`select * from tickets where id = ${ctx.ticketId}`;
    expect(tk.subject).toBe('[erased]');
    expect(tk.csat_comment).toBeNull();
    expect(tk.snooze_reason).toBeNull();

    const msgs = await sql<any[]>`select role, author_label, body from ticket_messages where ticket_id = ${ctx.ticketId} order by created_at`;
    for (const m of msgs) expect(m.body).toBe('[erased]');
    const cust_msg = msgs.find((m) => m.role === 'customer');
    const agent_msg = msgs.find((m) => m.role === 'agent');
    expect(cust_msg.author_label).toBe('[erased]');
    expect(agent_msg.author_label).toBe('Support Agent'); // staff label kept

    const notes = await sql<any[]>`select count(*)::int as n from customer_notes where customer_id = ${ctx.customerId}`;
    expect(notes[0].n).toBe(0);

    // Contact rows are HARD-deleted (a soft-deleted row would keep the address).
    const contacts = await sql<any[]>`select count(*)::int as n from customer_contacts where customer_id = ${ctx.customerId}`;
    expect(contacts[0].n).toBe(0);

    const inbox = await sql<any[]>`select from_email, body, subject from inbox_messages where converted_ticket_id = ${ctx.ticketId}`;
    expect(inbox[0].from_email).toBeNull();
    expect(inbox[0].body).toBeNull();
    expect(inbox[0].subject).toBeNull();

    const era = await sql<any[]>`select fields_erased, reason, completed_at from gdpr_erasures where customer_id = ${ctx.customerId}`;
    expect(era.length).toBe(1);
    expect(era[0].reason).toBe('DSAR #1');
    expect(era[0].fields_erased).toContain('email');
    expect(era[0].fields_erased).toContain('contacts');
    expect(era[0].fields_erased).toContain('maestro_user_id');
    expect(era[0].fields_erased).toContain('maestro_member_id');
    expect(era[0].completed_at).not.toBeNull();
  });

  it('deletes attachments (rows + R2 objects) for the customer\'s tickets', async () => {
    // Fresh customer + ticket + attachment so this is independent of the erase
    // above. eraseCustomer is called directly with an injected R2 deleter so no
    // R2 config/network is needed and we can assert the exact keys.
    const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email)
      values (${ctx.wsId}, ${'M2-' + slug}, 'Bob', ${'bob-' + slug + '@player.test'}) returning id
    `;
    const [tk] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ctx.wsId}, ${'TK2-' + slug}, 'S', ${cust.id}, 'open', 'normal') returning id
    `;
    const key = `att/${slug}/file.pdf`;
    await sql`
      insert into ticket_attachments (workspace_id, ticket_id, filename, storage_key, mime_type)
      values (${ctx.wsId}, ${tk.id}, 'file.pdf', ${key}, 'application/pdf')
    `;

    const deletedKeys: string[] = [];
    const result = await eraseCustomer(
      { workspaceId: ctx.wsId, customerId: cust.id, requestedByUserId: admin.userId, reason: 'DSAR attach' },
      { deleteObjects: async (keys) => { deletedKeys.push(...keys); } },
    );

    expect(result?.attachmentsDeleted).toBe(1);
    expect(deletedKeys).toEqual([key]);                       // exact R2 key deleted
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where ticket_id = ${tk.id}`;
    expect(rows[0].n).toBe(0);                                // row gone
  });

  it('completes the DB erase even if R2 object deletion fails (best-effort, post-commit)', async () => {
    const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email)
      values (${ctx.wsId}, ${'M3-' + slug}, 'Carl', ${'carl-' + slug + '@player.test'}) returning id
    `;
    const [tk] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ctx.wsId}, ${'TK3-' + slug}, 'S', ${cust.id}, 'open', 'normal') returning id
    `;
    await sql`
      insert into ticket_attachments (workspace_id, ticket_id, filename, storage_key)
      values (${ctx.wsId}, ${tk.id}, 'x.pdf', ${'att/' + slug + '/x.pdf'})
    `;

    // deleteObjects rejects (simulates R2 down). The erase must still resolve
    // with the DB durably erased — the object failure is alerted, not thrown.
    const result = await eraseCustomer(
      { workspaceId: ctx.wsId, customerId: cust.id, requestedByUserId: admin.userId, reason: 'r2-down' },
      { deleteObjects: async () => { throw new Error('R2 unavailable'); } },
    );

    expect(result?.erased).toBe(true);
    expect(result?.attachmentsDeleted).toBe(1);               // rows removed in-txn
    const [c] = await sql<any[]>`select first_name, email, erased_at from customers where id = ${cust.id}`;
    expect(c.first_name).toBeNull();
    expect(c.email).toBeNull();
    expect(c.erased_at).not.toBeNull();                       // committed despite R2 failure
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from ticket_attachments where ticket_id = ${tk.id}`;
    expect(rows[0].n).toBe(0);

    // The un-deleted key stays in the outbox (written in the erase transaction)
    // with the failed attempt recorded.
    const parked = await sql<{ reason: string; attempts: number; last_error: string | null }[]>`
      select reason, attempts, last_error from pending_object_deletions where storage_key = ${'att/' + slug + '/x.pdf'}
    `;
    expect(parked).toHaveLength(1);
    expect(parked[0].reason).toBe('erasure');
    expect(parked[0].attempts).toBe(1);
    expect(parked[0].last_error).toBe('R2 unavailable');

    // The retry sweep, given a working deleter, deletes the object and clears the row.
    const { retryPendingObjectDeletions } = await import('./lib/gdpr-erasure.js');
    const retried: string[] = [];
    const res = await retryPendingObjectDeletions(100, { deleteObjects: async (k) => { retried.push(...k); } });
    expect(retried).toContain(`att/${slug}/x.pdf`);
    expect(res.parkedKeysDeleted).toBeGreaterThanOrEqual(1);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from pending_object_deletions where storage_key = ${'att/' + slug + '/x.pdf'}`;
    expect(after[0].n).toBe(0);                                // cleared
  });

  it('retry sweep isolates a permanently failing key from the rest of the page', async () => {
    const { retryPendingObjectDeletions } = await import('./lib/gdpr-erasure.js');
    const bad = `att/${slug}/bad.pdf`;
    const good = `att/${slug}/good.pdf`;
    await sql`insert into pending_object_deletions (storage_key, reason) values (${bad}, 'retention'), (${good}, 'retention')`;
    const res = await retryPendingObjectDeletions(100, {
      deleteObjects: async (k) => { if (k.includes(bad)) throw new Error('403 forbidden'); },
    });
    expect(res.parkedKeysDeleted).toBeGreaterThanOrEqual(1);
    const left = await sql<{ storage_key: string; attempts: number }[]>`
      select storage_key, attempts from pending_object_deletions where storage_key in (${bad}, ${good})
    `;
    expect(left.map((r) => r.storage_key)).toEqual([bad]);    // good cleared, bad kept
    expect(left[0].attempts).toBe(1);
    await sql`delete from pending_object_deletions where storage_key = ${bad}`;
  });

  it('is idempotent — a second erase reports alreadyErased and adds no audit row', async () => {
    const res = await as(admin.token, `/api/v1/customers/${ctx.customerId}/erase`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.alreadyErased).toBe(true);
    const era = await sql<any[]>`select count(*)::int as n from gdpr_erasures where customer_id = ${ctx.customerId}`;
    expect(era[0].n).toBe(1);
  });
});
