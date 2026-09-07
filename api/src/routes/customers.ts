import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { nextDisplayId } from '../lib/display-id.js';
import { workerFetch, workerMaestroConfigured, MaestroError, memberNotFound, str } from '../lib/maestro.js';
import { agentBrandWorkspaceId } from '../lib/maestro-workspace.js';
import { applyPlayerToCustomer, linkedCategories, scheduleLink, linkCustomerToPlayer, playerProfileFields } from '../lib/player-identity.js';
import { requireWorkspaceAdmin, requireDeletePermission } from '../lib/authz.js';
import { eraseCustomer, CUSTOMER_PII_FIELDS } from '../lib/gdpr-erasure.js';
import { exportCustomer } from '../lib/gdpr-export.js';
import { customerSummary, customerTicketPage, customerVisible } from '../lib/customer-summary.js';
import { writeAudit } from '../middleware/platform-admin.js';
import {
  ContactError, addContact, removeContact, setPrimaryContact, resolveCustomerByContact,
  ensurePrimaryContacts, moveContactsForMerge, restoreContactsForUnmerge,
  listWorkspaceContacts, buildCustomerContacts, contactsFor, repairCustomerContacts,
} from '../lib/customer-contacts.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eraseBody = z.object({ reason: z.string().trim().max(500).optional() });

// The customer row as the SPA sees it — one column list shared by GET / and
// PATCH /:id so the two can never drift apart (the SPA applies a PATCH
// response with the same mapper it bootstraps from). getDb() returns `since`
// as a YYYY-MM-DD calendar value rather than a midnight-UTC timestamp.
const CUSTOMER_ROW_COLS = `id, display_id, first_name, last_name, username, email, mobile, brand, vip_tier,
           jurisdiction, consent, since, backoffice_url, erased_at, created_at,
           maestro_user_id, maestro_member_id,
           merged_into_customer_id, merged_at,
           email_bounce_state, email_last_bounce_type, email_last_bounce_at, email_bounce_count`;

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const customers = new Hono();

customers.use('*', requireAuth);

// Create (or find) a local customer from a live Maestro player — so an agent can
// proactively open a conversation with someone who has NEVER contacted support
// (and therefore has no local record yet). The caller passes one lookup key; we
// re-fetch the authoritative player with the app token (never trust client PII),
// upsert by email within the workspace, and return the customer id. The SPA then
// opens a ticket against it via the normal POST /api/v1/tickets path.
customers.post('/from-player', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  if (!workerMaestroConfigured()) return c.json({ error: 'Player lookup is not configured.' }, 503);
  const brandId = c.req.header('X-Brand-Id');
  if (!brandId) return c.json({ error: 'X-Brand-Id header required.' }, 400);
  // Per-agent brand gate + tenant coherence (advisory #10): the re-fetch uses the
  // app token, so confirm this agent belongs to the brand AND that the brand's
  // workspace is the one we're about to write the player's PII into. Without the
  // second check an agent who belongs to workspace A *and* has access to a
  // different brand B could pull brand B's player PII into workspace A.
  const brandWorkspaceId = await agentBrandWorkspaceId(c.get('userId'), brandId);
  if (!brandWorkspaceId) {
    return c.json({ error: 'You do not have access to this brand.' }, 403);
  }
  if (brandWorkspaceId !== workspaceId) {
    return c.json({ error: 'The selected brand does not match this workspace.' }, 400);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { email?: string; memberId?: string; maestroUserId?: string }
    | null;
  const key = body?.email
    ? { email: body.email }
    : body?.memberId
      ? { memberId: body.memberId }
      : body?.maestroUserId
        ? { maestroUserId: body.maestroUserId }
        : null;
  if (!key) return c.json({ error: 'Provide one of email, memberId or maestroUserId.' }, 400);

  let m: Record<string, unknown>;
  try {
    m = await workerFetch<Record<string, unknown>>('/api/v1/proxy/member/lookup', { brandId, query: key });
  } catch (err) {
    // Distinguish failure modes so the agent gets an actionable message rather
    // than a blanket 502: auth (bad/expired app token or brand not granted) vs
    // unreachable gateway (status 0) vs any other upstream error.
    if (err instanceof MaestroError) {
      if (err.status === 401 || err.status === 403) {
        return c.json({ error: 'Maestro rejected the lookup (token or brand access).' }, 502);
      }
      if (err.status === 0) {
        return c.json({ error: 'Could not reach the Maestro gateway.' }, 502);
      }
      return c.json({ error: err.message || 'Maestro lookup failed.' }, 502);
    }
    return c.json({ error: 'Could not reach Maestro to resolve the player.' }, 502);
  }
  if (memberNotFound(m)) {
    return c.json({ error: 'No matching player found.' }, 404);
  }

  const email = str(m.email);
  if (!email) return c.json({ error: 'Player has no email on file; cannot start a conversation.' }, 422);

  // Any address the local profile holds matches (Phase 4 contacts model), and
  // a merged-away duplicate resolves to its survivor — the same single hop
  // inbound mail applies.
  const existing = await resolveCustomerByContact(sql, workspaceId, 'email', email, { heal: true });
  if (existing) {
    const existingId = existing.merged_into_customer_id || existing.id;
    // Repair blanks for the same player, including an already-linked contact.
    // The shared writer refuses to re-point another player's identity.
    const [before] = await sql<{ maestro_user_id: string | null }[]>`
      select maestro_user_id from customers where id = ${existingId} and workspace_id = ${workspaceId}
    `;
    const linked = await applyPlayerToCustomer(sql, { workspaceId, customerId: existingId, member: m });
    if (linked) {
      await writeAudit({
        workspaceId,
        actorUserId: c.get('userId'),
        action: before?.maestro_user_id ? 'customer.player_refreshed' : 'customer.player_linked',
        targetType: 'customer',
        targetId: existingId,
        metadata: { brand_id: brandId, reason: 'from_player', accessed: linkedCategories(m) },
      });
    }
    return c.json({ customer: { id: existingId }, created: false });
  }

  try {
    // Customer row + its primary contacts land together (mirror invariant).
    const createdId = await sql.begin(async (tx) => {
      const displayId = await nextDisplayId(tx, workspaceId, 'customer');
      const [workspace] = await tx<{ name: string }[]>`select name from workspaces where id = ${workspaceId}`;
      const fields = playerProfileFields(m, workspace.name);
      const [created] = await tx<{ id: string }[]>`
        insert into customers
          (workspace_id, display_id, first_name, last_name, username, email, mobile, vip_tier, jurisdiction, brand,
           maestro_user_id, maestro_member_id, player_lookup_at)
        values
          (${workspaceId}, ${displayId}, ${str(m.firstName)}, ${str(m.lastName)}, ${fields.username},
           ${email}, ${str(m.mobile)}, ${fields.vip_tier}, ${fields.jurisdiction}, ${fields.brand},
           ${str(m.userId)}, ${str(m.userId) ? str(m.memberId) : null}, now())
        returning id
      `;
      await ensurePrimaryContacts(tx, { workspaceId, customerId: created.id, email, mobile: str(m.mobile) }, { strict: true });
      return created.id;
    });
    return c.json({ customer: { id: createdId }, created: true }, 201);
  } catch (err) {
    // Two agents starting a conversation with the same new player at once:
    // the loser's insert trips a unique index — hand back the winner instead
    // of a 500 (the recovery this route never had).
    if ((err as { code?: string })?.code === '23505') {
      const winner = await resolveCustomerByContact(sql, workspaceId, 'email', email, { heal: true });
      if (winner) return c.json({ customer: { id: winner.merged_into_customer_id || winner.id }, created: false });
    }
    throw err;
  }
});

