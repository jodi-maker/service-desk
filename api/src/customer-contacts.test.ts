// customer_contacts — multiple emails / mobiles per customer (Phase 4, PR 5).
// DB-backed (RUN_DB_TESTS). Covers: the migration backfill invariant on the
// demo workspace, the three contact endpoints and their guards, the
// customers.email/mobile mirror, the unique indexes, the self-heal of
// contact-less (legacy) rows, bounce dual-write + reset, erasure hard-delete,
// profile soft-delete + address reuse, inbound-from-a-secondary resolution,
// and merge parking / unmerge_first / owned-last-email.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// suite can be parsed without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('customer contacts (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin = { email: `cc-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `cc-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;
  const DOMAIN = `cc-${RUN}.test`;

  // processInboundEmail fires triage/sentiment/pubby over fetch — stub it so
  // nothing leaves the process or mutates state mid-assertion.
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', ctx.ws);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }
  // Direct insert, deliberately WITHOUT contact rows — every pre-existing
  // fixture in the repo does this, so the suite doubles as the self-heal test.
  async function mkCustomer(tag: string, extra: Record<string, string | null> = {}): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers ${sql({
        workspace_id: ctx.ws,
        display_id: 'M-' + tag + '-' + RUN,
        first_name: 'C', last_name: tag,
        email: emailOf(tag),
        ...extra,
      })}
      returning id
    `;
    return row.id;
  }
  const emailOf = (tag: string) => `cc-${tag}-${RUN}@cust.test`;
  const contactsUrl = (cid: string) => `/api/v1/customers/${cid}/contacts`;
  const post = (token: string, path: string, body?: unknown) => as(token, path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const del = (token: string, path: string) => as(token, path, { method: 'DELETE' });
  const addEmail = (cid: string, value: string, primary?: boolean) => post(agent.token, contactsUrl(cid), { kind: 'email', value, primary });
  const addMobile = (cid: string, value: string) => post(agent.token, contactsUrl(cid), { kind: 'mobile', value });
  const rowsFor = (cid: string) => sql<{ id: string; kind: string; value: string; is_primary: boolean; deleted_at: string | null; merged_from_customer_id: string | null; bounce_state: string; bounce_count: number }[]>`
    select id, kind, value::text as value, is_primary, deleted_at, merged_from_customer_id, bounce_state, bounce_count
    from customer_contacts where customer_id = ${cid} order by created_at, id
  `;
  const scalars = async (cid: string) => (await sql<{ email: string | null; mobile: string | null; email_bounce_state: string; email_bounce_count: number }[]>`
    select email::text as email, mobile, email_bounce_state, email_bounce_count from customers where id = ${cid}
  `)[0];

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'cc-' + RUN}, ${'cc-' + RUN}) as provision_brand`;
    ctx.ws = ws;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    const [plainRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and name = 'Read Only' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${agent.userId}, ${plainRole.id}, true)`;
    // A verified sending domain so the bounce handler attributes events here.
    await sql`insert into workspace_email_domains (workspace_id, domain, verified_at) values (${ws}, ${DOMAIN}, now())`;
  }, 30000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await sql`delete from workspaces where id = ${ctx.ws}`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId})`;
  }, 15000);

  // ─── Migration backfill ───────────────────────────────────────────────────

  it('backfill: every demo customer with a scalar has exactly one primary contact of that kind, bounce state carried', async () => {
    // The demo workspace is seeded by an earlier migration, so its rows were
    // created by the backfill, not by app code. (Other suites insert
    // contact-less customers into THEIR workspaces — those are the self-heal's
    // job, not the backfill's, so the invariant is scoped here.)
    const DEMO_WS = '00000000-0000-0000-0000-000000000001';
    const [bad] = await sql<{ n: number }[]>`
      select count(*)::int as n from customers c
      where c.workspace_id = ${DEMO_WS} and c.deleted_at is null and (
        (nullif(trim(c.email::text), '') is not null and
          (select count(*) from customer_contacts x where x.customer_id = c.id and x.kind = 'email' and x.is_primary and x.deleted_at is null) <> 1)
        or (nullif(trim(c.mobile), '') is not null and
          (select count(*) from customer_contacts x where x.customer_id = c.id and x.kind = 'mobile' and x.is_primary and x.deleted_at is null) <> 1)
      )
    `;
    expect(bad.n).toBe(0);
    const [m001] = await sql<{ value: string; bounce_state: string; email: string; email_bounce_state: string }[]>`
      select cc.value::text as value, cc.bounce_state, c.email::text as email, c.email_bounce_state
      from customer_contacts cc join customers c on c.id = cc.customer_id
      where c.workspace_id = ${DEMO_WS} and c.display_id = 'M001' and cc.kind = 'email' and cc.is_primary
    `;
    expect(m001.value).toBe(m001.email);
    expect(m001.bounce_state).toBe(m001.email_bounce_state);
  });

  // ─── Read shape + self-heal ───────────────────────────────────────────────

  it('GET /customers ships emails/mobiles; a contact-less (legacy) row shows a synthesised primary from its scalars', async () => {
    const cid = await mkCustomer('list', { mobile: '+4477010001' });
    const res = await as(agent.token, '/api/v1/customers');
    expect(res.status).toBe(200);
    const row = ((await res.json()) as any).customers.find((c: any) => c.id === cid);
    expect(row.email).toBe(emailOf('list'));
    expect(row.emails).toEqual([expect.objectContaining({ id: null, value: emailOf('list'), is_primary: true })]);
    expect(row.mobiles).toEqual([expect.objectContaining({ id: null, value: '+4477010001', is_primary: true })]);
  });

  it('add a secondary: heals the primary row, mirror unchanged; set-primary flips the mirror; audit rows carry no address', async () => {
    const cid = await mkCustomer('add');
    const primary = emailOf('add');
    const alt = emailOf('add-alt');

    const res = await addEmail(cid, ` ${alt.toUpperCase()} `);   // trimmed + lower-cased on the way in
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.contact.value).toBe(alt);
    expect(body.contact.is_primary).toBe(false);
    expect(body.contacts.email).toBe(primary);
    expect(body.contacts.emails.map((e: any) => e.value).sort()).toEqual([alt, primary].sort());
    expect((await scalars(cid)).email).toBe(primary);
    // The heal gave the legacy scalar a real primary row.
    const rows = await rowsFor(cid);
    expect(rows.filter((r) => r.kind === 'email' && r.is_primary).map((r) => r.value)).toEqual([primary]);

    const r2 = await post(agent.token, `${contactsUrl(cid)}/${body.contact.id}/primary`);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).contacts.email).toBe(alt);
    expect((await scalars(cid)).email).toBe(alt);
    expect((await rowsFor(cid)).filter((r) => r.kind === 'email' && r.is_primary && !r.deleted_at).length).toBe(1);

    const audits = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from audit_events
      where workspace_id = ${ctx.ws} and target_id = ${cid} and action like 'customer.contact_%'
    `;
    expect(audits.map((a) => a.action).sort()).toEqual(['customer.contact_added', 'customer.contact_primary_changed']);
    for (const a of audits) expect(JSON.stringify(a.metadata)).not.toContain('@cust.test');

    ctx.addCid = cid;
    ctx.addAltId = body.contact.id;
  });

  it('duplicates: same profile → 409 contact_exists (case-insensitive); another profile → 409 contact_in_use naming it, even a legacy holder', async () => {
    const cid = ctx.addCid;
    const dup = await addEmail(cid, emailOf('ADD-ALT'));
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).code).toBe('contact_exists');

    const other = await mkCustomer('other');
    // 'add' still holds its original address as a live secondary row.
    const r = await addEmail(other, emailOf('add'));
    expect(r.status).toBe(409);
    const b = (await r.json()) as any;
    expect(b.code).toBe('contact_in_use');
    expect(b.display_id).toBe(`M-add-${RUN}`);

    // A legacy holder (scalar only, never touched → no contact row) is found
    // too, via the scalar fallback. (The heal it triggers is rolled back with
    // the refused transaction, so the second attempt exercises the same path.)
    const legacy = await mkCustomer('legacy');
    for (let attempt = 0; attempt < 2; attempt++) {
      const r2 = await addEmail(other, emailOf('legacy'));
      expect(r2.status).toBe(409);
      expect(((await r2.json()) as any).display_id).toBe(`M-legacy-${RUN}`);
    }
    expect((await rowsFor(legacy)).length).toBe(0);

    // Validation: bad email, unknown key, unknown kind.
    expect((await post(agent.token, contactsUrl(other), { kind: 'email', value: 'not-an-email' })).status).toBe(400);
    expect((await post(agent.token, contactsUrl(other), { kind: 'email', value: emailOf('x'), extra: 1 })).status).toBe(400);
    expect((await post(agent.token, contactsUrl(other), { kind: 'fax', value: '1' })).status).toBe(400);
  });

  it('a second primary of a kind is refused by the index itself', async () => {
    let code: string | null = null;
    try {
      await sql`
        insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary)
        values (${ctx.ws}, ${ctx.addCid}, 'email', ${emailOf('third')}, true)
      `;
    } catch (err) {
      code = (err as { code?: string }).code ?? null;
    }
    expect(code).toBe('23505');
  });

  it('remove: primary with siblings → set_primary_first; last owned email → last_email; a secondary → 200 and its address is reusable; the last mobile may go', async () => {
    const cid = ctx.addCid; // primary = add-alt, secondary = add
    const rows = (await rowsFor(cid)).filter((r) => r.kind === 'email' && !r.deleted_at);
    const prim = rows.find((r) => r.is_primary)!;
    const sec = rows.find((r) => !r.is_primary)!;

    let r = await del(agent.token, `${contactsUrl(cid)}/${prim.id}`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).code).toBe('set_primary_first');

    r = await del(agent.token, `${contactsUrl(cid)}/${sec.id}`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.removed.id).toBe(sec.id);
    expect(b.contacts.emails.map((e: any) => e.value)).toEqual([prim.value]);

    r = await del(agent.token, `${contactsUrl(cid)}/${prim.id}`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).code).toBe('last_email');

    // Soft-deleted → freed for another profile.
    const reuse = await mkCustomer('reuse');
    expect((await addEmail(reuse, sec.value)).status).toBe(201);

    // Mobiles: the first one becomes primary (mirror follows) and the last may be removed.
    const m = await addMobile(cid, '+4477010002');
    expect(m.status).toBe(201);
    expect((await scalars(cid)).mobile).toBe('+4477010002');
    const mid = ((await m.json()) as any).contact.id;
    expect((await del(agent.token, `${contactsUrl(cid)}/${mid}`)).status).toBe(200);
    expect((await scalars(cid)).mobile).toBeNull();

    // Unknown contact id → 404.
    expect((await del(agent.token, `${contactsUrl(cid)}/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
  });

  it('mobiles are not identity keys: two profiles may share one', async () => {
    const a = await mkCustomer('mob-a');
    const b = await mkCustomer('mob-b');
    expect((await addMobile(a, '+4477010003')).status).toBe(201);
    expect((await addMobile(b, '+4477010003')).status).toBe(201);
    // …but not twice on one profile.
    expect((await addMobile(b, '+4477010003')).status).toBe(409);
  });

  it('lists and resets individual suppressed addresses without clearing siblings; old clients see primaries only', async () => {
    const cid = await mkCustomer('suppression-list');
    const alt = emailOf('suppression-alt');
    expect((await addEmail(cid, alt)).status).toBe(201);
    await sql`update customer_contacts set bounce_state = 'hard', bounce_count = 2
      where customer_id = ${cid} and kind = 'email'`;
    const rows = await rowsFor(cid);
    const secondary = rows.find((r) => r.value === alt)!;
    const primary = rows.find((r) => r.is_primary)!;
    const list = await as(admin.token, '/api/v1/integrations/postmark/suppressed/contacts');
    expect(list.status).toBe(200);
    const body = await list.json() as any;
    expect(body.suppressed.filter((r: any) => r.id === cid).map((r: any) => r.contact_id).sort())
      .toEqual([primary.id, secondary.id].sort());
    const legacy = await as(admin.token, '/api/v1/integrations/postmark/suppressed');
    const oldBody = await legacy.json() as any;
    expect(oldBody.suppressed.filter((r: any) => r.id === cid).map((r: any) => r.contact_id)).toEqual([primary.id]);
    const resetUrl = `/api/v1/integrations/postmark/suppressed/${cid}/contacts/${secondary.id}/reset`;
    expect((await post(agent.token, resetUrl)).status).toBe(403);
    const wrongCustomer = await mkCustomer('wrong-reset-owner');
    expect((await post(admin.token, `/api/v1/integrations/postmark/suppressed/${wrongCustomer}/contacts/${secondary.id}/reset`)).status).toBe(404);
    expect((await post(admin.token, resetUrl)).status).toBe(200);
    const after = await rowsFor(cid);
    expect(after.find((r) => r.id === secondary.id)?.bounce_state).toBe('none');
    expect(after.find((r) => r.id === primary.id)?.bounce_state).toBe('hard');
    expect((await scalars(cid)).email_bounce_state).toBe('hard');
    expect((await del(agent.token, `${contactsUrl(cid)}/${secondary.id}`)).status).toBe(200);
    expect((await post(admin.token, resetUrl)).status).toBe(404);
  });

  it('concurrent bounces keep all counts and cannot downgrade suppression', async () => {
    const { processBounceEvent } = await import('./lib/postmark-bounce.js');
    const cid = await mkCustomer('concurrent-bounces');
    expect((await addEmail(cid, emailOf('concurrent-alt'))).status).toBe(201);
    const results = await Promise.all(['HardBounce', 'SoftBounce', 'Transient', 'SpamNotification'].map((Type) =>
      processBounceEvent({ fromDomain: DOMAIN, payload: {
        RecordType: 'Bounce', Type, Email: emailOf('concurrent-bounces'), From: `support@${DOMAIN}`,
      } }),
    ));
    expect(results.every((r) => r.ok && r.matched)).toBe(true);
    const primary = (await rowsFor(cid)).find((r) => r.is_primary);
    expect(primary?.bounce_count).toBe(4);
    expect(primary?.bounce_state).toBe('spam');
    expect((await scalars(cid)).email_bounce_count).toBe(4);
    expect((await scalars(cid)).email_bounce_state).toBe('spam');
    const stale = await processBounceEvent({ fromDomain: DOMAIN, payload: {
      RecordType: 'Bounce', Type: 'HardBounce', Email: emailOf('concurrent-alt'),
      From: `support@${DOMAIN}`, BouncedAt: '2000-01-01T00:00:00Z',
    } });
    expect(stale.ok && stale.matched).toBe(false);
    expect((await rowsFor(cid)).find((r) => !r.is_primary)?.bounce_state).toBe('none');
  });

  it('cannot list or reset a different workspace contact even with valid customer/contact IDs', async () => {
    const [{ id: foreignWs }] = await sql`select provision_brand(${'foreign-' + RUN}, ${'foreign-' + RUN}) as id`;
    try {
      const [customer] = await sql`insert into customers (workspace_id, display_id, email)
        values (${foreignWs}, 'FOREIGN', ${emailOf('foreign')}) returning id`;
      const [contact] = await sql`insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary, bounce_state)
        values (${foreignWs}, ${customer.id}, 'email', ${emailOf('foreign')}, true, 'hard') returning id`;
      const url = `/api/v1/integrations/postmark/suppressed/${customer.id}/contacts/${contact.id}/reset`;
      expect((await post(admin.token, url)).status).toBe(404);
      const list = await as(admin.token, '/api/v1/integrations/postmark/suppressed/contacts');
      expect((await list.json() as any).suppressed.some((r: any) => r.contact_id === contact.id)).toBe(false);
      const [unchanged] = await sql`select bounce_state from customer_contacts where id = ${contact.id}`;
      expect(unchanged.bounce_state).toBe('hard');
    } finally {
      await sql`delete from workspaces where id = ${foreignWs}`;
    }
  });

  // ─── Bounce dual-write ────────────────────────────────────────────────────

  it('bounce: a secondary address updates its contact row only; the primary updates both; reset clears the primary row only', async () => {
    const { processBounceEvent } = await import('./lib/postmark-bounce.js');
    const cid = await mkCustomer('bounce');
    const primary = emailOf('bounce');
    const alt = emailOf('bounce-alt');
    expect((await addEmail(cid, alt)).status).toBe(201);
    const bounce = (Email: string) => processBounceEvent({
      payload: { RecordType: 'Bounce', Type: 'HardBounce', Email, From: `support@${DOMAIN}`, BouncedAt: new Date().toISOString() },
      fromDomain: DOMAIN,
    });

    const r1 = (await bounce(alt)) as any;
    expect(r1.ok).toBe(true);
    expect(r1.matched).toBe(true);
    expect(r1.customerId).toBe(cid);
    let rows = await rowsFor(cid);
    expect(rows.find((r) => r.value === alt)!.bounce_state).toBe('hard');
    expect(rows.find((r) => r.value === primary)!.bounce_state).toBe('none');
    expect((await scalars(cid)).email_bounce_state).toBe('none');     // summary describes the primary

    const r2 = (await bounce(primary)) as any;
    expect(r2.matched).toBe(true);
    rows = await rowsFor(cid);
    expect(rows.find((r) => r.value === primary)!.bounce_state).toBe('hard');
    expect((await scalars(cid)).email_bounce_state).toBe('hard');
    expect((await scalars(cid)).email_bounce_count).toBe(1);

    // Admin reset: scalars + the primary row; the secondary keeps its state.
    const reset = await post(admin.token, `/api/v1/integrations/postmark/suppressed/${cid}/reset`);
    expect(reset.status).toBe(200);
    rows = await rowsFor(cid);
    expect(rows.find((r) => r.value === primary)!.bounce_state).toBe('none');
    expect(rows.find((r) => r.value === alt)!.bounce_state).toBe('hard');
    expect((await scalars(cid)).email_bounce_state).toBe('none');

    // Unknown address in this workspace → matched=false, still ok.
    expect(((await bounce(`nobody-${RUN}@cust.test`)) as any).matched).toBe(false);
  });

  // ─── Lifecycle coupling ───────────────────────────────────────────────────

  it('erasure hard-deletes the rows, records "contacts", and the erased profile refuses contact writes', async () => {
    const cid = await mkCustomer('erase');
    expect((await addEmail(cid, emailOf('erase-alt'))).status).toBe(201);
    const res = await post(admin.token, `/api/v1/customers/${cid}/erase`, { reason: 'test' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).fieldsErased).toContain('contacts');
    expect((await rowsFor(cid)).length).toBe(0);
    expect((await scalars(cid)).email).toBeNull();
    const r = await addEmail(cid, emailOf('erase-again'));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).code).toBe('erased');
    // The erased address is free again.
    const again = await mkCustomer('erase-reuse');
    expect((await addEmail(again, emailOf('erase-alt'))).status).toBe(201);
  });

  it('profile soft-delete soft-deletes the rows in the same transaction, freeing the address', async () => {
    const cid = await mkCustomer('del');
    expect((await addEmail(cid, emailOf('del-alt'))).status).toBe(201);
    expect((await del(admin.token, `/api/v1/customers/${cid}`)).status).toBe(204);
    const rows = await rowsFor(cid);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.deleted_at).not.toBeNull();
    const reuse = await mkCustomer('del-reuse');
    expect((await addEmail(reuse, emailOf('del-alt'))).status).toBe(201);
  });

  // ─── Lookups resolve through contacts ─────────────────────────────────────

  it('inbound mail from a SECONDARY address attaches to the existing profile (no duplicate stub); a legacy row resolves and heals', async () => {
    const { processInboundEmail } = await import('./lib/inbound-email.js');
    const inbound = (from: string, tag: string) => ({
      MessageID: `cc-${tag}-${RUN}`,
      From: from,
      FromFull: { Email: from, Name: 'Cust' },
      Subject: `Hello ${tag}`,
      TextBody: 'body',
      HtmlBody: '',
      ToFull: [{ Email: `support@${DOMAIN}` }],
      Headers: [{ Name: 'Message-Id', Value: `<cc-${tag}-${RUN}@cust.test>` }],
    }) as any;

    const cid = await mkCustomer('inb');
    const alt = emailOf('inb-alt');
    expect((await addEmail(cid, alt)).status).toBe(201);
    const res = (await processInboundEmail({ workspaceId: ctx.ws, payload: inbound(alt, 'inb') })) as any;
    expect(res.is_new_customer).toBe(false);
    const [t] = await sql<{ customer_id: string }[]>`select customer_id from tickets where id = ${res.ticket_id}`;
    expect(t.customer_id).toBe(cid);
    const [dupes] = await sql<{ n: number }[]>`select count(*)::int as n from customers where workspace_id = ${ctx.ws} and email = ${alt}`;
    expect(dupes.n).toBe(0);

    // Legacy (contact-less) profile: resolved via the scalar fallback and healed.
    const legacy = await mkCustomer('inb-legacy');
    const res2 = (await processInboundEmail({ workspaceId: ctx.ws, payload: inbound(emailOf('inb-legacy'), 'inb-legacy') })) as any;
    expect(res2.is_new_customer).toBe(false);
    const [t2] = await sql<{ customer_id: string }[]>`select customer_id from tickets where id = ${res2.ticket_id}`;
    expect(t2.customer_id).toBe(legacy);
    expect((await rowsFor(legacy)).filter((r) => r.kind === 'email' && r.is_primary).length).toBe(1);

    // Brand-new sender → stub customer WITH its primary contact row.
    const res3 = (await processInboundEmail({ workspaceId: ctx.ws, payload: inbound(emailOf('inb-new'), 'inb-new') })) as any;
    expect(res3.is_new_customer).toBe(true);
    const [stub] = await sql<{ id: string }[]>`select id from customers where workspace_id = ${ctx.ws} and email = ${emailOf('inb-new')}`;
    expect((await rowsFor(stub.id)).map((r) => [r.kind, r.value, r.is_primary])).toEqual([['email', emailOf('inb-new'), true]]);
  });

  // ─── Merge / unmerge ──────────────────────────────────────────────────────

  it('merge parks a value-duplicate mobile soft-deleted; moved rows refuse removal (unmerge_first); the survivor keeps one OWNED email; unmerge restores everything', async () => {
    const a = await mkCustomer('mg-a');
    const b = await mkCustomer('mg-b');
    expect((await addMobile(a, '+4477010009')).status).toBe(201);
    expect((await addMobile(b, '+4477010009')).status).toBe(201);   // shared number → will park on merge

    const merge = await post(admin.token, `/api/v1/customers/${a}/merge`, { into_id: b });
    expect(merge.status).toBe(200);
    const mb = (await merge.json()) as any;
    expect(mb.contacts_moved).toBe(2);                                 // a's email + a's mobile
    expect(mb.primary.email).toBe(emailOf('mg-b'));
    expect(mb.primary.mobile).toBe('+4477010009');
    expect(mb.primary.mobiles.length).toBe(1);                         // the parked duplicate is not shown live

    const aRowsOnB = (await rowsFor(b)).filter((r) => r.merged_from_customer_id === a);
    const parked = aRowsOnB.find((r) => r.kind === 'mobile')!;
    const movedEmail = aRowsOnB.find((r) => r.kind === 'email')!;
    expect(parked.deleted_at).not.toBeNull();
    expect(movedEmail.deleted_at).toBeNull();
    expect(movedEmail.is_primary).toBe(false);
    expect((await scalars(a)).email).toBeNull();                       // source mirror released

    // A merged-away profile refuses contact writes.
    const onA = await addEmail(a, emailOf('mg-a-more'));
    expect(onA.status).toBe(409);
    expect(((await onA.json()) as any).code).toBe('merged');

    // A moved row can't be removed from the survivor — un-merge instead.
    const rm = await del(agent.token, `${contactsUrl(b)}/${movedEmail.id}`);
    expect(rm.status).toBe(409);
    expect(((await rm.json()) as any).code).toBe('unmerge_first');

    // Promote the moved address on the survivor, then try to drop its OWN one:
    // refused, because that would leave it with no email it owns.
    expect((await post(agent.token, `${contactsUrl(b)}/${movedEmail.id}/primary`)).status).toBe(200);
    expect((await scalars(b)).email).toBe(emailOf('mg-a'));
    const own = (await rowsFor(b)).find((r) => r.kind === 'email' && !r.merged_from_customer_id && !r.deleted_at)!;
    const rmOwn = await del(agent.token, `${contactsUrl(b)}/${own.id}`);
    expect(rmOwn.status).toBe(409);
    expect(((await rmOwn.json()) as any).code).toBe('last_email');

    // Unmerge: a's rows go home with their pre-merge primary flags (parked
    // duplicate revived), b re-promotes its own email, both mirrors recompute.
    const un = await post(admin.token, `/api/v1/customers/${a}/unmerge`);
    expect(un.status).toBe(200);
    const ub = (await un.json()) as any;
    expect(ub.contacts_restored).toBe(2);
    expect(ub.source.email).toBe(emailOf('mg-a'));
    expect(ub.source.mobile).toBe('+4477010009');
    expect(ub.primary.email).toBe(emailOf('mg-b'));
    expect(ub.primary.mobile).toBe('+4477010009');
    const aRows = (await rowsFor(a)).filter((r) => !r.deleted_at);
    expect(aRows.map((r) => [r.kind, r.is_primary, r.merged_from_customer_id]).sort()).toEqual([['email', true, null], ['mobile', true, null]]);
    expect((await scalars(a))).toMatchObject({ email: emailOf('mg-a'), mobile: '+4477010009' });
    expect((await scalars(b))).toMatchObject({ email: emailOf('mg-b'), mobile: '+4477010009' });
  });

  it('merge/unmerge of a contact-less pair (self-heal) keeps both mirrors intact', async () => {
    const a = await mkCustomer('heal-a', { mobile: '+4477010011' });
    const b = await mkCustomer('heal-b', { mobile: null });
    expect((await post(admin.token, `/api/v1/customers/${a}/merge`, { into_id: b })).status).toBe(200);
    expect(await scalars(b)).toMatchObject({ email: emailOf('heal-b'), mobile: '+4477010011' });  // promoted, like the old backfill
    expect(await scalars(a)).toMatchObject({ email: null, mobile: null });
    expect((await post(admin.token, `/api/v1/customers/${a}/unmerge`)).status).toBe(200);
    expect(await scalars(a)).toMatchObject({ email: emailOf('heal-a'), mobile: '+4477010011' });
    expect(await scalars(b)).toMatchObject({ email: emailOf('heal-b'), mobile: null });
  });

  // ─── Review-driven cases ──────────────────────────────────────────────────

  it("set-primary carries the primary row's bounce state onto the customer summary", async () => {
    const { processBounceEvent } = await import('./lib/postmark-bounce.js');
    const cid = await mkCustomer('bmirror');
    const alt = emailOf('bmirror-alt');
    const added = (await (await addEmail(cid, alt)).json()) as any;
    await processBounceEvent({
      payload: { RecordType: 'Bounce', Type: 'HardBounce', Email: alt, From: `support@${DOMAIN}`, BouncedAt: new Date().toISOString() },
      fromDomain: DOMAIN,
    });
    expect((await scalars(cid)).email_bounce_state).toBe('none');           // secondary bounced — summary still describes the primary
    expect((await post(agent.token, `${contactsUrl(cid)}/${added.contact.id}/primary`)).status).toBe(200);
    expect(await scalars(cid)).toMatchObject({ email: alt, email_bounce_state: 'hard', email_bounce_count: 1 });
  });

  it('erasure redacts inbox mail from EVERY address and removes rows re-homed onto a survivor when the source was soft-deleted', async () => {
    // (a) un-converted inbox mail sent from a SECONDARY address.
    const cid = await mkCustomer('er2');
    const alt = emailOf('er2-alt');
    expect((await addEmail(cid, alt)).status).toBe(201);
    const [ch] = await sql<{ id: string }[]>`
      insert into channels (workspace_id, display_id, name, type) values (${ctx.ws}, ${'CH-er2-' + RUN}, 'Inbox', 'email') returning id
    `;
    const [msg] = await sql<{ id: string }[]>`
      insert into inbox_messages (workspace_id, channel_id, from_name, from_email, subject, body, received_at)
      values (${ctx.ws}, ${ch.id}, 'C', ${alt.toUpperCase()}, 'from my other address', 'secret', now()) returning id
    `;
    expect((await post(admin.token, `/api/v1/customers/${cid}/erase`, {})).status).toBe(200);
    const [after] = await sql<{ from_email: string | null; body: string | null }[]>`select from_email, body from inbox_messages where id = ${msg.id}`;
    expect(after.from_email).toBeNull();
    expect(after.body).toBeNull();

    // (b) merged-away source, then soft-deleted (unmerge impossible), then erased:
    // its stamped rows on the survivor must go too, and the survivor is repaired.
    const s = await mkCustomer('er-src');
    const p = await mkCustomer('er-pri');
    expect((await post(admin.token, `/api/v1/customers/${s}/merge`, { into_id: p })).status).toBe(200);
    expect((await del(admin.token, `/api/v1/customers/${s}`)).status).toBe(204);
    expect((await post(admin.token, `/api/v1/customers/${s}/erase`, {})).status).toBe(200);
    expect((await sql`select 1 from customer_contacts where workspace_id = ${ctx.ws} and merged_from_customer_id = ${s}`).length).toBe(0);
    expect(await scalars(p)).toMatchObject({ email: emailOf('er-pri') });
    const reuse = await mkCustomer('er-reuse');
    expect((await addEmail(reuse, emailOf('er-src'))).status).toBe(201);      // the erased address is free again
  });

  it('unmerge reverts a PRE-contacts journalled mobile through the contacts model', async () => {
    // Pre-deploy state: the old scalar backfill copied S's mobile onto P and
    // journalled it; the migration then gave BOTH an unstamped primary row.
    const s = await mkCustomer('lm-s', { mobile: '+4477010021' });
    const p = await mkCustomer('lm-p', { mobile: '+4477010021' });
    await sql`update customers set merged_into_customer_id = ${p}, merged_at = now() where id = ${s}`;
    await sql`
      insert into customer_merges (workspace_id, source_customer_id, primary_customer_id, backfilled_fields)
      values (${ctx.ws}, ${s}, ${p}, ${sql.json({ mobile: '+4477010021' })})
    `;
    const res = await post(admin.token, `/api/v1/customers/${s}/unmerge`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.fields_reverted).toContain('mobile');
    expect(await scalars(p)).toMatchObject({ email: emailOf('lm-p'), mobile: null });
    expect(await scalars(s)).toMatchObject({ email: emailOf('lm-s'), mobile: '+4477010021' });
  });

  it('adding an address held by a duplicate ALREADY merged into this profile adopts the row (stamped) instead of a dead-end 409', async () => {
    const d = await mkCustomer('ad-d');
    const s = await mkCustomer('ad-s');
    // A pre-contacts merge: d kept its email scalar and the backfill gave it a live row.
    await sql`update customers set merged_into_customer_id = ${s}, merged_at = now() where id = ${d}`;
    await sql`insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary) values (${ctx.ws}, ${d}, 'email', ${emailOf('ad-d')}, true)`;
    const r = await addEmail(s, emailOf('ad-d'));
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b.contact.merged_from_customer_id).toBe(d);
    expect(b.contact.is_primary).toBe(false);
    expect(b.contacts.emails.map((e: any) => e.value).sort()).toEqual([emailOf('ad-d'), emailOf('ad-s')].sort());
    expect((await scalars(d)).email).toBeNull();                              // scalar released
    // Scalar-only duplicate (never healed) works too.
    const d2 = await mkCustomer('ad-d2');
    await sql`update customers set merged_into_customer_id = ${s}, merged_at = now() where id = ${d2}`;
    expect((await addEmail(s, emailOf('ad-d2'))).status).toBe(201);
    // Unmerge still gives the address back.
    expect((await post(admin.token, `/api/v1/customers/${d}/unmerge`)).status).toBe(200);
    expect((await rowsFor(d)).filter((x) => !x.deleted_at && x.kind === 'email').map((x) => x.value)).toEqual([emailOf('ad-d')]);
    expect((await scalars(d)).email).toBe(emailOf('ad-d'));
  });

  it('erasure/export match an address only for the time this profile held it — a later holder\'s mail is untouched', async () => {
    const a = await mkCustomer('win-a');
    const b = await mkCustomer('win-b');
    const shared = emailOf('win-shared');
    const [ch] = await sql<{ id: string }[]>`
      insert into channels (workspace_id, display_id, name, type) values (${ctx.ws}, ${'CH-win-' + RUN}, 'Inbox', 'email') returning id
    `;
    const mail = async (subject: string) => (await sql<{ id: string }[]>`
      insert into inbox_messages (workspace_id, channel_id, from_name, from_email, subject, body, received_at)
      values (${ctx.ws}, ${ch.id}, 'C', ${shared}, ${subject}, 'body', now()) returning id
    `)[0].id;
    // A holds the address, mail arrives, A releases it, B adopts it, mail arrives again.
    const added = (await (await addEmail(a, shared)).json()) as any;
    const whileA = await mail('while A held it');
    expect((await del(agent.token, `${contactsUrl(a)}/${added.contact.id}`)).status).toBe(200);
    expect((await addEmail(b, shared)).status).toBe(201);
    const whileB = await mail('after B adopted it');

    // A's export sees only the first message; B's only the second.
    const exA = (await (await as(admin.token, `/api/v1/customers/${a}/export`)).json()) as any;
    expect(exA.inbox_messages.map((m: any) => m.subject)).toEqual(['while A held it']);
    const exB = (await (await as(admin.token, `/api/v1/customers/${b}/export`)).json()) as any;
    expect(exB.inbox_messages.map((m: any) => m.subject)).toEqual(['after B adopted it']);

    // Erasing A redacts only A's message.
    expect((await post(admin.token, `/api/v1/customers/${a}/erase`, {})).status).toBe(200);
    const rows = await sql<{ id: string; body: string | null }[]>`select id, body from inbox_messages where id in (${whileA}, ${whileB})`;
    expect(rows.find((r) => r.id === whileA)!.body).toBeNull();
    expect(rows.find((r) => r.id === whileB)!.body).toBe('body');
  });

  it('adopting an address onto a survivor with no email of its own promotes it to primary', async () => {
    const d = await mkCustomer('nop-d');
    const s = await mkCustomer('nop-s', { email: null });
    await sql`update customers set merged_into_customer_id = ${s}, merged_at = now() where id = ${d}`;
    await sql`insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary) values (${ctx.ws}, ${d}, 'email', ${emailOf('nop-d')}, true)`;
    const r = await addEmail(s, emailOf('nop-d'));
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).contact.is_primary).toBe(true);
    expect((await scalars(s)).email).toBe(emailOf('nop-d'));
    expect((await rowsFor(s)).filter((x) => x.kind === 'email' && x.is_primary && !x.deleted_at).length).toBe(1);
  });

  it('a row that came from a merged duplicate becomes removable once that duplicate is soft-deleted', async () => {
    const s = await mkCustomer('or-s');
    const p = await mkCustomer('or-p');
    expect((await post(admin.token, `/api/v1/customers/${s}/merge`, { into_id: p })).status).toBe(200);
    const moved = (await rowsFor(p)).find((r) => r.merged_from_customer_id === s && r.kind === 'email')!;
    expect((await del(agent.token, `${contactsUrl(p)}/${moved.id}`)).status).toBe(409);
    expect((await del(admin.token, `/api/v1/customers/${s}`)).status).toBe(204);
    expect((await del(agent.token, `${contactsUrl(p)}/${moved.id}`)).status).toBe(200);
    const reuse = await mkCustomer('or-reuse');
    expect((await addEmail(reuse, emailOf('or-s'))).status).toBe(201);
  });
});
