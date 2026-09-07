// POST /api/v1/customers/:id/merge + /unmerge — server-side profile merge
// with journal, auto notes, conditional backfill revert, and audit. Gated by
// the can_delete capability (Phase-2 decision: not admin-only).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('customer merge/unmerge (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const realFetch = globalThis.fetch;

  const RUN = Date.now();
  const admin = { email: `cm-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `cm-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string, wsId: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }
  async function mkCustomer(tag: string, extra: Record<string, string | null> = {}): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers ${sql({
        workspace_id: ctx.ws,
        display_id: 'M-' + tag + '-' + RUN,
        first_name: 'C', last_name: tag,
        email: `cm-${tag}-${RUN}@cust.test`,
        ...extra,
      })}
      returning id
    `;
    return row.id;
  }
  async function mkTicket(customerId: string, subject: string): Promise<string> {
    const { nextDisplayId } = await import('./lib/display-id.js');
    const displayId = await nextDisplayId(sql, ctx.ws, 'ticket');
    const [row] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ctx.ws}, ${displayId}, ${subject}, ${customerId}, 'open', 'normal')
      returning id
    `;
    return row.id;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'cm-' + RUN}, ${'cm-' + RUN}) as provision_brand`;
    ctx.ws = ws;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    const [plainRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and name = 'Read Only' limit 1`;
    ctx.plainRoleId = plainRole.id;
    const [cleaner] = await sql<{ id: string }[]>`
      insert into roles (workspace_id, name, is_admin, can_delete) values (${ws}, ${'Cleaner-' + RUN}, false, true) returning id
    `;
    ctx.cleanerRoleId = cleaner.id;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${agent.userId}, ${plainRole.id}, true)`;
  }, 30000);

  beforeEach(() => {
    // Double cast: the stub omits fetch.preconnect, which the DOM lib now
    // declares on typeof fetch. Nothing under test calls it.
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await sql`delete from workspaces where id = ${ctx.ws}`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId})`;
  }, 15000);

  it('merges: tickets move stamped, messages untouched, notes move, auto note, backfill (never email), journal + audit', async () => {
    const src = await mkCustomer('src', { mobile: '+4477001', vip_tier: 'Gold', since: '2020-03-15', maestro_user_id: 'mu-src-0001', maestro_member_id: '4711' });
    const pri = await mkCustomer('pri', { mobile: null, vip_tier: null });
    ctx.src = src; ctx.pri = pri;

    const t1 = await mkTicket(src, 'from source');
    ctx.movedTicket = t1;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
              values (${ctx.ws}, ${t1}, 'customer', 'Cust', 'original email', ${'mid-' + RUN})`;
    const [msgBefore] = await sql<{ created_at: string }[]>`select created_at from ticket_messages where ticket_id = ${t1} and role = 'customer'`;
    await sql`insert into customer_notes (workspace_id, customer_id, author_user_id, text)
              values (${ctx.ws}, ${src}, ${admin.userId}, 'source note')`;

    const res = await as(admin.token, ctx.ws, `/api/v1/customers/${src}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: pri }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tickets_moved_ids).toContain(t1);
    // Contacts model: mobile is no longer a scalar backfill — it MOVED as a
    // contact row and, the survivor having no mobile, was promoted to primary
    // (so the survivor's mirror still gains it, exactly as the backfill did).
    expect(body.backfilled_fields.mobile).toBeUndefined();
    expect(body.backfilled_fields.vip_tier).toBe('Gold');
    // Maestro ids are backfillable text columns like the rest.
    expect(body.backfilled_fields.maestro_user_id).toBe('mu-src-0001');
    expect(body.backfilled_fields.maestro_member_id).toBe('4711');
    expect(body.backfilled_fields.email).toBeUndefined();
    expect(body.contacts_moved).toBe(2); // the source's email + mobile
    expect(body.primary.mobile).toBe('+4477001');
    expect(body.primary.email).toBe(`cm-pri-${RUN}@cust.test`);          // survivor's own primary wins
    const movedEmail = body.primary.emails.find((e: any) => e.value === `cm-src-${RUN}@cust.test`);
    expect(movedEmail.is_primary).toBe(false);                             // arrives as a secondary
    expect(movedEmail.merged_from_customer_id).toBe(src);
    expect(body.primary.mobiles.find((m: any) => m.value === '+4477001').is_primary).toBe(true);
    // The merged-away source still DISPLAYS its addresses (derived from the
    // stamped rows now living on the survivor) even though its DB mirror is null.
    expect(body.source.email).toBe(`cm-src-${RUN}@cust.test`);
    expect(body.source.emails[0].on_survivor).toBe(true);
    // DATE column rides as plain YYYY-MM-DD, never a TZ-shifted
    // ISO timestamp — the journal's unmerge equality depends on it.
    expect(body.backfilled_fields.since).toBe('2020-03-15');

    // Ticket moved with the stamp; its message rows untouched.
    const [t1row] = await sql<{ customer_id: string; pre_merge_customer_id: string }[]>`
      select customer_id, pre_merge_customer_id from tickets where id = ${t1}
    `;
    expect(t1row.customer_id).toBe(pri);
    expect(t1row.pre_merge_customer_id).toBe(src);
    const [msgAfter] = await sql<{ created_at: string; external_message_id: string }[]>`
      select created_at, external_message_id from ticket_messages where ticket_id = ${t1} and role = 'customer'
    `;
    expect(msgAfter.created_at).toEqual(msgBefore.created_at);
    expect(msgAfter.external_message_id).toBe('mid-' + RUN);
    // System marker landed on the moved live ticket.
    const [marker] = await sql`select 1 from ticket_messages where ticket_id = ${t1} and role = 'system' and body like '%Customer merged%'`;
    expect(marker).toBeDefined();

    // Notes: the source note moved (stamped), the auto merge-note exists (unstamped).
    const notes = await sql<{ text: string; customer_id: string; merged_from_customer_id: string | null }[]>`
      select text, customer_id, merged_from_customer_id from customer_notes where workspace_id = ${ctx.ws}
    `;
    const movedNote = notes.find((n) => n.text === 'source note');
    expect(movedNote!.customer_id).toBe(pri);
    expect(movedNote!.merged_from_customer_id).toBe(src);
    const autoNote = notes.find((n) => n.text.startsWith('Merged M-src'));
    expect(autoNote!.customer_id).toBe(pri);
    expect(autoNote!.merged_from_customer_id).toBeNull();
    // The auto note identifies the source by display id ONLY — no name or
    // email — so a later GDPR erasure leaves no PII stranded on the survivor.
    expect(autoNote!.text).not.toContain('@cust.test');
    expect(autoNote!.text).not.toContain('C src');

    // Source stamped and its mirror released (its rows live on the survivor);
    // survivor keeps its OWN email; journal + audit rows exist. Both profiles
    // were inserted WITHOUT contact rows, so this also proves the self-heal:
    // a contact-less pair merges without nulling the survivor's mirror.
    const [srcRow] = await sql<{ merged_into_customer_id: string; email: string | null }[]>`
      select merged_into_customer_id, email from customers where id = ${src}
    `;
    expect(srcRow.merged_into_customer_id).toBe(pri);
    expect(srcRow.email).toBeNull();
    const [priRow] = await sql<{ email: string; mobile: string }[]>`select email, mobile from customers where id = ${pri}`;
    expect(priRow.email).toBe(`cm-pri-${RUN}@cust.test`);
    expect(priRow.mobile).toBe('+4477001');
    const srcRows = await sql<{ customer_id: string; merged_from_customer_id: string | null; primary_before_merge: boolean }[]>`
      select customer_id, merged_from_customer_id, primary_before_merge from customer_contacts
      where workspace_id = ${ctx.ws} and merged_from_customer_id = ${src} and deleted_at is null
    `;
    expect(srcRows.length).toBe(2);
    for (const r of srcRows) { expect(r.customer_id).toBe(pri); expect(r.primary_before_merge).toBe(true); }
    const [journal] = await sql<{ tickets_moved: number; notes_moved: number }[]>`
      select tickets_moved, notes_moved from customer_merges
      where workspace_id = ${ctx.ws} and source_customer_id = ${src} and unmerged_at is null
    `;
    expect(journal.tickets_moved).toBe(1);
    expect(journal.notes_moved).toBe(1);
    const [audit] = await sql`select 1 from audit_events where workspace_id = ${ctx.ws} and action = 'customer.merged' and target_id = ${src}`;
    expect(audit).toBeDefined();
  });

  it('validation matrix: 400 self, 409 already-merged / chain-primary / erased, 404 missing, 403 without can_delete, deletes blocked on survivor', async () => {
    const other = await mkCustomer('other');
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${other}/merge`, { method: 'POST', body: JSON.stringify({ into_id: other }) })).status).toBe(400);
    // Source already merged
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${ctx.src}/merge`, { method: 'POST', body: JSON.stringify({ into_id: other }) })).status).toBe(409);
    // Primary is itself merged
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${other}/merge`, { method: 'POST', body: JSON.stringify({ into_id: ctx.src }) })).status).toBe(409);
    // Erased profile
    const erased = await mkCustomer('erased');
    await sql`update customers set erased_at = now() where id = ${erased}`;
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${erased}/merge`, { method: 'POST', body: JSON.stringify({ into_id: other }) })).status).toBe(409);
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${other}/merge`, { method: 'POST', body: JSON.stringify({ into_id: erased }) })).status).toBe(409);
    // Missing
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/00000000-0000-4000-8000-000000000000/merge`, { method: 'POST', body: JSON.stringify({ into_id: other }) })).status).toBe(404);
    // Plain member without the capability
    expect((await as(agent.token, ctx.ws, `/api/v1/customers/${other}/merge`, { method: 'POST', body: JSON.stringify({ into_id: ctx.pri }) })).status).toBe(403);
    // Survivor with live merged children can't be deleted. Use a ticketless
    // pair — a survivor holding tickets trips the has_tickets 409 first.
    const kidSrc = await mkCustomer('kid-src');
    const kidPri = await mkCustomer('kid-pri');
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${kidSrc}/merge`, { method: 'POST', body: JSON.stringify({ into_id: kidPri }) })).status).toBe(200);
    const blocked = await as(admin.token, ctx.ws, `/api/v1/customers/${kidPri}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).code).toBe('has_merged_children');
  });

  it('merging a survivor with live merged children is refused (stamps would be destroyed)', async () => {
    // Self-contained chain: X merges into Y, then Y (now a survivor holding
    // X's stamps) must refuse to merge into Z.
    const x = await mkCustomer('chain-x');
    const y = await mkCustomer('chain-y');
    const z = await mkCustomer('chain-z');
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${x}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: y }),
    })).status).toBe(200);
    const blocked = await as(admin.token, ctx.ws, `/api/v1/customers/${y}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: z }),
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).code).toBe('has_merged_children');
  });

  it('merge response excludes soft-deleted survivor notes', async () => {
    const a = await mkCustomer('sdn-a');
    const b = await mkCustomer('sdn-b');
    // A soft-deleted note on the survivor must not resurface via the merge
    // response (the SPA replaces the survivor's notes wholesale with it).
    const [note] = await sql<{ id: string }[]>`
      insert into customer_notes (workspace_id, customer_id, author_user_id, text, deleted_at)
      values (${ctx.ws}, ${b}, ${admin.userId}, 'soft-deleted survivor note', now())
      returning id
    `;
    const res = await as(admin.token, ctx.ws, `/api/v1/customers/${a}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: b }),
    });
    expect(res.status).toBe(200);
    const { notes } = await res.json() as any;
    expect(notes.some((n: any) => n.id === note.id)).toBe(false);
  });

  it('erasing a merged-away source unmerges first, so redaction reaches its history', async () => {
    const src = await mkCustomer('erase-src');
    const pri = await mkCustomer('erase-pri');
    const t = await mkTicket(src, 'erase-me subject');
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
              values (${ctx.ws}, ${t}, 'customer', 'Cust', 'their message')`;
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${src}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: pri }),
    })).status).toBe(200);

    const erased = await as(admin.token, ctx.ws, `/api/v1/customers/${src}/erase`, {
      method: 'POST', body: JSON.stringify({ reason: 'Art. 17 request' }),
    });
    expect(erased.status).toBe(200);

    // The ticket came BACK to the source pre-erasure, so the redaction hit it.
    const [tRow] = await sql<{ customer_id: string; subject: string }[]>`
      select customer_id, subject from tickets where id = ${t}
    `;
    expect(tRow.customer_id).toBe(src);
    expect(tRow.subject).not.toBe('erase-me subject');
    // Erasing the SURVIVOR is refused while it holds merged children — its
    // by-customer_id redaction would destroy the duplicates' tickets too.
    const src2 = await mkCustomer('erase-child');
    const pri2 = await mkCustomer('erase-parent');
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${src2}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: pri2 }),
    })).status).toBe(200);
    const blockedErase = await as(admin.token, ctx.ws, `/api/v1/customers/${pri2}/erase`, {
      method: 'POST', body: JSON.stringify({}),
    });
    expect(blockedErase.status).toBe(409);
    expect(((await blockedErase.json()) as any).code).toBe('has_merged_children');

    // Source is unmerged + erased; the survivor is untouched.
    const [srcRow] = await sql<{ merged_into_customer_id: string | null; erased_at: string | null }[]>`
      select merged_into_customer_id, erased_at from customers where id = ${src}
    `;
    expect(srcRow.merged_into_customer_id).toBeNull();
    expect(srcRow.erased_at).not.toBeNull();
    const [priRow] = await sql<{ erased_at: string | null }[]>`select erased_at from customers where id = ${pri}`;
    expect(priRow.erased_at).toBeNull();
  });

  it('refuses to merge two profiles linked to different Maestro players (409 different_players)', async () => {
    const a = await mkCustomer('player-a', { maestro_user_id: 'mu-A', maestro_member_id: '1' });
    const b = await mkCustomer('player-b', { maestro_user_id: 'mu-B', maestro_member_id: '2' });
    const res = await as(admin.token, ctx.ws, `/api/v1/customers/${a}/merge`, { method: 'POST', body: JSON.stringify({ into_id: b }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('different_players');
    const [pri] = await sql<{ maestro_user_id: string; maestro_member_id: string; merged_into_customer_id: string | null }[]>`
      select maestro_user_id, maestro_member_id, merged_into_customer_id from customers where id = ${b}`;
    expect(pri.maestro_user_id).toBe('mu-B');
    expect(pri.maestro_member_id).toBe('2');
    const [src] = await sql<{ merged_into_customer_id: string | null }[]>`select merged_into_customer_id from customers where id = ${a}`;
    expect(src.merged_into_customer_id).toBeNull();

    // Same player on both sides is a genuine duplicate and merges normally.
    const c = await mkCustomer('player-a2', { maestro_user_id: 'mu-A', maestro_member_id: null });
    const ok = await as(admin.token, ctx.ws, `/api/v1/customers/${c}/merge`, { method: 'POST', body: JSON.stringify({ into_id: a }) });
    expect(ok.status).toBe(200);
  });

  it('a non-admin role with can_delete may merge and unmerge', async () => {
    await sql`update workspace_members set role_id = ${ctx.cleanerRoleId} where workspace_id = ${ctx.ws} and user_id = ${agent.userId}`;
    const a = await mkCustomer('cap-a');
    const b = await mkCustomer('cap-b');
    expect((await as(agent.token, ctx.ws, `/api/v1/customers/${a}/merge`, { method: 'POST', body: JSON.stringify({ into_id: b }) })).status).toBe(200);
    expect((await as(agent.token, ctx.ws, `/api/v1/customers/${a}/unmerge`, { method: 'POST' })).status).toBe(200);
    await sql`update workspace_members set role_id = ${ctx.plainRoleId} where workspace_id = ${ctx.ws} and user_id = ${agent.userId}`;
  });

  // customer_merges.backfilled_fields is PERMANENT history, so a journal row can
  // name a column that no longer backfills — kyc_status will be exactly this once
  // its drop migration lands. BACKFILL_COLS doubles as the SQL-identifier
  // allowlist for the revert, so such a name must be skipped rather than
  // interpolated; the point of this test is that the skip is REPORTED, because
  // silently landing in fields_kept_due_to_edit would read as "we chose not to
  // revert it". The name used here is not a real column, which also pins the
  // identifier safety: if it were ever interpolated, the statement would fail.
  it('unmerge reports a journalled column that is no longer backfillable as skipped', async () => {
    const a = await mkCustomer('skip-a', { vip_tier: 'Gold' });
    const b = await mkCustomer('skip-b', { vip_tier: null });
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${a}/merge`,
      { method: 'POST', body: JSON.stringify({ into_id: b }) })).status).toBe(200);

    // Rewrite the journal as if since-removed columns had been backfilled.
    // `mobile` is the real-world case now: pre-contacts merges journalled it,
    // and it left BACKFILL_COLS when contacts started moving as rows.
    await sql`
      update customer_merges
      set backfilled_fields = ${sql.json({ vip_tier: 'Gold', mobile: '+4477009', legacy_removed_col: 'x' })}
      where workspace_id = ${ctx.ws} and source_customer_id = ${a} and unmerged_at is null
    `;

    const res = await as(admin.token, ctx.ws, `/api/v1/customers/${a}/unmerge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.fields_skipped).toEqual(['legacy_removed_col']);
    expect(body.fields_reverted).toContain('vip_tier');
    // A journalled `mobile` is handled through the contacts model, not skipped:
    // the survivor here never carried that number, so it reads as "kept".
    expect(body.fields_kept_due_to_edit).toContain('mobile');
    expect(body.fields_kept_due_to_edit).not.toContain('legacy_removed_col');

    // The real column still reverted, and the audit row carries the skip.
    const [pri] = await sql<{ vip_tier: string | null }[]>`select vip_tier from customers where id = ${b}`;
    expect(pri.vip_tier).toBeNull();
    const [audit] = await sql<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events
      where workspace_id = ${ctx.ws} and action = 'customer.unmerged' and target_id = ${a}
      order by created_at desc limit 1
    `;
    expect(audit.metadata.fields_skipped).toEqual(['legacy_removed_col']);
  });

  it('unmerges: stamped tickets/notes return, post-merge tickets stay, backfill reverts only untouched fields, journal stamped, audit', async () => {
    // Survivor edits the backfilled vip_tier post-merge; the moved mobile
    // contact is still on the survivor (promoted primary → mirror '+4477001').
    await sql`update customers set vip_tier = 'Platinum' where id = ${ctx.pri}`;
    // A ticket born on the survivor AFTER the merge must not move on unmerge.
    const postMergeTicket = await mkTicket(ctx.pri, 'born on survivor');

    const res = await as(admin.token, ctx.ws, `/api/v1/customers/${ctx.src}/unmerge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tickets_restored_ids).toContain(ctx.movedTicket);
    expect(body.tickets_restored_ids).not.toContain(postMergeTicket);
    expect(body.fields_reverted).not.toContain('mobile'); // no longer journalled — it returns as a contact row
    expect(body.fields_kept_due_to_edit).toContain('vip_tier');
    // Untouched since the merge → reverted like any other backfilled column.
    expect(body.fields_reverted).toContain('maestro_user_id');
    expect(body.fields_reverted).toContain('maestro_member_id');
    expect(body.contacts_restored).toBe(2);
    // Both sides' contacts ride back: the source reclaims its email + mobile
    // as primaries (primary_before_merge), the survivor's mobile mirror empties.
    expect(body.source.email).toBe(`cm-src-${RUN}@cust.test`);
    expect(body.source.mobile).toBe('+4477001');
    expect(body.source.emails[0].on_survivor).toBe(false);
    expect(body.primary.mobile).toBeNull();
    expect(body.primary.emails.some((e: any) => e.value === `cm-src-${RUN}@cust.test`)).toBe(false);
    // Both sides' notes ride back as server truth for the SPA.
    expect(body.source_notes.some((n: any) => n.text === 'source note')).toBe(true);
    expect(body.primary_notes.some((n: any) => n.text.startsWith('Unmerged M-src'))).toBe(true);
    expect(body.primary_notes.some((n: any) => n.text === 'source note')).toBe(false);

    const [t1row] = await sql<{ customer_id: string; pre_merge_customer_id: string | null }[]>`
      select customer_id, pre_merge_customer_id from tickets where id = ${ctx.movedTicket}
    `;
    expect(t1row.customer_id).toBe(ctx.src);
    expect(t1row.pre_merge_customer_id).toBeNull();
    const [pm] = await sql<{ customer_id: string }[]>`select customer_id from tickets where id = ${postMergeTicket}`;
    expect(pm.customer_id).toBe(ctx.pri);

    const [srcNote] = await sql<{ customer_id: string; merged_from_customer_id: string | null }[]>`
      select customer_id, merged_from_customer_id from customer_notes where workspace_id = ${ctx.ws} and text = 'source note'
    `;
    expect(srcNote.customer_id).toBe(ctx.src);
    expect(srcNote.merged_from_customer_id).toBeNull();

    const [priRow] = await sql<{ mobile: string | null; vip_tier: string | null; merged_into_customer_id: string | null }[]>`
      select mobile, vip_tier, merged_into_customer_id from customers where id = ${ctx.pri}
    `;
    expect(priRow.mobile).toBeNull();          // the moved contact went home → mirror recomputed
    expect(priRow.vip_tier).toBe('Platinum');  // kept (survivor edit wins)
    const [srcRow] = await sql<{ merged_into_customer_id: string | null; email: string | null; mobile: string | null }[]>`
      select merged_into_customer_id, email, mobile from customers where id = ${ctx.src}
    `;
    expect(srcRow.merged_into_customer_id).toBeNull();
    expect(srcRow.email).toBe(`cm-src-${RUN}@cust.test`);   // mirror restored
    expect(srcRow.mobile).toBe('+4477001');
    const stale = await sql`select 1 from customer_contacts where workspace_id = ${ctx.ws} and merged_from_customer_id = ${ctx.src}`;
    expect(stale.length).toBe(0);                             // stamps cleared

    const [journal] = await sql<{ unmerged_at: string | null }[]>`
      select unmerged_at from customer_merges where workspace_id = ${ctx.ws} and source_customer_id = ${ctx.src}
    `;
    expect(journal.unmerged_at).not.toBeNull();
    const [audit] = await sql`select 1 from audit_events where workspace_id = ${ctx.ws} and action = 'customer.unmerged' and target_id = ${ctx.src}`;
    expect(audit).toBeDefined();

    // Second unmerge → 409 (no longer merged).
    expect((await as(admin.token, ctx.ws, `/api/v1/customers/${ctx.src}/unmerge`, { method: 'POST' })).status).toBe(409);
  });
});