// List customers in the active workspace. Returns the raw DB shape; the SPA
// remaps to its camelCase view model. No pagination yet (small in v1).
customers.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql<Array<Record<string, unknown> & {
    id: string; merged_into_customer_id: string | null; email: string | null; mobile: string | null;
    email_bounce_state: string | null; email_bounce_count: number | null; email_last_bounce_at: string | null;
  }>>`
    select ${sql.unsafe(CUSTOMER_ROW_COLS)}
    from customers
    where workspace_id = ${workspaceId} and deleted_at is null
    order by display_id asc
  `;
  // Phase 4 contacts model: `emails` / `mobiles` ride alongside the scalar
  // mirror (which stays the primary), and a merged-away duplicate's addresses
  // — physically on its survivor now — are derived back onto it so the Merged
  // view keeps showing them.
  const idx = await listWorkspaceContacts(sql, workspaceId);
  return c.json({ customers: rows.map((r) => ({ ...r, ...buildCustomerContacts(r, idx) })) });
});

// Opening a profile can repair an old stub without a bulk backfill. The brand
// comes from the customer's workspace, never a client-supplied lookup key.
customers.post('/:id/refresh-account', async (c) => {
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);
  const sql = getDb();
  const [target] = await sql<{ maestro_brand_id: string | null }[]>`
    select w.maestro_brand_id from customers cu join workspaces w on w.id = cu.workspace_id
    where cu.id = ${customerId} and cu.workspace_id = ${workspaceId}
      and cu.deleted_at is null and cu.erased_at is null and cu.merged_into_customer_id is null
      and w.deleted_at is null
  `;
  if (!target) return c.json({ error: 'Customer not found' }, 404);
  if (target.maestro_brand_id && await agentBrandWorkspaceId(c.get('userId'), target.maestro_brand_id) !== workspaceId) {
    return c.json({ error: 'You do not have access to this brand.' }, 403);
  }
  const outcome = await linkCustomerToPlayer({ workspaceId, customerId, reason: 'profile_open', actorUserId: c.get('userId') });
  if (outcome === 'unconfigured' && target.maestro_brand_id) {
    return c.json({ error: "Account lookup isn't configured." }, 503);
  }
  if (outcome === 'failed') return c.json({ error: "Couldn't refresh account details. Try opening this profile again shortly." }, 502);
  if (outcome === 'identity_mismatch' || outcome === 'email_mismatch') {
    return c.json({ error: "The account didn't match this customer. Saved details were kept." }, 409);
  }
  const [row] = await sql<Record<string, unknown>[]>`
    select ${sql.unsafe(CUSTOMER_ROW_COLS)} from customers
    where id = ${customerId} and workspace_id = ${workspaceId}
      and deleted_at is null and erased_at is null and merged_into_customer_id is null
  `;
  if (!row) return c.json({ error: 'Customer not found' }, 404);
  return c.json({ customer: { ...row, ...(await contactsFor(sql, workspaceId, customerId)) }, outcome });
});

// ─── Customer notes ─────────────────────────────────────────────────────────
// First real persistence for customer_notes (until Phase 2 the SPA kept notes
// in memory and they vanished on refresh). List + create are member-level —
// any agent shares context; delete is gated by the can_delete capability.

// GET /notes — every note in the workspace in one call (the SPA groups them
// by customer at bootstrap; no per-customer N+1). Bounded: newest-first with
// a hard cap so a note-heavy workspace can't balloon the bootstrap payload —
// beyond the cap the oldest notes simply don't ship (per-customer paging is
// Phase-4 profile-overhaul territory). Backed by the composite
// (workspace_id, created_at desc) index (20260818130000).
const NOTES_LIST_CAP = 2000;

customers.get('/notes', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  // Join customers so notes of soft-deleted (or erased) profiles never ship
  // to the client — DELETE /:id below also hard-deletes them, but this keeps
  // any legacy stragglers from leaking free-text PII forever.
  const rows = await sql`
    select n.id, n.customer_id, n.author_user_id, u.name as author_name,
           n.text, n.created_at
    from customer_notes n
    join customers cu on cu.id = n.customer_id and cu.deleted_at is null
    left join users u on u.id = n.author_user_id
    where n.workspace_id = ${workspaceId} and n.deleted_at is null
    order by n.created_at desc
    limit ${NOTES_LIST_CAP}
  `;
  return c.json({ notes: rows, capped: rows.length === NOTES_LIST_CAP });
});

const NoteBody = z.object({ text: z.string().trim().min(1).max(4000) });

