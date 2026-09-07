// lib/player-identity — automatic contact ↔ Maestro player linking.
//
// The gateway is stubbed via globalThis.fetch (the convention for Maestro in
// this suite — lib/maestro.js is never mocked). MAESTRO_API_TOKEN comes from
// test-setup.ts (the bun preload) so workerMaestroConfigured() is true.
//
// DB-backed part — local recipe:
//   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=maestro_test -p 5432:5432 postgres:17
//   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/maestro_test?sslmode=disable' bun run migrate
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/player-identity.test.ts

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { memberNotFound } from './lib/player-identity.js';

describe('memberNotFound', () => {
  it('treats the 200 not-found envelope and empty bodies as not found', () => {
    expect(memberNotFound(null)).toBe(true);
    expect(memberNotFound(undefined)).toBe(true);
    expect(memberNotFound({ success: false })).toBe(true);
    expect(memberNotFound({ errorCode: 101 })).toBe(true);
    expect(memberNotFound({ userId: 'u1', email: 'a@b.c' })).toBe(false);
  });
});

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('player identity linking (DB-backed)', () => {
  type Lib = typeof import('./lib/player-identity.js');
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let lib: Lib;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let agentToken = '';

  const RUN = Date.now();
  const brand = randomUUID();
  let ws = '';        // a Maestro-brand workspace
  let wsNoBrand = ''; // a legacy / non-Maestro workspace
  const createdUserIds: string[] = [];
  const realFetch = globalThis.fetch;

  // Every stubbed gateway call is recorded (url + X-Brand-Id) so tests can
  // assert WHETHER we called out and WHICH brand we scoped the lookup to.
  let calls: { url: string; brandId: string | null }[] = [];
  function stubGateway(body: Record<string, unknown> | null, status = 200) {
    calls = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, brandId: new Headers(init?.headers).get('x-brand-id') });
      const payload = body ?? { success: false, errorCode: 101 };
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  const PLAYER = {
    userId: 'a1b2c3d4-user-0001', memberId: 4711, username: 'ferit_bey',
    firstName: 'S. Ferit', lastName: 'Arslan', email: `player-${RUN}@example.test`,
    vipLevel: 'Gold', country: 'TR', mobile: '+90 555 123 4567', balance: '12.50', balanceCy: 'EUR',
  };

  async function mkCustomer(wsId: string, email: string | null, extra: Record<string, unknown> = {}): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers ${sql({
        workspace_id: wsId,
        display_id: 'M-' + randomUUID().slice(0, 8),
        first_name: 'Stub', last_name: 'Contact',
        email,
        ...extra,
      })}
      returning id
    `;
    return row.id;
  }
  async function row(id: string) {
    const [r] = await sql<{
      username: string | null; vip_tier: string | null; jurisdiction: string | null; brand: string | null; mobile: string | null;
      maestro_user_id: string | null; maestro_member_id: string | null; player_lookup_at: Date | null;
    }[]>`
      select username, vip_tier, jurisdiction, brand, mobile, maestro_user_id, maestro_member_id, player_lookup_at
      from customers where id = ${id}
    `;
    return r;
  }

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    lib = await import('./lib/player-identity.js');
    app = (await import('./index.js')).default as typeof app;
    const [{ a }] = await sql<{ a: string }[]>`select provision_brand(${'pi-' + RUN}, ${'pi-' + RUN}) as a`;
    const [{ b }] = await sql<{ b: string }[]>`select provision_brand(${'pinb-' + RUN}, ${'pinb-' + RUN}) as b`;
    ws = a; wsNoBrand = b;
    await sql`update workspaces set maestro_brand_id = ${brand} where id = ${ws}`;
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `pi-refresh-${RUN}@t.test`, password: 'password-12345', name: 'Agent' }, returnHeaders: true });
    agentToken = signed.response.token;
    createdUserIds.push(signed.response.user.id);
    const [role] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${signed.response.user.id}, ${role.id}, true)`;
  }, 30000);

  afterEach(() => { globalThis.fetch = realFetch; });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!sql) return;
    for (const id of [ws, wsNoBrand].filter(Boolean)) {
      await sql`delete from gdpr_erasures where workspace_id = ${id}`;
      await sql`delete from customers where workspace_id = ${id}`;
      await sql`delete from workspaces where id = ${id}`;
    }
    if (createdUserIds.length) await sql`delete from users where id in ${sql(createdUserIds)}`;
  });

  it('links ids, fills blank username/VIP/country, scopes the lookup to the workspace brand, and audits as system', async () => {
    stubGateway(PLAYER);
    const id = await mkCustomer(ws, PLAYER.email);

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('linked');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/v1/proxy/member/lookup');
    expect(calls[0].brandId).toBe(brand);

    const r = await row(id);
    expect(r.maestro_user_id).toBe(PLAYER.userId);
    expect(r.maestro_member_id).toBe('4711');       // numeric → text
    expect(r.username).toBe('ferit_bey');
    expect(r.vip_tier).toBe('Gold');
    expect(r.jurisdiction).toBe('TR');
    expect(r.brand).toBe('pi-' + RUN);
    expect(r.mobile).toBe(PLAYER.mobile);
    expect(r.player_lookup_at).not.toBeNull();

    const audits = await sql<{ actor_user_id: string | null; metadata: Record<string, unknown> }[]>`
      select actor_user_id, metadata from audit_events
      where workspace_id = ${ws} and action = 'customer.player_linked' and target_id = ${id}
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_user_id).toBeNull();
    expect(audits[0].metadata.brand_id).toBe(brand);
    expect(audits[0].metadata.reason).toBe('inbound_email');
    expect(audits[0].metadata.accessed).toEqual(['contact', 'vip']);
    // Never the values themselves.
    expect(JSON.stringify(audits[0].metadata)).not.toContain('12.50');
  });

  it('never overwrites an agent-entered username / VIP / country', async () => {
    const email = `typed-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email });
    const id = await mkCustomer(ws, email, { username: 'agent_typed', vip_tier: 'Platinum', jurisdiction: 'MT' });

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'portal' })).toBe('linked');

    const r = await row(id);
    expect(r.maestro_user_id).toBe(PLAYER.userId);
    expect(r.username).toBe('agent_typed');
    expect(r.vip_tier).toBe('Platinum');
    expect(r.jurisdiction).toBe('MT');
  });

  it('not-found stamps the lookup and is not re-asked within the TTL', async () => {
    stubGateway(null);   // { success:false, errorCode:101 }
    const email = `nobody-${RUN}@example.test`;
    const id = await mkCustomer(ws, email);

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('not_found');
    expect(calls).toHaveLength(1);
    let r = await row(id);
    expect(r.maestro_user_id).toBeNull();
    expect(r.player_lookup_at).not.toBeNull();

    // Second email the same day: no gateway call at all (even though the
    // player now "exists" upstream).
    stubGateway({ ...PLAYER, email });
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('skipped');
    expect(calls).toHaveLength(0);

    // Once the stamp is older than the TTL we ask again.
    await sql`update customers set player_lookup_at = now() - interval '2 days' where id = ${id}`;
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('linked');
    r = await row(id);
    expect(r.maestro_user_id).toBe(PLAYER.userId);
  });

  it('rejects a member matched on username rather than email (nothing written, lookup stamped)', async () => {
    // The gateway's `email` param also matches usernames: a contact whose
    // address equals some player's username must NOT be linked to that player.
    stubGateway({ ...PLAYER, email: 'someone-else@example.test' });
    const id = await mkCustomer(ws, `lookalike-${RUN}@example.test`);

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('email_mismatch');
    const r = await row(id);
    expect(r.maestro_user_id).toBeNull();
    expect(r.username).toBeNull();
    expect(r.player_lookup_at).not.toBeNull();
  });

  it('matches the email case-insensitively', async () => {
    const email = `case-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email: email.toUpperCase() });
    const id = await mkCustomer(ws, email);
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'backfill' })).toBe('linked');
  });

  it('skips erased, merged-away, complete linked and unlinked email-less contacts without calling the gateway', async () => {
    stubGateway(PLAYER);
    const survivor = await mkCustomer(ws, `surv-${RUN}@example.test`);
    const erased = await mkCustomer(ws, null, { erased_at: new Date() });
    const merged = await mkCustomer(ws, `merged-${RUN}@example.test`, { merged_into_customer_id: survivor });
    const linked = await mkCustomer(ws, `linked-${RUN}@example.test`, {
      maestro_user_id: 'already', username: 'saved', vip_tier: 'Gold', jurisdiction: 'TR', brand: 'Saved brand', mobile: '+90 1',
    });
    const noEmail = await mkCustomer(ws, null);

    for (const id of [erased, merged, linked, noEmail]) {
      expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'backfill' })).toBe('skipped');
    }
    expect(calls).toHaveLength(0);
    expect((await row(linked)).maestro_user_id).toBe('already');
  });

  it('no-ops for a workspace that is not a Maestro brand', async () => {
    stubGateway(PLAYER);
    const id = await mkCustomer(wsNoBrand, PLAYER.email);
    expect(await lib.linkCustomerToPlayer({ workspaceId: wsNoBrand, customerId: id, reason: 'inbound_email' })).toBe('no_brand');
    expect(calls).toHaveLength(0);
    expect((await row(id)).maestro_user_id).toBeNull();
  });

  it('a gateway error is reported as failed and NOT stamped, so the next email retries', async () => {
    stubGateway({ error: 'boom' }, 500);
    const id = await mkCustomer(ws, `outage-${RUN}@example.test`);
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('failed');
    const r = await row(id);
    expect(r.maestro_user_id).toBeNull();
    expect(r.player_lookup_at).toBeNull();
  });

  it('applyPlayerToCustomer never touches an erased profile', async () => {
    const id = await mkCustomer(ws, null, { erased_at: new Date() });
    expect(await lib.applyPlayerToCustomer(sql, { workspaceId: ws, customerId: id, member: PLAYER })).toBe(false);
    expect((await row(id)).maestro_user_id).toBeNull();
  });

  it('records the triggering agent as the audit actor when one is given (contact edits)', async () => {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email: `pi-agent-${RUN}@t.test`, password: 'password-12345', name: 'A' }, returnHeaders: true });
    const agentId: string = r.response.user.id;
    createdUserIds.push(agentId);

    const email = `actor-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email });
    const id = await mkCustomer(ws, email);
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, email, actorUserId: agentId, reason: 'contact_edit' })).toBe('linked');

    const [audit] = await sql<{ actor_user_id: string | null; metadata: Record<string, unknown> }[]>`
      select actor_user_id, metadata from audit_events
      where workspace_id = ${ws} and action = 'customer.player_linked' and target_id = ${id}
    `;
    expect(audit.actor_user_id).toBe(agentId);
    expect(audit.metadata.reason).toBe('contact_edit');
  });

  it('links on the address that wrote in, not only the primary mirror', async () => {
    // Casino login is a SECONDARY address; the primary has no Maestro account.
    const primary = `primary-${RUN}@example.test`;
    const secondary = `login-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email: secondary });
    const id = await mkCustomer(ws, primary);
    await sql`insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary) values (${ws}, ${id}, 'email', ${secondary}, false)`;

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, email: secondary, reason: 'inbound_email' })).toBe('linked');
    expect(calls[0].url).toContain(encodeURIComponent(secondary));
    expect((await row(id)).maestro_user_id).toBe(PLAYER.userId);
  });

  it('a member record without a userId is unlinkable: stamped, nothing written, no audit', async () => {
    const email = `nouid-${RUN}@example.test`;
    const { userId: _omit, ...noId } = PLAYER;
    stubGateway({ ...noId, email });
    const id = await mkCustomer(ws, email);

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('no_player_id');
    const r = await row(id);
    expect(r.maestro_user_id).toBeNull();
    expect(r.maestro_member_id).toBeNull();
    expect(r.username).toBeNull();
    expect(r.player_lookup_at).not.toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from audit_events where action = 'customer.player_linked' and target_id = ${id}`;
    expect(n).toBe(0);
  });

  it('applyPlayerToCustomer never re-points a contact that is already linked to another player', async () => {
    const id = await mkCustomer(ws, `repoint-${RUN}@example.test`, { maestro_user_id: 'player-A', maestro_member_id: '1', vip_tier: null });
    const other = { ...PLAYER, userId: 'player-B', memberId: 2, email: `repoint-${RUN}@example.test` };
    expect(await lib.applyPlayerToCustomer(sql, { workspaceId: ws, customerId: id, member: other })).toBe(false);
    const r = await row(id);
    expect(r.maestro_user_id).toBe('player-A');
    expect(r.maestro_member_id).toBe('1');
    expect(r.vip_tier).toBeNull();   // not even blanks are filled from the wrong player
  });

  function refresh(id: string, workspaceId = ws, token = agentToken) {
    return app.request(`/api/v1/customers/${id}/refresh-account`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspaceId },
    });
  }

  it('refreshes an existing linked profile by stable ID, fills empty strings, and keeps one primary mobile', async () => {
    const id = await mkCustomer(ws, `old-email-${RUN}@example.test`, {
      maestro_user_id: PLAYER.userId, username: '  ', vip_tier: '', jurisdiction: '', brand: '',
    });
    stubGateway(PLAYER); // account email changed; identity still matches
    const response = await refresh(id);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.customer.vip_tier).toBe('Gold');
    expect(body.customer.jurisdiction).toBe('TR');
    expect(body.customer.brand).toBe('pi-' + RUN);
    expect(body.customer.mobile).toBe(PLAYER.mobile);
    expect(body.customer.mobiles).toHaveLength(1);
    expect(body.customer.mobiles[0].is_primary).toBe(true);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('maestroUserId')).toBe(PLAYER.userId);
    expect(url.searchParams.has('email')).toBe(false);
    expect(calls[0].brandId).toBe(brand);
    expect((await row(id)).mobile).toBe(PLAYER.mobile);
    const [audit] = await sql<{ action: string; actor_user_id: string }[]>`
      select action, actor_user_id from audit_events where target_id = ${id}
    `;
    expect(audit.action).toBe('customer.player_refreshed');
    expect(audit.actor_user_id).toBe(createdUserIds[0]);
    expect((await refresh(id)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('preserves agent values and existing primary and secondary mobile contacts during repair', async () => {
    const id = await mkCustomer(ws, `preserve-${RUN}@example.test`, {
      maestro_user_id: PLAYER.userId, username: 'agent', vip_tier: 'Silver', jurisdiction: 'MT',
      brand: 'Manual brand', mobile: '+44 111',
    });
    const { addContact } = await import('./lib/customer-contacts.js');
    await addContact(sql, { workspaceId: ws, customerId: id, kind: 'mobile', value: '+44 222' });
    expect(await lib.applyPlayerToCustomer(sql, { workspaceId: ws, customerId: id, member: PLAYER })).toBe(true);
    const saved = await row(id);
    expect(saved.username).toBe('agent');
    expect(saved.vip_tier).toBe('Silver');
    expect(saved.jurisdiction).toBe('MT');
    expect(saved.brand).toBe('Manual brand');
    expect(saved.mobile).toBe('+44 111');
    const contacts = await sql<{ value: string; is_primary: boolean }[]>`
      select value, is_primary from customer_contacts where customer_id = ${id} and kind = 'mobile' order by is_primary desc
    `;
    expect(contacts.map(c => c.value)).toEqual(['+44 111', '+44 222']);
    expect(contacts[0].is_primary).toBe(true);
  });

  it('throttles incomplete results and refreshes a linked profile without an email', async () => {
    const id = await mkCustomer(ws, null, { maestro_user_id: PLAYER.userId });
    stubGateway({ userId: PLAYER.userId });
    expect((await refresh(id)).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await row(id)).vip_tier).toBeNull();
    stubGateway(PLAYER);
    expect((await refresh(id)).status).toBe(200);
    expect(calls).toHaveLength(0);
    await sql`update customers set player_lookup_at = now() - interval '2 days' where id = ${id}`;
    expect((await refresh(id)).status).toBe(200);
    expect((await row(id)).vip_tier).toBe('Gold');
  });

  it('refuses a different player returned for a linked ID without copying any details', async () => {
    const id = await mkCustomer(ws, `mismatch-id-${RUN}@example.test`, { maestro_user_id: 'other-player' });
    stubGateway(PLAYER);
    expect((await refresh(id)).status).toBe(409);
    const saved = await row(id);
    expect(saved.maestro_user_id).toBe('other-player');
    expect(saved.vip_tier).toBeNull();
    expect(saved.mobile).toBeNull();
    expect(saved.brand).toBeNull();
  });

  it('keeps refresh failures visible and retryable without changing saved details', async () => {
    const id = await mkCustomer(ws, `failure-${RUN}@example.test`, { maestro_user_id: PLAYER.userId });
    stubGateway({ error: 'gateway unavailable' }, 503);
    expect((await refresh(id)).status).toBe(502);
    expect((await row(id)).player_lookup_at).toBeNull();
    stubGateway(PLAYER);
    expect((await refresh(id)).status).toBe(200);
    expect((await row(id)).vip_tier).toBe('Gold');
  });

  it('does not call Maestro for inaccessible, merged, erased or deleted profiles', async () => {
    const outside = await mkCustomer(wsNoBrand, `outside-${RUN}@example.test`);
    const survivor = await mkCustomer(ws, `refresh-survivor-${RUN}@example.test`);
    const merged = await mkCustomer(ws, `refresh-merged-${RUN}@example.test`, { merged_into_customer_id: survivor });
    const erased = await mkCustomer(ws, null, { erased_at: new Date() });
    const deleted = await mkCustomer(ws, `refresh-deleted-${RUN}@example.test`, { deleted_at: new Date() });
    stubGateway(PLAYER);
    for (const id of [outside, merged, erased, deleted, randomUUID(), 'invalid']) {
      expect((await refresh(id)).status).toBe(404);
    }
    expect((await refresh(survivor, ws, 'invalid-token')).status).toBe(401);
    expect((await refresh(outside, wsNoBrand)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('deduplicates concurrent refreshes and mobile creation', async () => {
    const id = await mkCustomer(ws, `parallel-${RUN}@example.test`, { maestro_user_id: PLAYER.userId });
    stubGateway(PLAYER);
    const results = await Promise.all(Array.from({ length: 3 }, () => lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'profile_open' })));
    expect(results).toEqual(['linked', 'linked', 'linked']);
    expect(calls).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from customer_contacts where customer_id = ${id} and kind = 'mobile'`;
    expect(n).toBe(1);
  });

  it('preserves edits committed while the account lookup was in flight', async () => {
    const id = await mkCustomer(ws, `race-edit-${RUN}@example.test`, { maestro_user_id: PLAYER.userId });
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { arrived = r; });
    globalThis.fetch = (async () => {
      arrived();
      await gate;
      return new Response(JSON.stringify(PLAYER), { status: 200 });
    }) as unknown as typeof fetch;
    const pending = lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'profile_open' });
    await started;
    try {
      await sql`update customers set vip_tier = 'Manual VIP', jurisdiction = 'MT', brand = 'Manual brand' where id = ${id}`;
      const { addContact } = await import('./lib/customer-contacts.js');
      await addContact(sql, { workspaceId: ws, customerId: id, kind: 'mobile', value: '+44 333' });
    } finally { release(); }
    await pending;
    const saved = await row(id);
    expect(saved.vip_tier).toBe('Manual VIP');
    expect(saved.jurisdiction).toBe('MT');
    expect(saved.brand).toBe('Manual brand');
    expect(saved.mobile).toBe('+44 333');
    expect(saved.username).toBe(PLAYER.username);
  });

  it('does not restore data or the lookup timestamp after an in-flight erasure', async () => {
    const id = await mkCustomer(ws, `race-erase-${RUN}@example.test`, { maestro_user_id: PLAYER.userId });
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { arrived = r; });
    globalThis.fetch = (async () => {
      arrived();
      await gate;
      return new Response(JSON.stringify(PLAYER), { status: 200 });
    }) as unknown as typeof fetch;
    const pending = lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'profile_open' });
    await started;
    try {
      const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
      await eraseCustomer({ workspaceId: ws, customerId: id, requestedByUserId: createdUserIds[0] });
    } finally { release(); }
    expect(await pending).toBe('skipped');
    const saved = await row(id);
    expect(saved.maestro_user_id).toBeNull();
    expect(saved.player_lookup_at).toBeNull();
    expect(saved.mobile).toBeNull();
    expect(saved.jurisdiction).toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from customer_contacts where customer_id = ${id}`;
    expect(n).toBe(0);
  });

  it('uses the same field mapping and workspace brand when creating a customer from a player', async () => {
    stubGateway({ ...PLAYER, email: `create-${RUN}@example.test`, vipLevel: null, vipTier: 'Platinum' });
    const response = await app.request('/api/v1/customers/from-player', {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'X-Workspace-Id': ws, 'X-Brand-Id': brand, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `create-${RUN}@example.test` }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    const saved = await row(body.customer.id);
    expect(saved.vip_tier).toBe('Platinum');
    expect(saved.brand).toBe('pi-' + RUN);
    expect(saved.mobile).toBe(PLAYER.mobile);
    expect(saved.jurisdiction).toBe('TR');
  });

  it('backfill aborts (throws) after consecutive gateway failures instead of looping on a dead token', async () => {
    stubGateway({ error: 'gateway down' }, 503);
    const ids: string[] = [];
    for (let i = 0; i < lib.BACKFILL_ABORT_AFTER_FAILURES + 1; i++) ids.push(await mkCustomer(ws, `dead-${i}-${RUN}@example.test`));

    // NOTE: not `expect(promise).rejects` — under bun:test that matcher stalls
    // the socket I/O the job's own DB queries need (the run never completes).
    // Await it in a try/catch instead.
    let thrown: unknown = null;
    try {
      await lib.runPlayerIdentityBackfillJob({ concurrency: 2 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/consecutive gateway failures/);
    // Nothing stamped — a fixed token makes the next run pick them all up again.
    for (const id of ids) expect((await row(id)).player_lookup_at).toBeNull();
    // Clean up so the convergence test below starts from a known state.
    await sql`delete from customers where id in ${sql(ids)}`;
  });

  it('backfill honours the per-call maxAttempts cap and reports the rest as remaining', async () => {
    const email = `cap-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email });   // only `first` matches; the others mismatch → stamped
    const first = await mkCustomer(ws, email);
    const others: string[] = [];
    for (let i = 0; i < 4; i++) others.push(await mkCustomer(ws, `cap-${i}-${RUN}@example.test`));

    // Earlier tests leave a few unlinked, un-stamped rows behind (e.g. the
    // 'failed' outage contact, by design), so assert relative to the live count.
    const [{ before }] = await sql<{ before: number }[]>`
      select count(*)::int as before from customers
      where workspace_id = ${ws} and maestro_user_id is null and email is not null and player_lookup_at is null
        and erased_at is null and deleted_at is null and merged_into_customer_id is null`;
    expect(before).toBeGreaterThanOrEqual(5);

    const r = await lib.runPlayerIdentityBackfillJob({ maxAttempts: 2, concurrency: 1 });
    expect(r.attempted).toBe(2);
    expect(r.remaining).toBe(before - 2);

    // Drain the rest so the convergence test below starts clean.
    const r2 = await lib.runPlayerIdentityBackfillJob({ maxAttempts: 500, concurrency: 2 });
    expect(r2.attempted).toBe(before - 2);
    expect(r2.remaining).toBe(0);
    expect((await row(first)).maestro_user_id).toBe(PLAYER.userId);
    await sql`delete from customers where id in ${sql([first, ...others])}`;
  });

  it('backfill stops at its deadline without touching anything and reports remaining', async () => {
    stubGateway(PLAYER);
    const id = await mkCustomer(ws, `deadline-${RUN}@example.test`);
    const r = await lib.runPlayerIdentityBackfillJob({ deadlineMs: 0, concurrency: 1 });
    expect(r.attempted).toBe(0);
    expect(r.remaining).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(0);
    expect((await row(id)).player_lookup_at).toBeNull();
    await sql`delete from customers where id = ${id}`;
  });

  it('a second backfill while one is running is rejected (advisory lock, any process)', async () => {
    // Slow gateway: hold the first run open long enough to start a second.
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    globalThis.fetch = (async () => {
      await gate;
      return new Response(JSON.stringify({ success: false, errorCode: 101 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const id = await mkCustomer(ws, `lock-${RUN}@example.test`);

    const running = lib.runPlayerIdentityBackfillJob({ concurrency: 1 });
    await new Promise((r) => setTimeout(r, 150));   // let it take the lock and reach the gateway
    let busy: unknown = null;
    try { await lib.runPlayerIdentityBackfillJob({ concurrency: 1 }); } catch (err) { busy = err; }
    expect(busy).toBeInstanceOf(lib.BackfillBusyError);

    release();
    const done = await running;
    expect(done.notFound).toBeGreaterThanOrEqual(1);
    // Lock released → a third run is accepted again.
    const again = await lib.runPlayerIdentityBackfillJob({ concurrency: 1 });
    expect(again.attempted).toBe(0);
    await sql`delete from customers where id = ${id}`;
  });

  it('backfill walks only brand workspaces, links what it can, and converges to remaining = 0', async () => {
    // Fresh candidates: everything above is linked or stamped, so it is out of
    // scope for the backfill by construction. Add three new ones.
    const email = `backfill-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email });
    const a = await mkCustomer(ws, email);                              // will link
    const b = await mkCustomer(ws, `stranger-${RUN}@example.test`);     // mismatch → stamped
    const c = await mkCustomer(wsNoBrand, email);                       // not a brand workspace → ignored

    const first = await lib.runPlayerIdentityBackfillJob({ concurrency: 2 });
    // Other workspaces in a shared test DB may add to `workspaces`/`attempted`,
    // so assert on OUR rows and on convergence, not on absolute totals.
    expect(first.workspaces).toBeGreaterThanOrEqual(1);
    expect(first.attempted).toBeGreaterThanOrEqual(2);
    expect(first.failed).toBe(0);
    expect(first.remaining).toBe(0);
    expect((await row(a)).maestro_user_id).toBe(PLAYER.userId);
    expect((await row(b)).maestro_user_id).toBeNull();
    expect((await row(b)).player_lookup_at).not.toBeNull();
    expect((await row(c)).maestro_user_id).toBeNull();
    expect((await row(c)).player_lookup_at).toBeNull();

    // Idempotent: a second run has nothing left for OUR rows (other suites in
    // a shared DB may contribute candidates, so assert convergence + our rows).
    stubGateway({ ...PLAYER, email });
    const second = await lib.runPlayerIdentityBackfillJob();
    expect(second.remaining).toBe(0);
    expect((await row(b)).maestro_user_id).toBeNull();
  });
});
