// Data-retention purge + per-workspace window — DB-backed (RUN_DB_TESTS).
// Verifies the purge deletes only expired resolved tickets (cascading their
// children), respects a NULL window, and that the window is admin-configurable.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('data retention (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let purgeExpiredTickets: typeof import('./lib/retention.js').purgeExpiredTickets;

  const RUN = Date.now();
  const slug = `ret-${RUN}`;
  const slugHold = `ret-hold-${RUN}`;
  const admin = { email: `ret-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `ret-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', ctx.wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }
  // Seed a customer + ticket (customer_id is NOT NULL) with an explicit
  // resolved_at and a message child.
  async function seedTicket(wsId: string, display: string, resolvedAt: string | null): Promise<string> {
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name) values (${wsId}, ${'C-' + display}, 'C') returning id
    `;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, resolved_at)
      values (${wsId}, ${display}, 'S', ${cust.id}, ${resolvedAt ? 'resolved' : 'open'}, 'normal', ${resolvedAt})
      returning id
    `;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body) values (${wsId}, ${t.id}, 'customer', 'C', 'hi')`;
    return t.id;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    purgeExpiredTickets = (await import('./lib/retention.js')).purgeExpiredTickets;

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    ctx.wsId = wsId;
    const [{ provision_brand: wsHold }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slugHold}, ${slugHold}) as provision_brand`;
    ctx.wsHold = wsHold;

    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    const [roRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and coalesce(is_admin,false) = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${agent.userId}, ${roRole.id}, true)`;

    // Main workspace: 1-year window. Hold workspace: NULL (purge disabled).
    await sql`update workspaces set retention_days = 365 where id = ${wsId}`;
    await sql`update workspaces set retention_days = null where id = ${wsHold}`;

    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    ctx.expired = await seedTicket(wsId, 'TK-old-' + slug, daysAgo(800));   // > 365 → purge
    ctx.recent = await seedTicket(wsId, 'TK-new-' + slug, daysAgo(10));     // < 365 → keep
    ctx.open = await seedTicket(wsId, 'TK-open-' + slug, null);            // unresolved → keep
    ctx.held = await seedTicket(wsHold, 'TK-hold-' + slugHold, daysAgo(5000)); // purge disabled → keep
  });

  afterAll(async () => {
    if (!sql) return;
    for (const id of [ctx.wsId, ctx.wsHold].filter(Boolean)) await sql`delete from workspaces where id = ${id}`;
    const ids = [admin.userId, agent.userId].filter(Boolean);
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('defaults retention_days to 1825 (5 years)', async () => {
    // Fresh workspace (provisioned without an override) carries the column default.
    const [{ provision_brand: fresh }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'ret-def-' + RUN}, ${'ret-def-' + RUN}) as provision_brand`;
    const [w] = await sql<{ retention_days: number }[]>`select retention_days from workspaces where id = ${fresh}`;
    expect(w.retention_days).toBe(1825);
    await sql`delete from workspaces where id = ${fresh}`;
  });

  it('purges only expired resolved tickets, cascading their children and deleting their R2 objects', async () => {
    const before = await sql<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${ctx.expired}`;
    expect(before[0].n).toBe(1);
    // An attachment on the expiring ticket and one on a surviving ticket: only
    // the former's object key must reach the deleter.
    const expiredKey = `att/${ctx.wsId}/${ctx.expired}/k1/old.pdf`;
    const keptKey = `att/${ctx.wsId}/${ctx.recent}/k2/new.pdf`;
    await sql`insert into ticket_attachments (workspace_id, ticket_id, filename, storage_key) values (${ctx.wsId}, ${ctx.expired}, 'old.pdf', ${expiredKey})`;
    await sql`insert into ticket_attachments (workspace_id, ticket_id, filename, storage_key) values (${ctx.wsId}, ${ctx.recent}, 'new.pdf', ${keptKey})`;
    const deleted: string[] = [];

    const { purgedTickets, objectsDeleted, objectsFailed } = await purgeExpiredTickets(500, { deleteObjects: async (keys) => { deleted.push(...keys); } });
    expect(purgedTickets).toBeGreaterThanOrEqual(1);
    expect(deleted).toContain(expiredKey);
    expect(deleted).not.toContain(keptKey);
    expect(objectsDeleted).toBeGreaterThanOrEqual(1);
    expect(objectsFailed).toBe(0);
    // Successful deletes leave nothing in the outbox.
    const outbox = await sql<{ n: number }[]>`select count(*)::int as n from pending_object_deletions where storage_key = ${expiredKey}`;
    expect(outbox[0].n).toBe(0);

    const survivors = await sql<{ id: string }[]>`select id from tickets where workspace_id = ${ctx.wsId}`;
    const ids = survivors.map((r) => r.id);
    expect(ids).not.toContain(ctx.expired);   // expired → gone
    expect(ids).toContain(ctx.recent);        // within window → kept
    expect(ids).toContain(ctx.open);          // unresolved → never purged

    // Child messages of the purged ticket are gone (FK cascade).
    const after = await sql<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${ctx.expired}`;
    expect(after[0].n).toBe(0);
  });

  it('purges a large backlog across multiple batches', async () => {
    // Fresh workspace so the count is exact regardless of other tests' data.
    const bslug = `ret-batch-${RUN}`;
    const [{ provision_brand: wsB }] = await sql<{ provision_brand: string }[]>`select provision_brand(${bslug}, ${bslug}) as provision_brand`;
    await sql`update workspaces set retention_days = 365 where id = ${wsB}`;
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const N = 5;
    for (let i = 0; i < N; i++) await seedTicket(wsB, `TK-batch-${i}-${bslug}`, daysAgo(800));

    // batchSize 2 forces multiple iterations (ceil(5/2) = 3 batches).
    const before = await sql<{ n: number }[]>`select count(*)::int as n from tickets where workspace_id = ${wsB}`;
    expect(before[0].n).toBe(N);
    const { purgedTickets } = await purgeExpiredTickets(2);
    expect(purgedTickets).toBeGreaterThanOrEqual(N);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from tickets where workspace_id = ${wsB}`;
    expect(after[0].n).toBe(0);

    await sql`delete from workspaces where id = ${wsB}`;
  });

  it('parks object keys when storage is down and the retry sweep clears them', async () => {
    const pslug = `ret-park-${RUN}`;
    const [{ provision_brand: wsP }] = await sql<{ provision_brand: string }[]>`select provision_brand(${pslug}, ${pslug}) as provision_brand`;
    await sql`update workspaces set retention_days = 365 where id = ${wsP}`;
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const tid = await seedTicket(wsP, `TK-park-${pslug}`, daysAgo(800));
    const key = `att/${wsP}/${tid}/k3/park.pdf`;
    await sql`insert into ticket_attachments (workspace_id, ticket_id, filename, storage_key) values (${wsP}, ${tid}, 'park.pdf', ${key})`;

    // Storage unavailable: rows are still purged, the key stays in the outbox
    // with the attempt recorded.
    const { objectsFailed } = await purgeExpiredTickets(500, { deleteObjects: async () => { throw new Error('R2 unavailable'); } });
    expect(objectsFailed).toBeGreaterThanOrEqual(1);
    const [{ n: ticketsLeft }] = await sql<{ n: number }[]>`select count(*)::int as n from tickets where id = ${tid}`;
    expect(ticketsLeft).toBe(0);
    const parked = await sql<{ storage_key: string; attempts: number; last_error: string | null }[]>`
      select storage_key, attempts, last_error from pending_object_deletions where storage_key = ${key}
    `;
    expect(parked).toHaveLength(1);
    expect(parked[0].attempts).toBe(1);
    expect(parked[0].last_error).toBe('R2 unavailable');

    // The retention-cron retry sweep deletes the parked object and clears the row.
    const { retryPendingObjectDeletions } = await import('./lib/gdpr-erasure.js');
    const retried: string[] = [];
    const res = await retryPendingObjectDeletions(100, { deleteObjects: async (keys) => { retried.push(...keys); } });
    expect(retried).toContain(key);
    expect(res.parkedKeysDeleted).toBeGreaterThanOrEqual(1);
    const after = await sql<{ storage_key: string }[]>`select storage_key from pending_object_deletions where storage_key = ${key}`;
    expect(after).toHaveLength(0);

    await sql`delete from workspaces where id = ${wsP}`;
  });

  it('stops draining when the time budget is spent and leaves the rest in the outbox', async () => {
    const { drainObjectDeletions } = await import('./lib/object-outbox.js');
    const keys = Array.from({ length: 40 }, (_, i) => `att/${ctx.wsId}/budget/${i}.pdf`);
    await sql`insert into pending_object_deletions (storage_key, reason) select k, 'retention' from unnest(${keys}::text[]) as k`;
    // A 1 ms budget with a deleter that sleeps: the first batch runs (the
    // deadline is only checked between batches), everything after it is
    // deferred. Deterministic under load — a slow machine only defers sooner.
    const res = await drainObjectDeletions(keys, async () => { await new Promise((r) => setTimeout(r, 5)); }, { budgetMs: 1 });
    expect(res.deferred.length).toBeGreaterThan(0);
    expect(res.deleted.length).toBeLessThan(keys.length);
    expect(res.deleted.length + res.failed.length + res.deferred.length).toBe(keys.length);
    // Deferred keys are still queued for the next run.
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pending_object_deletions where storage_key = any(${res.deferred})`;
    expect(n).toBe(res.deferred.length);
    await sql`delete from pending_object_deletions where storage_key = any(${keys})`;
  });

  it('reports keys that keep failing so the cron can alert instead of retrying forever', async () => {
    const { listStuckKeys, sweepPendingObjectDeletions, STUCK_ATTEMPTS } = await import('./lib/object-outbox.js');
    const key = `att/${ctx.wsId}/stuck/never.pdf`;
    await sql`insert into pending_object_deletions (storage_key, reason) values (${key}, 'retention')`;
    for (let i = 0; i < STUCK_ATTEMPTS; i++) {
      await sweepPendingObjectDeletions(50, async () => { throw new Error('403 forbidden'); });
    }
    const stuck = await listStuckKeys();
    const mine = stuck.find((s) => s.storage_key === key);
    expect(mine).toBeTruthy();
    expect(mine!.attempts).toBeGreaterThanOrEqual(STUCK_ATTEMPTS);
    expect(mine!.last_error).toBe('403 forbidden');
    // Still deletable once storage recovers.
    const ok = await sweepPendingObjectDeletions(50, async () => {});
    expect(ok.deleted).toContain(key);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pending_object_deletions where storage_key = ${key}`;
    expect(n).toBe(0);
  });

  it('never purges a workspace with retention disabled (NULL)', async () => {
    await purgeExpiredTickets();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from tickets where id = ${ctx.held}`;
    expect(n).toBe(1); // 5000 days old but purge disabled → retained
  });

  it('admins can configure the window; non-admins cannot', async () => {
    const forbidden = await as(agent.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ retention_days: 730 }) });
    expect(forbidden.status).toBe(403);
    const ok = await as(admin.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ retention_days: 730 }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).workspace.retention_days).toBe(730);
    // Below the floor is rejected.
    const tooLow = await as(admin.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ retention_days: 5 }) });
    expect(tooLow.status).toBe(400);
  });
});