// POST /:id/notes — add an internal note to a customer. Author is the caller
// (stamped from the session, never trusted from the client).
customers.post('/:id/notes', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const raw = await c.req.json().catch(() => null);
  const parsed = NoteBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

  const [cust] = await sql`
    select 1 from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!cust) return c.json({ error: 'Customer not found' }, 404);

  const [note] = await sql`
    insert into customer_notes (workspace_id, customer_id, author_user_id, text)
    values (${workspaceId}, ${customerId}, ${userId}, ${parsed.data.text})
    returning id, customer_id, author_user_id, text, created_at
  `;
  const [u] = await sql<{ name: string | null }[]>`select name from users where id = ${userId}`;
  return c.json({ note: { ...note, author_name: u?.name ?? null } }, 201);
});

// DELETE /:id/notes/:noteId — SOFT delete, matching the codebase convention
// (the row stays for recoverability; the audit row is the visible trail).
// The two deliberate hard-delete paths for notes live elsewhere: GDPR
// erasure, and the profile-delete purge in DELETE /:id below.
customers.delete('/:id/notes/:noteId', async (c) => {
  const denied = await requireDeletePermission(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  const noteId = c.req.param('noteId');
  if (!UUID_RE.test(customerId) || !UUID_RE.test(noteId)) return c.json({ error: 'Note not found' }, 404);

  const [row] = await sql<{ id: string; author_user_id: string | null; text: string; created_at: string }[]>`
    update customer_notes set deleted_at = now()
    where id = ${noteId} and workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
    returning id, author_user_id, text, created_at
  `;
  if (!row) return c.json({ error: 'Note not found' }, 404);

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'customer_note.deleted',
    targetType: 'customer_note',
    targetId: row.id,
    metadata: {
      customer_id: customerId,
      author_user_id: row.author_user_id,
      created_at: row.created_at,
      text_preview: String(row.text || '').slice(0, 120),
    },
  });
  return new Response(null, { status: 204 });
});

// ─── DELETE /:id — soft-delete a customer profile ───────────────────────────
// Gated by the can_delete capability. Refused while the customer has any
// live ticket history — merge into another profile (or GDPR-erase) instead,
// so tickets can never lose their customer by accident. Soft delete: tickets
// and gdpr_erasures reference customers with no ON DELETE, and the partial
// unique index on (workspace_id, email) where deleted_at is null frees the
// address for reuse automatically.
customers.delete('/:id', async (c) => {
  const denied = await requireDeletePermission(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const [cust] = await sql<{ id: string; display_id: string; email: string | null; first_name: string | null; last_name: string | null }[]>`
    select id, display_id, email, first_name, last_name
    from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!cust) return c.json({ error: 'Customer not found' }, 404);

  const [t] = await sql`
    select 1 from tickets
    where workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
    limit 1
  `;
  if (t) {
    return c.json({ error: 'This customer has ticket history — merge them into another profile instead', code: 'has_tickets' }, 409);
  }

  // A merge survivor with live duplicates can't be deleted: the duplicates'
  // unmerge would target a hidden profile. (Deleting a merged SOURCE is
  // allowed — it just forfeits its unmerge, same rule as tickets.)
  const [child] = await sql`
    select 1 from customers
    where workspace_id = ${workspaceId} and merged_into_customer_id = ${customerId} and deleted_at is null
    limit 1
  `;
  if (child) {
    return c.json({ error: 'This profile has merged duplicates — unmerge them first', code: 'has_merged_children' }, 409);
  }

  // Soft-delete the profile but HARD-delete its internal notes (free-text
  // PII with no UI reachable once the profile is gone — same treatment GDPR
  // erasure gives them; individual note deletion is soft, this purge is the
  // deliberate exception). Portal access is revoked in the same transaction:
  // sessions/magic-links only cascade on a HARD customer delete, so without
  // this a soft-deleted customer's portal login would keep working. One
  // transaction so a crash can't hide the profile while leaving notes or
  // live sessions behind.
  const notesDeleted = await sql.begin(async (tx) => {
    const gone = await tx`
      delete from customer_notes
      where workspace_id = ${workspaceId} and customer_id = ${customerId}
      returning id
    `;
    await tx`delete from portal_sessions where workspace_id = ${workspaceId} and customer_id = ${customerId}`;
    await tx`delete from portal_magic_links where workspace_id = ${workspaceId} and customer_id = ${customerId}`;
    // Contacts model: free the addresses (soft, like the profile — recoverable).
    // The contacts email index can't see customers.deleted_at, so this has to
    // happen here, in the same transaction.
    await tx`
      update customer_contacts set deleted_at = now()
      where workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
    `;
    await tx`
      update customers set deleted_at = now()
      where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
    `;
    return gone.length;
  });

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'customer.deleted',
    targetType: 'customer',
    targetId: cust.id,
    metadata: {
      display_id: cust.display_id,
      email: cust.email,
      name: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || null,
      notes_deleted: notesDeleted,
    },
  });
  // Known accepted limit: customers have no sync endpoint, so OTHER open tabs
  // keep the row until reload — true of every customer mutation today. The
  // acting tab splices locally on the 204.
  return new Response(null, { status: 204 });
});

// ─── Customer merge / unmerge ────────────────────────────────────────────────
// Server-side profile merge, mirroring the ticket-merge shape (routes/
// tickets.ts /:id/merge). Gated by the can_delete capability (Phase-2
// decision: merge rides the delete & merge permission, not admin-only).
//
// Merge moves EVERY ticket of the source (live, deleted, and ticket-merged —
// no dangling pointers left behind) onto the survivor, stamping each with
// pre_merge_customer_id; message rows are untouched, so original emails and
// timestamps stay exactly as they were. Notes MOVE (server truth, not the
// old client-side copy) with a merged_from stamp. Blank survivor fields
// backfill from the source — email deliberately excluded (the live-but-merged
// source row still holds it; copying would trip the partial unique index) —
// and the copied values land in a customer_merges journal row so unmerge can
// revert exactly those, only where the survivor hasn't edited them since.

const MergeBody = z.object({ into_id: z.string().uuid() });

// Backfillable columns — email is NOT here by design (see above), and since the
// Phase 4 contacts model neither is mobile: both now MOVE as contact rows
// (lib/customer-contacts.ts moveContactsForMerge — the survivor's own primary
// wins, the source's arrive as secondaries, and a survivor with no mobile gets
// the source's promoted, which is the outcome this backfill used to produce).
// Old journal rows naming `mobile` (pre-contacts merges) are reverted THROUGH
// the contacts model on unmerge — see the `mobile` branch in performUnmerge —
// not skipped. Custom-field values were a client-only flourish and are dropped
// from the server merge.
// kyc_status stays in this list even though Phase 4 removed KYC from the
// product. The column still exists and still holds values, and this list drives
// BOTH the merge backfill and the unmerge revert — delisting it while the data
// is live would strand a merged-away subject's value on the survivor with no way
// to revert it, which POST /:id/erase depends on (it unmerges first precisely so
// the survivor keeps nothing). It comes out with the drop-column migration.
//
// performUnmerge treats any column NOT listed here as "skipped" rather than
// "kept", so once a name does leave, stale journal rows say so in the audit
// instead of masquerading as a deliberate decision not to revert.
const BACKFILL_COLS = [
  'username', 'brand', 'vip_tier', 'jurisdiction', 'kyc_status', 'since', 'backoffice_url',
  // Maestro player ids (text columns — see the 20260903100000 migration).
  'maestro_user_id', 'maestro_member_id',
] as const;

