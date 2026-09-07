// Exercise real PostgreSQL decoding and assignment, not string-only mocks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('date-only values (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let workspaceId: string;
  let userId: string;
  let token: string;
  let ticketId: string;
  const run = randomUUID();

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const signup = await auth.api.signUpEmail({
      body: { email: `date-${run}@t.test`, password: 'password-12345', name: 'Date test' },
    });
    userId = signup.user.id;
    token = signup.token!;
    const [ws] = await sql`select provision_brand(${'date-' + run}, ${'date-' + run}) as id`;
    workspaceId = ws.id;
    const [role] = await sql`select id from roles where workspace_id = ${workspaceId} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active)
      values (${workspaceId}, ${userId}, ${role.id}, true)`;
    const [customer] = await sql`insert into customers (workspace_id, display_id, first_name)
      values (${workspaceId}, 'DATE-CUSTOMER', 'Date test') returning id`;
    const [ticket] = await sql`insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${workspaceId}, 'DATE-1', 'Date assignment', ${customer.id}, 'open', 'normal') returning id`;
    ticketId = ticket.id;
    await sql`delete from assign_rules where workspace_id = ${workspaceId}`;
    await sql`insert into assign_rules (workspace_id, display_id, name, priority, conditions, assignment)
      values (${workspaceId}, 'DATE-RULE', 'Date assignment', 1, '{}'::jsonb, '{}'::jsonb)`;
  }, 30000);

  afterAll(async () => {
    if (workspaceId) await sql`delete from workspaces where id = ${workspaceId}`;
    if (userId) await sql`delete from users where id = ${userId}`;
  });

  it('keeps leap dates, nulls and date arrays as calendar values while preserving timestamps', async () => {
    const [row] = await sql`select '2024-02-29'::date as day, null::date as empty,
      array['2024-02-29'::date, '2026-12-25'::date, null] as holidays,
      '2026-09-07 12:34:56+00'::timestamptz as instant,
      '2026-09-07 12:34:56'::timestamp as local_time`;
    expect(row.day).toBe('2024-02-29');
    expect(row.empty).toBeNull();
    expect(row.holidays).toEqual(['2024-02-29', '2026-12-25', null]);
    expect(row.instant).toBeInstanceOf(Date);
    expect(row.instant.toISOString()).toBe('2026-09-07T12:34:56.000Z');
    expect(row.local_time).toBeInstanceOf(Date);
    const [roundTrip] = await sql`select ${row.day}::date as day`;
    expect(roundTrip.day).toBe(row.day);
  });

  it('returns agent dates ready for date inputs, including null end dates', async () => {
    await sql`update workspace_members set ooo_from = '2024-02-29', ooo_to = null
      where workspace_id = ${workspaceId} and user_id = ${userId}`;
    const res = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspaceId },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      agents: { user_id: string; ooo_from: string | null; ooo_to: string | null }[];
    };
    const agent = body.agents.find((row) => row.user_id === userId);
    expect(agent).toBeDefined();
    expect(agent?.ooo_from).toBe('2024-02-29');
    expect(agent?.ooo_to).toBeNull();
  });

  for (const mode of ['specific-agent', 'round-robin', 'least-busy']) {
    it(`${mode} respects absence boundaries and open-ended leave`, async () => {
      const { applyAssignmentRules } = await import('./lib/assign-rules-engine.js');
      // Match the engine's existing server-local calendar, without freezing auth timers.
      const today = new Date();
      const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const assignment = { mode, agent_user_id: userId, team_user_ids: [userId], rr_index: 0 };
      await sql`update assign_rules set assignment = ${sql.json(assignment)} where workspace_id = ${workspaceId}`;
      const cases: [string | null, string | null, boolean][] = [
        [null, null, true],
        ['2999-01-01', '2999-01-02', true],
        ['2000-01-01', '2000-01-02', true],
        [key, key, false],
        ['2000-01-01', key, false],
        [key, '2999-01-01', false],
        ['2000-01-01', null, false],
        ['2999-01-01', null, true],
      ];
      for (const [from, to, eligible] of cases) {
        await sql`update workspace_members set ooo_from = ${from}, ooo_to = ${to}
          where workspace_id = ${workspaceId} and user_id = ${userId}`;
        await sql`update tickets set assigned_user_id = null where id = ${ticketId}`;
        const result = await applyAssignmentRules({ workspaceId, ticketId });
        expect(result?.assigned_user_id ?? null).toBe(eligible ? userId : null);
        const [ticket] = await sql`select assigned_user_id from tickets where id = ${ticketId}`;
        expect(ticket.assigned_user_id).toBe(eligible ? userId : null);
      }
    });
  }
});
