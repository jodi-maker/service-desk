// Agent-reply email delivery — DB-backed (RUN_DB_TESTS). Posts agent replies
// and internal notes through POST /tickets/:id/messages with Postmark mocked,
// asserting: a public reply emails the customer and stamps the threading
// Message-Id; an internal note never emails; no-email and hard-bounced
// customers are saved-only with the right reason.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

// Hermetic env so imports resolve; force Postmark "configured" + a fallback
// sender so the send path runs and getOutboundFrom falls back cleanly.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
process.env.POSTMARK_SERVER_TOKEN = 'test-server-token';
process.env.POSTMARK_OUTBOUND_FROM = 'support@maestro.test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('agent-reply email delivery (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin = { email: `ar-admin-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  const realFetch = globalThis.fetch;
  let postmarkCalls = 0;
  let lastBody: any = null;

  beforeEach(() => {
    postmarkCalls = 0; lastBody = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.postmarkapp.com/email')) {
        postmarkCalls++;
        lastBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({ MessageID: 'pm-id', SubmittedAt: '2026-01-01T00:00:00Z', To: 'x', ErrorCode: 0, Message: 'OK' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input as any, init);
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: 'Reply Agent' }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${admin.token}`);
    headers.set('X-Workspace-Id', ctx.wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }
  async function seedTicket(display: string, opts: { email: string | null; bounce?: string | null }): Promise<string> {
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email, email_bounce_state)
      values (${ctx.wsId}, ${'C-' + display}, 'C', ${opts.email}, ${opts.bounce ?? 'none'}) returning id
    `;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ctx.wsId}, ${display}, 'Need help', ${cust.id}, 'open', 'normal') returning id
    `;
    return t.id;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const ua = await signUp(admin.email);
    admin.userId = ua.id; admin.token = ua.token;
    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'ar-' + RUN}, ${'ar-' + RUN}) as provision_brand`;
    ctx.wsId = wsId;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
  }, 30000);

  afterAll(async () => {
    if (ctx.wsId) await sql`delete from workspaces where id = ${ctx.wsId}`;
    if (admin.userId) await sql`delete from users where id = ${admin.userId}`;
  });

  it('emails the customer on a public reply and stamps the threading Message-Id', async () => {
    const email = `cust1-${RUN}@acme.test`;
    const tid = await seedTicket(`AR-${RUN}-1`, { email });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'Here is your answer.' }) });
    expect(res.status).toBe(201);
    const { message, delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(true);
    expect(postmarkCalls).toBe(1);
    expect(lastBody.To).toBe(email);
    expect(String(lastBody.Subject)).toMatch(/^Re:/);
    // The reply row carries the RFC Message-Id so a customer reply threads back.
    const [row] = await sql<{ external_message_id: string | null }[]>`
      select external_message_id from ticket_messages where id = ${message.id}
    `;
    expect(row.external_message_id).toMatch(/^<.+@.+>$/);
  });

  async function contactTicket(label: string, primaryBounce = 'none') {
    const primary = `${label}-primary-${RUN}@acme.test`;
    const secondary = `${label}-secondary-${RUN}@acme.test`;
    const tid = await seedTicket(`AR-${RUN}-${label}`, { email: primary, bounce: primaryBounce });
    const [ticket] = await sql`select customer_id from tickets where id = ${tid}`;
    const res = await as(`/api/v1/customers/${ticket.customer_id}/contacts`, {
      method: 'POST', body: JSON.stringify({ kind: 'email', value: secondary }),
    });
    expect(res.status).toBe(201);
    await sql`update tickets set last_inbound_email = ${secondary.toUpperCase()} where id = ${tid}`;
    return { tid, cid: ticket.customer_id as string, primary, secondary };
  }

  async function reply(tid: string) {
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST', body: JSON.stringify({ role: 'agent', body: 'Address test' }),
    });
    expect(res.status).toBe(201);
    return await res.json() as { delivery: { emailed: boolean; reason: string } };
  }

  it('sends a rich reply to the live thread address even when the primary is hard-bounced', async () => {
    const { tid, secondary } = await contactTicket('thread', 'hard');
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST', body: JSON.stringify({ role: 'agent', body_html: '<p>Hello <b>again</b></p>' }),
    });
    expect(res.status).toBe(201);
    expect(lastBody.To).toBe(secondary);
    expect(lastBody.HtmlBody).toContain('<b>again</b>');
  });

  it('holds hard/spam thread addresses without redirecting to a healthy primary; soft bounces send', async () => {
    const { tid, cid, secondary } = await contactTicket('suppressed');
    for (const state of ['hard', 'spam', 'soft']) {
      await sql`update customer_contacts set bounce_state = ${state}
        where workspace_id = ${ctx.wsId} and customer_id = ${cid} and value = ${secondary}`;
      const { delivery } = await reply(tid);
      expect(delivery.reason).toBe(state === 'soft' ? 'sent' : 'email_suppressed');
      expect(delivery.emailed).toBe(state === 'soft');
    }
    expect(postmarkCalls).toBe(1);
    expect(lastBody.To).toBe(secondary);
  });

  it('falls back after removal even if another customer now owns the old thread address', async () => {
    const { tid, cid, primary, secondary } = await contactTicket('removed');
    const [contact] = await sql`select id from customer_contacts where customer_id = ${cid} and value = ${secondary}`;
    const removed = await as(`/api/v1/customers/${cid}/contacts/${contact.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    await seedTicket(`AR-${RUN}-new-owner`, { email: secondary });
    const { delivery } = await reply(tid);
    expect(delivery.emailed).toBe(true);
    expect(lastBody.To).toBe(primary);
  });

  it('AI replies and surveys use the same thread address and suppression policy', async () => {
    const { postAutoReply } = await import('./lib/auto-reply.js');
    const { sendCsatSurvey } = await import('./lib/csat-survey.js');
    const { tid, cid, secondary } = await contactTicket('automatic', 'hard');
    const auto = await postAutoReply({ workspaceId: ctx.wsId, ticketId: tid, draftReply: 'Answer', confidence: 1, model: 'test', workspaceName: 'Test' });
    expect(auto.posted).toBe(true);
    expect(lastBody.To).toBe(secondary);
    const survey = await sendCsatSurvey({ workspaceId: ctx.wsId, ticketId: tid });
    expect(survey.sent).toBe(true);
    expect(lastBody.To).toBe(secondary);

    await sql`delete from events where workspace_id = ${ctx.wsId} and entity_id = ${tid} and kind = 'auto_reply'`;
    await sql`update tickets set csat_requested_at = null where id = ${tid}`;
    await sql`update customer_contacts set bounce_state = 'hard' where customer_id = ${cid} and value = ${secondary}`;
    const heldAuto = await postAutoReply({ workspaceId: ctx.wsId, ticketId: tid, draftReply: 'Answer', confidence: 1, model: 'test', workspaceName: 'Test' });
    expect(heldAuto).toEqual({ posted: false, reason: 'email_suppressed' });
    expect(await sendCsatSurvey({ workspaceId: ctx.wsId, ticketId: tid })).toEqual({ sent: false, reason: 'email_suppressed' });
    expect(postmarkCalls).toBe(2);
  });

  it('retains address routing across merge and unmerge, and exports then erases the stored address', async () => {
    const { tid, cid, secondary } = await contactTicket('merge-routing');
    const survivorTid = await seedTicket(`AR-${RUN}-survivor-routing`, { email: `survivor-${RUN}@acme.test` });
    const [survivor] = await sql`select customer_id from tickets where id = ${survivorTid}`;
    const merged = await as(`/api/v1/customers/${cid}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: survivor.customer_id }),
    });
    expect(merged.status).toBe(200);
    expect((await reply(tid)).delivery.emailed).toBe(true);
    expect(lastBody.To).toBe(secondary);
    const unmerged = await as(`/api/v1/customers/${cid}/unmerge`, { method: 'POST' });
    expect(unmerged.status).toBe(200);
    expect((await reply(tid)).delivery.emailed).toBe(true);
    expect(lastBody.To).toBe(secondary);
    const { exportCustomer } = await import('./lib/gdpr-export.js');
    const exported = await exportCustomer({ workspaceId: ctx.wsId, customerId: cid });
    expect(exported?.tickets.find((t) => t.display_id === `AR-${RUN}-merge-routing`)?.last_inbound_email?.toString().toLowerCase()).toBe(secondary);
    const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
    const erased = await eraseCustomer({ workspaceId: ctx.wsId, customerId: cid, requestedByUserId: admin.userId });
    expect(erased?.fieldsErased).toContain('tickets.last_inbound_email');
    const [row] = await sql`select last_inbound_email from tickets where id = ${tid}`;
    expect(row.last_inbound_email).toBeNull();
    expect((await reply(tid)).delivery.emailed).toBe(false);
  });

  it('sends a plain-text-only reply with no HTML part when the workspace has nothing to brand', async () => {
    const tid = await seedTicket(`AR-${RUN}-html0`, { email: `cust-h0-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'plain words' }) });
    expect(res.status).toBe(201);
    expect(lastBody.TextBody).toContain('plain words');
    expect(lastBody.HtmlBody).toBeUndefined();      // unchanged pre-rich behaviour
    expect(lastBody.Attachments).toBeUndefined();
  });

  it('sends a rich-text reply as HTML, derives the text part, and sanitises the agent’s markup', async () => {
    const tid = await seedTicket(`AR-${RUN}-html1`, { email: `cust-h1-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST',
      // No `body` at all: the text part must be derived from the HTML. The
      // <script> and the onclick are the agent-side XSS guard.
      body: JSON.stringify({ role: 'agent', body_html: '<p>Hello <b>Nina</b></p><p>See <a href="https://ok.test">this link</a></p><script>alert(1)</script><div onclick="x()">click</div>' }),
    });
    expect(res.status).toBe(201);
    const { message, delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(true);
    // HTML part goes out with the formatting, without the script/handler.
    expect(lastBody.HtmlBody).toContain('<b>Nina</b>');
    expect(lastBody.HtmlBody).not.toContain('<script');
    expect(lastBody.HtmlBody).not.toMatch(/onclick/i);
    // Every link is forced to open in a new tab with no opener.
    expect(lastBody.HtmlBody).toContain('rel="noopener noreferrer"');
    // Text part derived for plain-text clients: readable, links preserved.
    expect(lastBody.TextBody).toContain('Hello Nina');
    expect(lastBody.TextBody).toContain('https://ok.test');
    expect(lastBody.TextBody).not.toContain('<p>');
    // Stored the same way.
    const [row] = await sql<{ body: string; body_html: string | null }[]>`
      select body, body_html from ticket_messages where id = ${message.id}`;
    expect(row.body_html).toContain('<b>Nina</b>');
    expect(row.body_html).not.toContain('<script');
    expect(row.body).toContain('Hello Nina');
  });

  it('emails attachments, tagging a pasted image as an inline cid part', async () => {
    const tid = await seedTicket(`AR-${RUN}-att`, { email: `cust-att-${RUN}@acme.test` });
    // A file uploaded earlier (unclaimed) plus an image pasted into the editor.
    const [att] = await sql<{ id: string }[]>`
      insert into ticket_attachments (workspace_id, ticket_id, filename, size_bytes, storage_key, mime_type, disposition)
      values (${ctx.wsId}, ${tid}, 'report.pdf', 14, ${`att/${ctx.wsId}/${tid}/seed/report.pdf`}, 'application/pdf', 'attachment')
      returning id`;
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString('base64');
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        role: 'agent',
        body: 'see attached',
        body_html: `<p>see attached</p><img src="data:image/png;base64,${pngB64}">`,
        attachment_ids: [att.id],
      }),
    });
    // The pasted image needs object storage, which is unconfigured in tests —
    // the request is refused cleanly rather than emailing a broken message.
    expect(res.status).toBe(503);
    const { error } = await res.json() as any;
    expect(error).toMatch(/storage is not configured/i);
    expect(postmarkCalls).toBe(0);
    // Nothing was claimed, so the file is still available for the next attempt.
    const [row] = await sql<{ message_id: string | null }[]>`select message_id from ticket_attachments where id = ${att.id}`;
    expect(row.message_id).toBeNull();
  });

  it('refuses attachment ids from another ticket without saving the reply', async () => {
    const tid = await seedTicket(`AR-${RUN}-x1`, { email: `cust-x1-${RUN}@acme.test` });
    const other = await seedTicket(`AR-${RUN}-x2`, { email: `cust-x2-${RUN}@acme.test` });
    const [att] = await sql<{ id: string }[]>`
      insert into ticket_attachments (workspace_id, ticket_id, filename, size_bytes, storage_key, mime_type, disposition)
      values (${ctx.wsId}, ${other}, 'theirs.pdf', 10, ${`att/${ctx.wsId}/${other}/seed/theirs.pdf`}, 'application/pdf', 'attachment')
      returning id`;
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'agent', body: 'here', attachment_ids: [att.id] }),
    });
    expect(res.status).toBe(400);
    expect(postmarkCalls).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${tid} and role = 'agent'`;
    expect(n).toBe(0);                                // no orphaned reply row
    const [row] = await sql<{ message_id: string | null }[]>`select message_id from ticket_attachments where id = ${att.id}`;
    expect(row.message_id).toBeNull();                // and the other ticket's file is untouched
  });

  it('rejects a body-less, html-less message', async () => {
    const tid = await seedTicket(`AR-${RUN}-empty`, { email: `cust-e-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent' }) });
    expect(res.status).toBe(400);
  });

  it('does not email an internal note', async () => {
    const tid = await seedTicket(`AR-${RUN}-2`, { email: `cust2-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'note', body: 'internal only' }) });
    expect(res.status).toBe(201);
    const { delivery } = await res.json() as any;
    expect(delivery).toBeUndefined();
    expect(postmarkCalls).toBe(0);
  });

  it('saves but does not email when the customer has no address', async () => {
    const tid = await seedTicket(`AR-${RUN}-3`, { email: null });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'hi' }) });
    const { delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(false);
    expect(delivery.reason).toBe('no_customer_email');
    expect(postmarkCalls).toBe(0);
  });

  it('skips hard-bounced / spam-flagged addresses', async () => {
    const tid = await seedTicket(`AR-${RUN}-4`, { email: `bounced-${RUN}@acme.test`, bounce: 'hard' });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'hi' }) });
    const { delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(false);
    expect(delivery.reason).toBe('email_suppressed');
    expect(postmarkCalls).toBe(0);
  });
});