customers.post('/:id/merge', async (c) => {
  const denied = await requireDeletePermission(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const sourceId = c.req.param('id');
  if (!UUID_RE.test(sourceId)) return c.json({ error: 'Customer not found' }, 404);

  const raw = await c.req.json().catch(() => null);
  const parsed = MergeBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const primaryId = parsed.data.into_id;
  if (primaryId === sourceId) return c.json({ error: 'Cannot merge a customer into themselves' }, 400);

  let outcome: { status: number; body: unknown };
  const audit: { tickets: number; notes: number; contacts: number; backfilled: string[] } = { tickets: 0, notes: 0, contacts: 0, backfilled: [] };

  await sql.begin(async (tx) => {
    // Lock both rows in deterministic id order so two concurrent merges of
    // the same pair (either direction) can't deadlock.
    const [a, b] = [sourceId, primaryId].sort();
    const rows = await tx<{ id: string; display_id: string; first_name: string | null; last_name: string | null; email: string | null;
      mobile: string | null; username: string | null; brand: string | null; vip_tier: string | null; jurisdiction: string | null;
      kyc_status: string | null; since: string | null; backoffice_url: string | null;
      maestro_user_id: string | null; maestro_member_id: string | null;
      merged_into_customer_id: string | null; erased_at: string | null }[]>`
      select id, display_id, first_name, last_name, email, mobile, username, brand, vip_tier,
             jurisdiction, kyc_status, since, backoffice_url,
             maestro_user_id, maestro_member_id, merged_into_customer_id, erased_at
      from customers
      where id = any(${[a, b]}) and workspace_id = ${workspaceId} and deleted_at is null
      order by id
      for update
    `;
    // getDb() preserves DATE values as YYYY-MM-DD, including the journal and
    // the unmerge equality check.
    const source = rows.find((r) => r.id === sourceId);
    const primary = rows.find((r) => r.id === primaryId);
    if (!source)  { outcome = { status: 404, body: { error: 'Customer not found' } }; return; }
    if (!primary) { outcome = { status: 404, body: { error: 'Primary customer not found' } }; return; }
    if (source.merged_into_customer_id)  { outcome = { status: 409, body: { error: 'This profile is already merged' } }; return; }
    if (primary.merged_into_customer_id) { outcome = { status: 409, body: { error: 'The chosen survivor is itself a merged duplicate — pick the chain primary instead' } }; return; }
    if (source.erased_at || primary.erased_at) { outcome = { status: 409, body: { error: 'Erased profiles cannot be merged' } }; return; }
    // Two profiles linked to DIFFERENT Maestro players are two people, not a
    // duplicate — and the column-wise backfill below would otherwise leave the
    // survivor with one player's user id next to the other's member number.
    if (source.maestro_user_id && primary.maestro_user_id && source.maestro_user_id !== primary.maestro_user_id) {
      outcome = { status: 409, body: { error: 'These profiles are linked to different Maestro players and cannot be merged', code: 'different_players' } };
      return;
    }

    // A source that is itself a merge SURVIVOR can't be merged away: step 1
    // below would overwrite its children's pre_merge/merged_from stamps
    // (they all currently point at the source), permanently stranding their
    // unmerge. Unmerge the children first, then merge.
    const [childOfSource] = await tx`
      select 1 from customers
      where workspace_id = ${workspaceId} and merged_into_customer_id = ${sourceId} and deleted_at is null
      limit 1
    `;
    if (childOfSource) {
      outcome = { status: 409, body: { error: 'This profile has merged duplicates — unmerge them before merging it into another profile', code: 'has_merged_children' } };
      return;
    }

    // 1. Move EVERY ticket (incl. soft-deleted / ticket-merged ones) so no
    // pointer keeps referencing the merged-away profile.
    const moved = await tx<{ id: string; deleted_at: string | null }[]>`
      update tickets
      set pre_merge_customer_id = customer_id, customer_id = ${primaryId}
      where workspace_id = ${workspaceId} and customer_id = ${sourceId}
      returning id, deleted_at
    `;
    audit.tickets = moved.length;

    // 2. A 'system' marker on each moved LIVE ticket's thread — one statement
    // for all of them (a heavy duplicate can hold hundreds of tickets, and
    // both customer rows stay locked for the whole transaction).
    const liveMovedIds = moved.filter((m) => !m.deleted_at).map((m) => m.id);
    if (liveMovedIds.length) {
      await tx`
        insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
        select ${workspaceId}, t.id, 'system', 'System',
               ${`── Customer merged: ${source.display_id} → ${primary.display_id} ──`}
        from unnest(${liveMovedIds}::uuid[]) as t(id)
      `;
    }

    // 3. Move the source's LIVE notes onto the survivor, stamped for unmerge.
    // Soft-deleted notes stay behind (they're invisible everywhere and would
    // only inflate the moved-count in the auto note below).
    const movedNotes = await tx<{ id: string }[]>`
      update customer_notes
      set customer_id = ${primaryId}, merged_from_customer_id = ${sourceId}
      where workspace_id = ${workspaceId} and customer_id = ${sourceId} and deleted_at is null
      returning id
    `;
    audit.notes = movedNotes.length;

    // 3b. Contacts MOVE to the survivor, stamped for unmerge (Phase 4 contacts
    // model — lib/customer-contacts.ts). The survivor's own primary wins and
    // the source's rows arrive as secondaries, unless the survivor had none of
    // that kind (then the source's primary is promoted — the same outcome the
    // old scalar backfill of `mobile` produced). Both mirrors recompute, so
    // the source's customers.email/mobile go NULL here; GET /customers derives
    // its display addresses back from the stamped rows.
    const movedContacts = await moveContactsForMerge(tx, workspaceId, source, primary);
    audit.contacts = movedContacts.moved;

    // 4. The spec-required merge note on the survivor. merged_from stays NULL
    // so it survives a later unmerge as history. Deliberately identifies the
    // source by display id ONLY — no name/email — so a later GDPR erasure of
    // the source leaves no PII stranded in the survivor's notes.
    await tx`
      insert into customer_notes (workspace_id, customer_id, author_user_id, text)
      values (${workspaceId}, ${primaryId}, ${userId},
              ${`Merged ${source.display_id} into this profile — ${moved.length} ticket${moved.length === 1 ? '' : 's'} and ${movedNotes.length} note${movedNotes.length === 1 ? '' : 's'} moved.`})
    `;

    // 5. Backfill blank survivor fields from the source, journalling exactly
    // what was copied.
    const backfilled: Record<string, string> = {};
    for (const col of BACKFILL_COLS) {
      const srcVal = (source as Record<string, string | null>)[col];
      const priVal = (primary as Record<string, string | null>)[col];
      if (srcVal && !priVal) backfilled[col] = srcVal;
    }
    if (Object.keys(backfilled).length) {
      await tx`update customers set ${tx(backfilled)} where id = ${primaryId} and workspace_id = ${workspaceId}`;
    }
    audit.backfilled = Object.keys(backfilled);

    // 6. Stamp the source as merged.
    const [stamped] = await tx<{ merged_at: string }[]>`
      update customers set merged_into_customer_id = ${primaryId}, merged_at = now()
      where id = ${sourceId} and workspace_id = ${workspaceId}
      returning merged_at
    `;

    // 7. Journal row — the unmerge's memory + permanent history.
    await tx`
      insert into customer_merges (workspace_id, source_customer_id, primary_customer_id, merged_by_user_id,
                                   tickets_moved, notes_moved, backfilled_fields)
      values (${workspaceId}, ${sourceId}, ${primaryId}, ${userId}, ${moved.length}, ${movedNotes.length}, ${tx.json(backfilled)})
    `;

    // Everything the SPA needs to update locally without a reload.
    // deleted_at filter matters: the SPA replaces the survivor's notes
    // wholesale with this list, so a soft-deleted note must not resurface.
    const notes = await tx`
      select n.id, n.customer_id, n.author_user_id, u.name as author_name, n.text,
             n.merged_from_customer_id, n.created_at
      from customer_notes n
      left join users u on u.id = n.author_user_id
      where n.workspace_id = ${workspaceId} and n.customer_id = ${primaryId} and n.deleted_at is null
      order by n.created_at desc
    `;
    // Contacts after the move — server truth for the SPA (mirror scalars +
    // arrays) for both sides.
    const [sourceContacts, primaryContacts] = await Promise.all([
      contactsFor(tx, workspaceId, sourceId), contactsFor(tx, workspaceId, primaryId),
    ]);
    outcome = {
      status: 200,
      body: {
        source: { id: sourceId, display_id: source.display_id, merged_at: stamped.merged_at, ...sourceContacts },
        primary: { id: primaryId, display_id: primary.display_id, ...primaryContacts },
        tickets_moved_ids: moved.map((m) => m.id),
        notes,
        backfilled_fields: backfilled,
        contacts_moved: movedContacts.moved,
      },
    };
  });

  if (outcome!.status === 200) {
    await writeAudit({
      workspaceId,
      actorUserId: userId,
      action: 'customer.merged',
      targetType: 'customer',
      targetId: sourceId,
      metadata: { into: primaryId, tickets_moved: audit.tickets, notes_moved: audit.notes, contacts_moved: audit.contacts, backfilled: audit.backfilled },
    });
  }
  return c.json(outcome!.body as Record<string, unknown>, outcome!.status as 200);
});

// Unmerge core — shared by POST /:id/unmerge and POST /:id/erase (GDPR
// erasure of a merged-away source must FIRST restore its history to the
// source, or eraseCustomer's by-customer_id redaction would miss everything
// the merge re-homed onto the survivor). Restores tickets/notes by their
// stamps, reverts journalled backfills only where the survivor still carries
// the copied value (survivor edits win), clears the merge pointers, and
// stamps the journal row (kept as history).
async function performUnmerge(workspaceId: string, userId: string, sourceId: string):
  Promise<{ status: number; body: Record<string, unknown>; audit: { from: string | null; tickets: number; notes: number; contacts: number; reverted: string[]; kept: string[]; skipped: string[] } }> {
  const sql = getDb();
  let outcome: { status: number; body: Record<string, unknown> };
  const audit: { from: string | null; tickets: number; notes: number; contacts: number; reverted: string[]; kept: string[]; skipped: string[] } =
    { from: null, tickets: 0, notes: 0, contacts: 0, reverted: [], kept: [], skipped: [] };

  await sql.begin(async (tx) => {
    // Peek (no lock) to learn the survivor, then lock BOTH rows in sorted-id
    // order — the same order merge uses. Locking source-then-survivor here
    // would AB-BA deadlock against a concurrent merge on the same pair.
    const [peek] = await tx<{ merged_into_customer_id: string | null }[]>`
      select merged_into_customer_id from customers
      where id = ${sourceId} and workspace_id = ${workspaceId} and deleted_at is null
    `;
    if (!peek) { outcome = { status: 404, body: { error: 'Customer not found' } }; return; }
    if (!peek.merged_into_customer_id) { outcome = { status: 409, body: { error: 'This profile is not merged' } }; return; }
    const primaryId = peek.merged_into_customer_id;
    audit.from = primaryId;

    const [a, b] = [sourceId, primaryId].sort();
    await tx`
      select id from customers
      where id = any(${[a, b]}) and workspace_id = ${workspaceId}
      order by id
      for update
    `;
    // Re-verify under the lock — the peek raced unlocked, so the merge state
    // may have changed before we got here.
    const [source] = await tx<{ id: string; display_id: string; merged_into_customer_id: string | null }[]>`
      select id, display_id, merged_into_customer_id from customers
      where id = ${sourceId} and workspace_id = ${workspaceId} and deleted_at is null
    `;
    if (!source) { outcome = { status: 404, body: { error: 'Customer not found' } }; return; }
    if (source.merged_into_customer_id !== primaryId) { outcome = { status: 409, body: { error: 'This profile is not merged' } }; return; }

    const restored = await tx<{ id: string }[]>`
      update tickets set customer_id = ${sourceId}, pre_merge_customer_id = null
      where workspace_id = ${workspaceId} and customer_id = ${primaryId} and pre_merge_customer_id = ${sourceId}
      returning id
    `;
    audit.tickets = restored.length;

    const notesBack = await tx<{ id: string }[]>`
      update customer_notes set customer_id = ${sourceId}, merged_from_customer_id = null
      where workspace_id = ${workspaceId} and customer_id = ${primaryId} and merged_from_customer_id = ${sourceId}
      returning id
    `;
    audit.notes = notesBack.length;

    // Contacts stamped with this source go back with the primary flag they
    // held; both mirrors recompute (survivor first — it may be releasing an
    // address the source is about to reclaim).
    const restoredContacts = await restoreContactsForUnmerge(tx, workspaceId, sourceId, primaryId);
    audit.contacts = restoredContacts.restored;

    // Conditional backfill revert from the journal.
    const [journal] = await tx<{ id: string; backfilled_fields: Record<string, string> }[]>`
      select id, backfilled_fields from customer_merges
      where workspace_id = ${workspaceId} and source_customer_id = ${sourceId}
        and primary_customer_id = ${primaryId} and unmerged_at is null
      order by merged_at desc
      limit 1
    `;
    const backfilled = journal?.backfilled_fields || {};
    for (const [col, copied] of Object.entries(backfilled)) {
      // Identifier safety, and history tolerance: a journal row may name a
      // column that no longer backfills (kyc_status, removed in Phase 4). Record
      // it as skipped — lumping it in with `kept` would read as a decision.
      if (col === 'mobile') {
        // Pre-contacts merges journalled the copied mobile as a scalar, and the
        // contacts backfill turned that copy into the survivor's own (unstamped)
        // primary mobile row. Revert it through the contacts model: retire the
        // survivor's unstamped row still carrying the journalled value (a later
        // edit wins, same rule as the scalars), then repair primaries + mirror.
        // Post-contacts merges never journal mobile — rows move instead.
        const res = await tx`
          update customer_contacts set deleted_at = now()
          where workspace_id = ${workspaceId} and customer_id = ${primaryId} and kind = 'mobile'
            and merged_from_customer_id is null and deleted_at is null and value = ${copied}
          returning id
        `;
        if (res.length) await repairCustomerContacts(tx, workspaceId, primaryId);
        (res.length ? audit.reverted : audit.kept).push(col);
        continue;
      }
      if (!(BACKFILL_COLS as readonly string[]).includes(col)) { audit.skipped.push(col); continue; }
      // Reverting the Maestro link also clears the lookup stamp, so the
      // survivor is re-probed on its next email instead of waiting out the TTL.
      const revert = col === 'maestro_user_id' ? { [col]: null, player_lookup_at: null } : { [col]: null };
      const res = await tx`
        update customers set ${tx(revert)}
        where id = ${primaryId} and workspace_id = ${workspaceId} and ${tx(col)} = ${copied}
        returning id
      `;
      (res.length ? audit.reverted : audit.kept).push(col);
    }

    await tx`
      update customers set merged_into_customer_id = null, merged_at = null
      where id = ${sourceId} and workspace_id = ${workspaceId}
    `;
    if (journal) {
      await tx`
        update customer_merges set unmerged_at = now(), unmerged_by_user_id = ${userId}
        where id = ${journal.id}
      `;
    }
    await tx`
      insert into customer_notes (workspace_id, customer_id, author_user_id, text)
      values (${workspaceId}, ${primaryId}, ${userId},
              ${`Unmerged ${source.display_id} — ${restored.length} ticket${restored.length === 1 ? '' : 's'} and ${notesBack.length} note${notesBack.length === 1 ? '' : 's'} restored.`})
    `;

    // Both sides' live notes ride back so the SPA can apply server truth
    // wholesale (mirrors the merge response) instead of filtering local
    // stamps — which go stale after a reload or a second stacked merge.
    const notesFor = (custId: string) => tx`
      select n.id, n.customer_id, n.author_user_id, u.name as author_name, n.text,
             n.merged_from_customer_id, n.created_at
      from customer_notes n
      left join users u on u.id = n.author_user_id
      where n.workspace_id = ${workspaceId} and n.customer_id = ${custId} and n.deleted_at is null
      order by n.created_at desc
    `;
    const [sourceNotes, primaryNotes, sourceContacts, primaryContacts] = await Promise.all([
      notesFor(sourceId), notesFor(primaryId), contactsFor(tx, workspaceId, sourceId), contactsFor(tx, workspaceId, primaryId),
    ]);

    outcome = {
      status: 200,
      body: {
        source: { id: sourceId, display_id: source.display_id, ...sourceContacts },
        primary: { id: primaryId, ...primaryContacts },
        tickets_restored_ids: restored.map((r) => r.id),
        contacts_restored: audit.contacts,
        source_notes: sourceNotes,
        primary_notes: primaryNotes,
        fields_reverted: audit.reverted,
        fields_kept_due_to_edit: audit.kept,
        fields_skipped: audit.skipped,
      },
    };
  });

  return { ...outcome!, audit };
}

// POST /:id/unmerge — :id is the merged SOURCE. Thin wrapper over
// performUnmerge (shared with the erase route) + the audit row.
customers.post('/:id/unmerge', async (c) => {
  const denied = await requireDeletePermission(c);
  if (denied) return denied;

  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const sourceId = c.req.param('id');
  if (!UUID_RE.test(sourceId)) return c.json({ error: 'Customer not found' }, 404);

  const { status, body, audit } = await performUnmerge(workspaceId, userId, sourceId);
  if (status === 200) {
    await writeAudit({
      workspaceId,
      actorUserId: userId,
      action: 'customer.unmerged',
      targetType: 'customer',
      targetId: sourceId,
      metadata: { from: audit.from, tickets_restored: audit.tickets, notes_restored: audit.notes, contacts_restored: audit.contacts, fields_reverted: audit.reverted, fields_kept_due_to_edit: audit.kept, fields_skipped: audit.skipped },
    });
  }
  return c.json(body, status as 200);
});

// ─── Contacts — multiple emails / mobiles per customer ──────────────────────
// Phase 4 contacts model. lib/customer-contacts.ts owns every rule (one
// primary per kind, the customers.email/mobile mirror, the removal guards,
// the 23505 → 409 mapping); these routes only validate, call, and audit.
// Member-level like custom-field edits: removing an address is a profile
// edit, not a record delete, so it does not ride can_delete. Audit rows
// deliberately carry NO address value — audit_events is append-only and
// outside GDPR erasure (same rule as the merge auto-note).
const ContactBody = z.object({
  kind: z.enum(['email', 'mobile']),
  value: z.string().trim().min(1).max(254),
  primary: z.boolean().optional(),
}).strict().superRefine((b, ctx) => {
  if (b.kind === 'email' && !z.string().email().safeParse(b.value).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Invalid email address' });
  }
});

function contactErrorResponse(c: Context, err: unknown) {
  if (err instanceof ContactError) {
    return c.json({ error: err.message, code: err.code, ...err.extra }, err.status as 409);
  }
  throw err;
}

customers.post('/:id/contacts', async (c) => {
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);
  const raw = await c.req.json().catch(() => null);
  const parsed = ContactBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

  try {
    const result = await addContact(getDb(), { workspaceId, customerId, ...parsed.data });
    await writeAudit({
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'customer.contact_added',
      targetType: 'customer',
      targetId: customerId,
      metadata: { customer_id: customerId, kind: parsed.data.kind, contact_id: result.contact.id, primary: result.contact.is_primary },
    });
    // A newly added address may be the casino login — try to link on it.
    if (parsed.data.kind === 'email') scheduleLink({ workspaceId, customerId, email: parsed.data.value, actorUserId: c.get('userId'), reason: 'contact_edit' });
    return c.json(result, 201);
  } catch (err) {
    return contactErrorResponse(c, err);
  }
});

