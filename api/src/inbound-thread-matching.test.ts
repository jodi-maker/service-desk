// Inbound thread matching — DB-backed (RUN_DB_TESTS). Reproduces the live bug:
// a customer reply routed to the shared inbound address resolves to the
// unrouted bucket, yet must still THREAD onto the original ticket (in its own
// workspace) via the globally-unique In-Reply-To Message-ID — and unmatched
// mail to the bucket must create a ticket, not 500 on missing lookups.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('inbound thread matching (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let processInboundEmail: typeof import('./lib/inbound-email.js').processInboundEmail;

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;
  const AGENT_MSG_ID = `<agent-${RUN}@weezboo.com>`;

  // Stub fetch so fire-and-forget triage/sentiment/pubby calls don't hit the
  // network or mutate state mid-assertion — they fail fast and are swallowed.
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  function inbound(opts: { from: string; subject: string; text: string; messageId: string; inReplyTo?: string }) {
    const headers: Array<{ Name: string; Value: string }> = [{ Name: 'Message-Id', Value: opts.messageId }];
    if (opts.inReplyTo) headers.push({ Name: 'In-Reply-To', Value: opts.inReplyTo });
    return {
      MessageID: opts.messageId.replace(/[<>]/g, ''),
      From: opts.from,
      FromFull: { Email: opts.from, Name: 'Cust' },
      Subject: opts.subject,
      TextBody: opts.text,
      HtmlBody: '',
      ToFull: [{ Email: 'sharedhash@inbound.postmarkapp.com' }],
      Headers: headers,
    } as any;
  }

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    processInboundEmail = (await import('./lib/inbound-email.js')).processInboundEmail;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'itm-' + RUN}, ${'itm-' + RUN}) as provision_brand`;
    ctx.wsReal = ws;
    const [bucket] = await sql<{ id: string }[]>`select id from workspaces where is_unrouted_bucket = true`;
    ctx.bucket = bucket.id;

    // A real ticket in wsReal with an agent reply that carries a known
    // RFC Message-ID (what our outbound stamps as external_message_id).
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email)
      values (${ws}, ${'C-' + RUN}, 'Real', ${`real-${RUN}@cust.test`}) returning id`;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, sla_state)
      values (${ws}, ${'TT-' + RUN}, 'Original subject', ${cust.id}, 'open', 'normal', 'ok') returning id`;
    ctx.realTicket = t.id;
    ctx.realCustomerEmail = `real-${RUN}@cust.test`;
    await sql`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
      values (${ws}, ${t.id}, 'agent', 'Agent', 'our reply', ${AGENT_MSG_ID})`;
  }, 30000);

  afterAll(async () => {
    await sql`delete from ticket_messages where workspace_id in (${ctx.wsReal}, ${ctx.bucket}) and created_at::date = now()::date`;
    await sql`delete from tickets where workspace_id in (${ctx.wsReal}, ${ctx.bucket}) and created_at::date = now()::date`;
  });

  it('threads a reply onto the original ticket even when resolved to the unrouted bucket', async () => {
    // Simulate domain resolution falling back to the bucket (shared inbound addr).
    const res = await processInboundEmail({
      workspaceId: ctx.bucket,
      payload: inbound({ from: ctx.realCustomerEmail, subject: 'Re: Original subject', text: 'customer reply body', messageId: `<reply-${RUN}@cust.test>`, inReplyTo: AGENT_MSG_ID }),
    });
    expect(res.threaded).toBe(true);
    expect(res.ticket_id).toBe(ctx.realTicket);   // attached to the real ticket, not the bucket

    // The reply landed as a customer message on the ORIGINAL ticket.
    const [msg] = await sql<{ body: string; workspace_id: string }[]>`
      select body, workspace_id from ticket_messages
      where ticket_id = ${ctx.realTicket} and role = 'customer' and body = 'customer reply body'`;
    expect(msg).toBeTruthy();
    expect(msg.workspace_id).toBe(ctx.wsReal);
    const [ticket] = await sql`select last_inbound_email from tickets where id = ${ctx.realTicket}`;
    expect(ticket.last_inbound_email).toBe(ctx.realCustomerEmail);
  });

  it('dedups a redelivered reply (Postmark retry) instead of attaching twice', async () => {
    const again = await processInboundEmail({
      workspaceId: ctx.bucket,
      payload: inbound({ from: ctx.realCustomerEmail, subject: 'Re: Original subject', text: 'customer reply body', messageId: `<reply-${RUN}@cust.test>`, inReplyTo: AGENT_MSG_ID }),
    });
    expect(again.deduped).toBe(true);
    const rows = await sql<{ id: string }[]>`
      select id from ticket_messages
      where ticket_id = ${ctx.realTicket} and role = 'customer' and body = 'customer reply body'`;
    expect(rows).toHaveLength(1);   // not duplicated
  });

  it('reopens a resolved ticket on an email reply and clears resolved_at', async () => {
    await sql`update tickets set status_key = 'resolved', resolved_at = now() where id = ${ctx.realTicket}`;
    const res = await processInboundEmail({
      workspaceId: ctx.bucket,
      payload: inbound({ from: ctx.realCustomerEmail, subject: 'Re: Original subject', text: 'still broken!', messageId: `<reply2-${RUN}@cust.test>`, inReplyTo: AGENT_MSG_ID }),
    });
    expect(res.threaded).toBe(true);
    const [t] = await sql<{ status_key: string; resolved_at: string | null }[]>`
      select status_key, resolved_at from tickets where id = ${ctx.realTicket}`;
    expect(t.status_key).toBe('open');
    expect(t.resolved_at).toBeNull();
  });

  it('creates a ticket in the unrouted bucket for unmatched mail (no 500)', async () => {
    const res = await processInboundEmail({
      workspaceId: ctx.bucket,
      payload: inbound({ from: `stranger-${RUN}@nowhere.test`, subject: 'No thread here', text: 'hello', messageId: `<new-${RUN}@nowhere.test>` }),
    });
    expect(res.threaded).toBe(false);
    expect(res.ticket_id).toBeTruthy();
    const [t] = await sql<{ workspace_id: string }[]>`select workspace_id from tickets where id = ${res.ticket_id}`;
    expect(t.workspace_id).toBe(ctx.bucket);   // landed in the bucket, didn't crash
    const [created] = await sql`select last_inbound_email from tickets where id = ${res.ticket_id}`;
    expect(created.last_inbound_email).toBe(`stranger-${RUN}@nowhere.test`);
  });

  it('refreshes the thread address on a new reply but not on a redelivered older message', async () => {
    const latest = `latest-${RUN}@cust.test`;
    const [owner] = await sql`select customer_id from tickets where id = ${ctx.realTicket}`;
    const { ensurePrimaryContacts } = await import('./lib/customer-contacts.js');
    await ensurePrimaryContacts(sql, { workspaceId: ctx.wsReal, customerId: owner.customer_id, email: ctx.realCustomerEmail });
    await sql`insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary)
      values (${ctx.wsReal}, ${owner.customer_id}, 'email', ${latest}, false)`;
    await processInboundEmail({ workspaceId: ctx.bucket, payload: inbound({
      from: latest, subject: 'Re: Original subject', text: 'new sender',
      messageId: `<latest-${RUN}@cust.test>`, inReplyTo: AGENT_MSG_ID,
    }) });
    await processInboundEmail({ workspaceId: ctx.bucket, payload: inbound({
      from: ctx.realCustomerEmail, subject: 'Re: Original subject', text: 'customer reply body',
      messageId: `<reply-${RUN}@cust.test>`, inReplyTo: AGENT_MSG_ID,
    }) });
    const [ticket] = await sql`select last_inbound_email from tickets where id = ${ctx.realTicket}`;
    expect(ticket.last_inbound_email).toBe(latest);
    const { resolveTicketRecipient } = await import('./lib/ticket-recipient.js');
    expect((await resolveTicketRecipient(ctx.wsReal, ctx.realTicket))?.email).toBe(latest);
    expect(await resolveTicketRecipient(ctx.bucket, ctx.realTicket)).toBeNull();
  });

  it('does not retain a third-party reply address on someone else\'s ticket', async () => {
    const thirdParty = `third-party-${RUN}@cust.test`;
    await processInboundEmail({ workspaceId: ctx.bucket, payload: inbound({
      from: thirdParty, subject: 'Re: Original subject', text: 'third party reply',
      messageId: `<third-party-${RUN}@cust.test>`, inReplyTo: AGENT_MSG_ID,
    }) });
    const [ticket] = await sql`select last_inbound_email from tickets where id = ${ctx.realTicket}`;
    expect(ticket.last_inbound_email).toBeNull();
    const { resolveTicketRecipient } = await import('./lib/ticket-recipient.js');
    expect((await resolveTicketRecipient(ctx.wsReal, ctx.realTicket))?.email).toBe(ctx.realCustomerEmail);
  });
});
