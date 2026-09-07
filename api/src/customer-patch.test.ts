// PATCH /api/v1/customers/:id — the pinned details card's save (Phase 4, PR 6).
// DB-backed (RUN_DB_TESTS). Covers: the strict whitelist + blank → null +
// impossible-date / non-http-link validation, the deleted / erased / merged
// guards, the no-op path (no UPDATE, no audit row), the audit row's PII split
// (values for brand/vip/since/consent, names only for the rest), the uniform
// date-only wire shape on GET and PATCH, and the merge ↔ edit interaction on
// unmerge (fields_kept_due_to_edit).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// suite can be parsed without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('PATCH /customers/:id (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin    = { email: `cp-admin-${RUN}@t.test` } as Record<string, string>;
  const agent    = { email: `cp-agent-${RUN}@t.test` } as Record<string, string>;
  const outsider = { email: `cp-out-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string | null, path: string, init: RequestInit = {}, ws: string = ctx.ws) {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', ws);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }
  const emailOf = (tag: string) => `cp-${tag}-${RUN}@cust.test`;
  // Direct insert, deliberately WITHOUT contact rows — like every other
  // fixture in the repo; the PATCH response must still carry the address.
  async function mkCustomer(tag: string, extra: Record<string, unknown> = {}, ws: string = ctx.ws): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers ${sql({
        workspace_id: ws,
        display_id: 'M-' + tag + '-' + RUN,
        first_name: 'C', last_name: tag,
        email: emailOf(tag),
        ...extra,
      })}
      returning id
    `;
    return row.id;
  }
  const url = (cid: string) => `/api/v1/customers/${cid}`;
  const patch = (token: string | null, cid: string, body: unknown) =>
    as(token, url(cid), { method: 'PATCH', body: JSON.stringify(body) });
  const rowOf = async (cid: string) => (await sql<Record<string, any>[]>`
    select first_name, last_name, username, brand, vip_tier, jurisdiction, consent, since::text as since,
           backoffice_url, updated_at from customers where id = ${cid}
  `)[0];
  const auditsFor = (cid: string) => sql<{ action: string; metadata: Record<string, any> }[]>`
    select action, metadata from audit_events
    where workspace_id = ${ctx.ws} and target_id = ${cid} and action = 'customer.updated'
    order by created_at
  `;

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug, uo] = await Promise.all([signUp(admin.email), signUp(agent.email), signUp(outsider.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;
    outsider.userId = uo.id; outsider.token = uo.token;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'cp-' + RUN}, ${'cp-' + RUN}) as provision_brand`;
    ctx.ws = ws;
    const [{ provision_brand: ws2 }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'cp2-' + RUN}, ${'cp2-' + RUN}) as provision_brand`;
    ctx.ws2 = ws2;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    const [plainRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and name = 'Read Only' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${agent.userId}, ${plainRole.id}, true)`;
  });

  afterAll(async () => {
    if (!sql) return;
    for (const ws of [ctx.ws, ctx.ws2]) if (ws) await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId}, ${outsider.userId})`;
  }, 15000);

  it('schema: strict whitelist, real dates, http(s) links, non-blank names; 401 / 403 / 404 guards', async () => {
    const cid = await mkCustomer('SCHEMA');
    const bad = async (body: unknown) => {
      const r = await patch(agent.token, cid, body);
      expect(r.status).toBe(400);
      return (await r.json()) as { error: string };
    };
    expect((await bad({ email: 'x@y.test' })).error).toBe('Invalid body');           // addresses go through the contact endpoints
    expect((await bad({ maestro_user_id: 'abc' })).error).toBe('Invalid body');      // server-owned
    expect((await bad({ nope: 1 })).error).toBe('Invalid body');
    expect((await bad({})).error).toBe('No fields to update');
    expect((await bad({ since: 'yesterday' })).error).toBe('Invalid body');
    expect((await bad({ since: '2024-02-30' })).error).toBe('Invalid body');         // passes the regex, not a real date → 400 not 500
    expect((await bad({ since: '0000-01-01' })).error).toBe('Invalid body');         // JS Date accepts year 0, Postgres `date` doesn't
    expect((await bad({ backoffice_url: 'javascript:alert(1)' })).error).toBe('Invalid body');
    expect((await bad({ backoffice_url: 'ftp://x.test/a' })).error).toBe('Invalid body');
    expect((await bad({ first_name: '' })).error).toBe('Invalid body');
    expect((await bad({ first_name: '   ' })).error).toBe('Invalid body');
    expect((await bad({ consent: 'yes' })).error).toBe('Invalid body');

    expect((await patch(null, cid, { brand: 'X' })).status).toBe(401);
    expect((await patch(outsider.token, cid, { brand: 'X' })).status).toBe(403);
    expect((await patch(agent.token, 'not-a-uuid', { brand: 'X' })).status).toBe(404);
    expect((await patch(agent.token, '00000000-0000-4000-8000-000000000000', { brand: 'X' })).status).toBe(404);
    // Nothing above touched the row or the audit trail.
    expect((await rowOf(cid)).brand).toBeNull();
    expect((await auditsFor(cid)).length).toBe(0);
  });

  it('happy path: an agent (Read Only role — membership is the gate) edits several fields; identical values are ignored', async () => {
    const cid = await mkCustomer('HAPPY', { brand: 'Initech', vip_tier: 'Platinum', jurisdiction: 'DE', consent: false, since: '2021-06-20' });
    const before = await rowOf(cid);
    const list0 = await (await as(agent.token, '/api/v1/customers')).json() as { customers: Record<string, any>[] };
    expect(list0.customers.find((c) => c.id === cid)?.since).toBe('2021-06-20');   // GET / ships the date as text too

    const r = await patch(agent.token, cid, {
      first_name: 'Ninaqx', vip_tier: 'Gold', jurisdiction: 'Zedland-99', consent: true,
      brand: 'Initech',   // identical → not a change
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { customer: Record<string, any>; changed: Record<string, { from: unknown; to: unknown }> };
    expect(Object.keys(body.changed).sort()).toEqual(['consent', 'first_name', 'jurisdiction', 'vip_tier']);
    expect(body.changed.vip_tier).toEqual({ from: 'Platinum', to: 'Gold' });
    expect(body.changed.consent).toEqual({ from: false, to: true });   // same `from` the audit row records
    expect(body.customer.first_name).toBe('Ninaqx');
    expect(body.customer.since).toBe('2021-06-20');
    expect(body.customer.consent).toBe(true);
    expect(Array.isArray(body.customer.emails)).toBe(true);
    expect(body.customer.emails[0]?.value).toBe(emailOf('HAPPY'));   // self-healed contact row rides along
    expect(body.customer.email).toBe(emailOf('HAPPY'));

    const after = await rowOf(cid);
    expect(after.first_name).toBe('Ninaqx');
    expect(after.vip_tier).toBe('Gold');
    expect(after.jurisdiction).toBe('Zedland-99');
    expect(after.consent).toBe(true);
    expect(after.brand).toBe('Initech');
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());

    // Audit: one row; values only for the non-PII columns, names for the rest.
    const audits = await auditsFor(cid);
    expect(audits.length).toBe(1);
    const meta = audits[0].metadata;
    expect(meta.customer_id).toBe(cid);
    expect(Object.keys(meta.changed).sort()).toEqual(['consent', 'vip_tier']);
    expect(meta.changed.vip_tier).toEqual({ from: 'Platinum', to: 'Gold' });
    expect(meta.changed.consent).toEqual({ from: false, to: true });
    expect([...meta.changed_pii].sort()).toEqual(['first_name', 'jurisdiction']);
    const flat = JSON.stringify(meta);
    expect(flat).not.toContain('Ninaqx');
    expect(flat).not.toContain('Zedland');
    expect(flat).not.toContain('brand');   // the identical field is not a change

    ctx.happy = cid;
  });

  it('no-op: identical values (incl. consent:false on a null column) → changed {}, no UPDATE, no audit row', async () => {
    const cid = await mkCustomer('NOOP', { brand: 'Acme', vip_tier: 'Silver' });   // consent left null
    const before = await rowOf(cid);
    const r = await patch(agent.token, cid, { brand: 'Acme', vip_tier: 'Silver', consent: false, username: '' });   // username null → '' → null: no change
    expect(r.status).toBe(200);
    const body = await r.json() as { changed: Record<string, unknown>; customer: Record<string, any> };
    expect(body.changed).toEqual({});
    expect(body.customer.brand).toBe('Acme');
    const after = await rowOf(cid);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.consent).toBeNull();   // untouched — not rewritten to false
    expect((await auditsFor(cid)).length).toBe(0);
  });

  it('blank input clears: username / backoffice_url / since → null, echoed as null; usernames and links round-trip', async () => {
    const cid = await mkCustomer('BLANK', { username: 'blanky', backoffice_url: 'https://bo.test/x', since: '2020-01-02' });
    const r = await patch(agent.token, cid, { username: '  ', backoffice_url: '', since: null });
    expect(r.status).toBe(200);
    const body = await r.json() as { customer: Record<string, any>; changed: Record<string, unknown> };
    expect(body.customer.username).toBeNull();
    expect(body.customer.backoffice_url).toBeNull();
    expect(body.customer.since).toBeNull();
    expect(Object.keys(body.changed).sort()).toEqual(['backoffice_url', 'since', 'username']);
    const row = await rowOf(cid);
    expect(row.username).toBeNull(); expect(row.backoffice_url).toBeNull(); expect(row.since).toBeNull();

    const r2 = await patch(agent.token, cid, { username: ' new_name ', backoffice_url: ' https://bo.test/y ', since: '2024-02-29' });
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as { customer: Record<string, any> };
    expect(b2.customer.username).toBe('new_name');
    expect(b2.customer.backoffice_url).toBe('https://bo.test/y');
    expect(b2.customer.since).toBe('2024-02-29');   // a real leap day is fine
    // PII columns appear by name only in the audit metadata.
    const audits = await auditsFor(cid);
    expect(audits.length).toBe(2);
    for (const a of audits) {
      const flat = JSON.stringify(a.metadata);
      expect(flat).not.toContain('blanky'); expect(flat).not.toContain('new_name'); expect(flat).not.toContain('bo.test');
      expect(a.metadata.changed_pii).toEqual(expect.arrayContaining(['username', 'backoffice_url']));
      expect(a.metadata.changed.since).toBeDefined();
    }
  });

  it('guards: soft-deleted → 404; erased → 409 erased (no audit); merged source → 409 merged naming the survivor; other workspace → 404', async () => {
    const deleted = await mkCustomer('DEL', { deleted_at: new Date().toISOString() });
    expect((await patch(agent.token, deleted, { brand: 'X' })).status).toBe(404);

    const erased = await mkCustomer('ERASED', { erased_at: new Date().toISOString(), first_name: null, last_name: null, email: null });
    const re = await patch(agent.token, erased, { first_name: 'Back' });
    expect(re.status).toBe(409);
    expect(((await re.json()) as { code: string }).code).toBe('erased');
    expect((await rowOf(erased)).first_name).toBeNull();
    expect((await auditsFor(erased)).length).toBe(0);

    const survivor = await mkCustomer('SURV');
    const source = await mkCustomer('SRC', { merged_into_customer_id: survivor, merged_at: new Date().toISOString() });
    const rm = await patch(agent.token, source, { brand: 'X' });
    expect(rm.status).toBe(409);
    const mb = (await rm.json()) as { code: string; merged_into_customer_id: string };
    expect(mb.code).toBe('merged');
    expect(mb.merged_into_customer_id).toBe(survivor);
    expect((await rowOf(source)).brand).toBeNull();

    const foreign = await mkCustomer('FOREIGN', {}, ctx.ws2);
    expect((await patch(agent.token, foreign, { brand: 'X' })).status).toBe(404);
    expect((await rowOf(foreign)).brand).toBeNull();
  });

  it('merge interaction: editing a field the merge backfilled keeps the edit on unmerge (fields_kept_due_to_edit)', async () => {
    const a = await mkCustomer('MA', { brand: 'Acme-M7' });   // duplicate, has a brand
    const b = await mkCustomer('MB');                          // survivor, brand null → backfilled from A
    const merge = await as(admin.token, `/api/v1/customers/${a}/merge`, { method: 'POST', body: JSON.stringify({ into_id: b }) });
    expect(merge.status).toBe(200);
    expect((await rowOf(b)).brand).toBe('Acme-M7');

    const edit = await patch(agent.token, b, { brand: 'Zeta-M7' });
    expect(edit.status).toBe(200);

    const unmerge = await as(admin.token, `/api/v1/customers/${a}/unmerge`, { method: 'POST' });
    expect(unmerge.status).toBe(200);
    const ub = (await unmerge.json()) as { fields_kept_due_to_edit: string[]; fields_reverted: string[] };
    expect(ub.fields_kept_due_to_edit).toContain('brand');
    expect(ub.fields_reverted).not.toContain('brand');
    expect((await rowOf(b)).brand).toBe('Zeta-M7');
    expect((await rowOf(a)).brand).toBe('Acme-M7');
  });
});