customers.delete('/:id/contacts/:contactId', async (c) => {
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  const contactId = c.req.param('contactId');
  if (!UUID_RE.test(customerId) || !UUID_RE.test(contactId)) return c.json({ error: 'Contact not found' }, 404);

  try {
    const result = await removeContact(getDb(), { workspaceId, customerId, contactId });
    await writeAudit({
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'customer.contact_removed',
      targetType: 'customer',
      targetId: customerId,
      metadata: { customer_id: customerId, kind: result.removed.kind, contact_id: result.removed.id },
    });
    return c.json(result);
  } catch (err) {
    return contactErrorResponse(c, err);
  }
});

customers.post('/:id/contacts/:contactId/primary', async (c) => {
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  const contactId = c.req.param('contactId');
  if (!UUID_RE.test(customerId) || !UUID_RE.test(contactId)) return c.json({ error: 'Contact not found' }, 404);

  try {
    const result = await setPrimaryContact(getDb(), { workspaceId, customerId, contactId });
    await writeAudit({
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'customer.contact_primary_changed',
      targetType: 'customer',
      targetId: customerId,
      metadata: { customer_id: customerId, kind: result.contact.kind, contact_id: result.contact.id },
    });
    // syncPrimaryMirror cleared the lookup stamp when the primary email
    // changed; probe the new address right away rather than on the next email.
    if (result.contact.kind === 'email') scheduleLink({ workspaceId, customerId, email: result.contact.value, actorUserId: c.get('userId'), reason: 'contact_edit' });
    return c.json(result);
  } catch (err) {
    return contactErrorResponse(c, err);
  }
});

// ─── PATCH /:id — edit the profile's core details ───────────────────────────
// The pinned details card's save (Phase 4, PR 6). Member-level, like custom-
// field values and contact edits: every save is audited, so the permission can
// be tightened later without losing history. Email and mobile are NOT here —
// they are contact rows with their own endpoints above, each its own audited
// action; the Maestro ids are server-owned (lib/player-identity.ts). A blank
// input means "clear" (null) for every nullable column; first/last can't be
// blanked (the layout locks them required).
const blankToNull = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && !v.trim()) ? null : v, inner.nullable()).optional();
// The regex admits 2024-02-30; round-tripping through Date rejects it here as
// a 400 instead of letting Postgres raise 22008 (a 500).
// Year 0000 round-trips through JS Date but Postgres `date` has no year 0
// (22008 → a 500), hence the >= 1 check.
const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 1 && d.toISOString().slice(0, 10) === s;
};
const PatchCustomer = z.object({
  first_name:     z.string().trim().min(1).max(100).optional(),
  last_name:      z.string().trim().min(1).max(100).optional(),
  username:       blankToNull(z.string().trim().max(100)),
  brand:          blankToNull(z.string().trim().max(100)),
  vip_tier:       blankToNull(z.string().trim().max(50)),
  jurisdiction:   blankToNull(z.string().trim().max(100)),
  since:          blankToNull(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealDate, 'Invalid date')),
  backoffice_url: blankToNull(z.string().trim().max(2048).url().refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) link')),
  // The column is nullable, but null and false both mean "no consent": the
  // form only ever sends a boolean and the diff below reads null as false, so
  // saving an untouched form can't produce a phantom change + audit row.
  consent:        z.boolean().optional(),
}).strict();
type PatchCol = keyof z.infer<typeof PatchCustomer>;

// Which columns may have their VALUES written into the audit row: the
// whitelist minus lib/gdpr-erasure.ts's PII list (names, username,
// jurisdiction, the backoffice link). audit_events is append-only and outside
// erasure, so for PII only the field NAME is recorded (same rule the contact
// audits above follow for addresses). Derived, not copied, so a column added
// to the PII list can't keep leaking through here.
const PATCH_AUDIT_VALUE_COLS: ReadonlySet<string> = new Set(
  Object.keys(PatchCustomer.shape).filter((k) => !(CUSTOMER_PII_FIELDS as readonly string[]).includes(k)),
);

customers.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const raw = await c.req.json().catch(() => null);
  const parsed = PatchCustomer.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const body = parsed.data;
  if (Object.keys(body).length === 0) return c.json({ error: 'No fields to update' }, 400);

  type Changed = Record<string, { from: unknown; to: unknown }>;
  const outcome = await sql.begin(async (tx) => {
    // Lock the customers row first — the same order lockCustomerForContacts
    // and the merge transaction use — then read contacts without locks.
    const [row] = await tx<Record<string, unknown>[]>`
      select ${tx.unsafe(CUSTOMER_ROW_COLS)} from customers
      where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
      for update
    `;
    if (!row) return { status: 404, body: { error: 'Customer not found' } };
    // Never write PII back onto an erased profile (Art. 17), and never edit a
    // merged-away duplicate the UI deliberately hides — its survivor is the
    // record now.
    if (row.erased_at) return { status: 409, body: { error: "This customer's personal data has been erased", code: 'erased' } };
    if (row.merged_into_customer_id) {
      return { status: 409, body: { error: 'This profile is merged — edit the survivor instead', code: 'merged', merged_into_customer_id: row.merged_into_customer_id } };
    }

    const updates: Record<string, unknown> = {};
    const changed: Changed = {};        // response: every change (the agent just typed them)
    const audited: Changed = {};        // audit row: values for non-PII columns only
    const changedPii: string[] = [];
    for (const [col, to] of Object.entries(body) as [PatchCol, unknown][]) {
      if (to === undefined) continue;
      const from = col === 'consent' ? Boolean(row.consent) : (row[col] ?? null);
      if (from === to) continue;
      updates[col] = to;
      changed[col] = { from, to };
      if (PATCH_AUDIT_VALUE_COLS.has(col)) audited[col] = { from, to };
      else changedPii.push(col);
    }
    if (Object.keys(updates).length === 0) {
      return { status: 200, body: { customer: { ...row, ...(await contactsFor(tx, workspaceId, customerId)) }, changed: {} } };
    }
    const [updated] = await tx<Record<string, unknown>[]>`
      update customers set ${tx(updates)}
      where id = ${customerId} and workspace_id = ${workspaceId}
      returning ${tx.unsafe(CUSTOMER_ROW_COLS)}
    `;
    const response = { customer: { ...updated, ...(await contactsFor(tx, workspaceId, customerId)) }, changed };
    return { status: 200, body: response, audit: { changed: audited, changed_pii: changedPii } };
  });

  if ('audit' in outcome && outcome.audit) {
    await writeAudit({
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'customer.updated',
      targetType: 'customer',
      targetId: customerId,
      metadata: { customer_id: customerId, changed: outcome.audit.changed, changed_pii: outcome.audit.changed_pii },
    });
  }
  return c.json(outcome.body, outcome.status as 200);
});

// GET /:id/export — GDPR right-of-access / portability (Art. 15 / 20). Admin-only;
// returns the customer's full personal-data bundle as a downloadable JSON file.
// ─── Profile history ────────────────────────────────────────────────────────
// The customer profile page's counts, CSAT, topics, timeline and ticket table.
// Member-level (the whole router is behind requireAuth) — this is the same
// data an agent can already reach by opening the tickets, just aggregated, so
// it needs no admin gate and writes no audit row, unlike /export.
//
// Both routes answer 404 identically for "no such customer" and "belongs to
// another workspace", so they can't be used to probe for ids across tenants.
customers.get('/:id/summary', async (c) => {
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const summary = await customerSummary({ workspaceId, customerId });
  if (!summary) return c.json({ error: 'Customer not found' }, 404);
  return c.json(summary);
});

// Subsequent pages of the profile's ticket table. Page 0 already ships inside
// /summary, so this exists purely for "Load more".
customers.get('/:id/tickets', async (c) => {
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const limit = parseInt(c.req.query('limit') ?? '', 10);
  const offset = parseInt(c.req.query('offset') ?? '', 10);

  // Existence is checked rather than inferred from an empty page: a customer
  // with no tickets and a customer in another workspace both return zero rows,
  // and only one of those is a 404. Shares customerVisible() with /summary so
  // the "missing, wrong-workspace and soft-deleted are indistinguishable" rule
  // lives in exactly one place.
  if (!(await customerVisible(workspaceId, customerId))) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  const page = await customerTicketPage({
    workspaceId,
    customerId,
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  });
  // total is null on later pages (the count is computed on page 0 only); omit
  // the key rather than sending null, matching GET /tickets.
  const { total, ...rest } = page;
  return c.json(total === null ? rest : { ...rest, total });
});

customers.get('/:id/export', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const bundle = await exportCustomer({ workspaceId, customerId });
  if (!bundle) return c.json({ error: 'Customer not found' }, 404);

  // Already erased → there's no personal data left to hand out. Signal it
  // distinctly instead of returning a mostly-null skeleton with 200.
  if (bundle.erased) {
    return c.json({ error: 'This customer\'s personal data has been erased', erased_at: bundle.customer.erased_at }, 410);
  }

  // Exporting everything we hold about a person is a sensitive read — log it.
  await writeAudit({
    workspaceId,
    actorUserId: userId,
    action: 'customer.exported',
    targetType: 'customer',
    targetId: customerId,
    metadata: { tickets: bundle.tickets.length, notes: bundle.notes.length, inbox_messages: bundle.inbox_messages.length },
  });

  // Sanitise the filename — display_id is workspace-controlled, so strip
  // anything outside a safe set before it lands in the header (no quote/CRLF
  // breakout of the Content-Disposition value).
  const safeId = String(bundle.customer.display_id ?? customerId).replace(/[^A-Za-z0-9._-]/g, '_');
  c.header('Content-Disposition', `attachment; filename="customer-${safeId}-export.json"`);
  return c.json(bundle);
});

// POST /:id/erase — GDPR right-to-erasure for a customer. Admin-only (the brand
// owner handles erasure requests; platform admins too via requireWorkspaceAdmin).
// Nulls/redacts the customer's PII across all surfaces + writes the audit row.
customers.post('/:id/erase', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = eraseBody.safeParse(raw ?? {});
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  const reason = parsed.data.reason || null;

  // A merged-away source must be UNMERGED before erasure: the merge re-homed
  // its tickets and notes onto the survivor, and eraseCustomer redacts by
  // customer_id — erasing while merged would leave the person's emails and
  // notes un-redacted on the survivor (Art. 17 failure) and their merge
  // pointer dangling. performUnmerge restores everything to this profile
  // first (and writes its own survivor note); the redaction below then
  // reaches all of it.
  // Erasing a merge SURVIVOR would over-redact: its tickets include the
  // merged-in history of its duplicates (customer_id points at the survivor),
  // so by-customer_id redaction would destroy THEIR correspondence too, and
  // a later unmerge would hand redacted tickets back. Unmerge the duplicates
  // first, then erase each profile individually.
  const [childOfTarget] = await getDb()`
    select 1 from customers
    where workspace_id = ${workspaceId} and merged_into_customer_id = ${customerId} and deleted_at is null
    limit 1
  `;
  if (childOfTarget) {
    return c.json({ error: 'This profile has merged duplicates — unmerge them before erasing, or their tickets would be redacted too', code: 'has_merged_children' }, 409);
  }

  const [mergeState] = await getDb()<{ merged_into_customer_id: string | null }[]>`
    select merged_into_customer_id from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (mergeState?.merged_into_customer_id) {
    const un = await performUnmerge(workspaceId, userId, customerId);
    if (un.status !== 200) return c.json(un.body, un.status as 200);
    await writeAudit({
      workspaceId,
      actorUserId: userId,
      action: 'customer.unmerged',
      targetType: 'customer',
      targetId: customerId,
      metadata: { from: un.audit.from, tickets_restored: un.audit.tickets, notes_restored: un.audit.notes, contacts_restored: un.audit.contacts, fields_reverted: un.audit.reverted, fields_kept_due_to_edit: un.audit.kept, fields_skipped: un.audit.skipped, reason: 'pre-erasure' },
    });
  }

  const result = await eraseCustomer({ workspaceId, customerId, requestedByUserId: userId, reason });
  if (!result) return c.json({ error: 'Customer not found' }, 404);

  // Only audit a real erasure, not an idempotent re-request on an already-erased
  // customer (no new gdpr_erasures row was written either).
  if (!result.alreadyErased) {
    await writeAudit({
      workspaceId,
      actorUserId: userId,
      action: 'customer.erased',
      targetType: 'customer',
      targetId: customerId,
      metadata: {
        fields_erased: result.fieldsErased,
        tickets_affected: result.ticketsAffected,
        notes_deleted: result.notesDeleted,
        messages_redacted: result.messagesRedacted,
        inbox_redacted: result.inboxRedacted,
        attachments_deleted: result.attachmentsDeleted,
        reason,
      },
    });
  }

  return c.json(result);
});
