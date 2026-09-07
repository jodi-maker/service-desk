// Player identity linking — attach a contact to its Maestro player.
//
// Contacts created from inbound email / the portal are stubs (name + email).
// This module asks the Maestro gateway for the player behind the address that
// wrote in and, on an exact match, stores the player's stable ids on the
// customers row (maestro_user_id = the global Maestro id, maestro_member_id =
// the per-brand member number) and fills username / VIP / country / brand / mobile
// where the contact has none — an agent's value is never overwritten, and a
// contact that already has a maestro_user_id is never re-pointed.
//
// Everything here is BEST-EFFORT and additive, like lib/player-context.ts: a
// missing token, a workspace without a brand, an unreachable gateway or any DB
// error is logged and swallowed. Linking must never fail an inbound webhook or
// a portal submission — those call scheduleLink() fire-and-forget.
//
// The brand id comes from the contact's OWN workspace (workspaces.
// maestro_brand_id), never from a caller, so a lookup can only pull a brand's
// player data into the workspace that projects that brand. Ids are never
// added to the triage prompt (the LLM boundary in lib/player-context.ts is
// unchanged).

import type postgres from 'postgres';
import { getDb } from './db.js';
import { workerFetch, workerMaestroConfigured, MaestroError, memberNotFound, str } from './maestro.js';
import { maestroBrandIdForWorkspace } from './maestro-workspace.js';
import { writeAudit } from '../middleware/platform-admin.js';
import type { PlayerAccessCategory } from './player-audit.js';
import { ensurePrimaryContacts, syncPrimaryMirror } from './customer-contacts.js';

export { memberNotFound };

type Db = postgres.Sql<{}> | postgres.TransactionSql<{}>;
type Member = Record<string, unknown>;

export type LinkReason = 'inbound_email' | 'portal' | 'contact_edit' | 'backfill' | 'profile_open';

export type LinkOutcome =
  | 'linked'          // ids written (and blanks filled)
  | 'not_found'       // gateway knows no player with this email; lookup stamped
  | 'email_mismatch'  // gateway matched a USERNAME, not the email; stamped, nothing written
  | 'identity_mismatch' // linked player lookup returned a different account
  | 'rejected'        // gateway refused THIS address (400/422); stamped, nothing written
  | 'no_player_id'    // member record carries no userId — nothing stable to link to; stamped
  | 'unconfigured'    // no MAESTRO_API_TOKEN
  | 'no_brand'        // workspace is not a Maestro brand (unrouted bucket, legacy tenant)
  | 'skipped'         // erased / merged-away / complete / checked recently
  | 'failed';         // gateway or DB error (logged, NOT stamped — retried next time)

/** Minimum interval between completed account lookups, including partial data. */
export const LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;

/** Shared by profile repair and new customers created from a player lookup. */
export function playerProfileFields(member: Member, brandName: string | null) {
  return {
    username: str(member.username),
    vip_tier: str(member.vipLevel) ?? str(member.vipTier) ?? str(member.tier),
    jurisdiction: str(member.country),
    brand: str(brandName),
  };
}

/**
 * Audit categories for what a link PERSISTS onto the contact (mirrors the
 * 'player.viewed' vocabulary in lib/player-audit.ts; never the values). We
 * store contact data always (ids, username, country) and VIP when present —
 * balance is never persisted, so it's never claimed here.
 */
export function linkedCategories(member: Member): PlayerAccessCategory[] {
  const accessed: PlayerAccessCategory[] = ['contact'];
  if (playerProfileFields(member, null).vip_tier) accessed.push('vip');
  return accessed;
}

/**
 * Fill blanks from the same account, never change an existing identity.
 * Hold the customer lock while maintaining contacts and their scalar mirrors,
 * matching the lock order used by contact edits, merges and erasure.
 */
export async function applyPlayerToCustomer(
  sql: postgres.Sql<{}>,
  args: { workspaceId: string; customerId: string; member: Member },
): Promise<boolean> {
  const m = args.member;
  const userId = str(m.userId);
  if (!userId) return false;
  return sql.begin(async (tx) => {
    const [current] = await tx<Record<string, unknown>[]>`
      select c.maestro_user_id, c.maestro_member_id, c.username, c.vip_tier,
             c.jurisdiction, c.brand, c.email, c.mobile, w.name as workspace_name
      from customers c join workspaces w on w.id = c.workspace_id
      where c.id = ${args.customerId} and c.workspace_id = ${args.workspaceId}
        and c.erased_at is null and c.deleted_at is null and c.merged_into_customer_id is null
        and w.deleted_at is null and w.maestro_brand_id is not null
        and (c.maestro_user_id is null or c.maestro_user_id = ${userId})
      for update of c
    `;
    if (!current) return false;
    const fields = {
      maestro_user_id: userId,
      maestro_member_id: str(m.memberId),
      ...playerProfileFields(m, str(current.workspace_name)),
    };
    const updates: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!str(current[key]) && value) updates[key] = value;
    }
    // Heal legacy contacts first so a saved mobile always wins. Only add the
    // account mobile when no live mobile contact exists.
    await ensurePrimaryContacts(tx, {
      workspaceId: args.workspaceId, customerId: args.customerId,
      email: str(current.email), mobile: str(current.mobile),
    });
    const [existingMobile] = await tx`
      select 1 from customer_contacts
      where workspace_id = ${args.workspaceId} and customer_id = ${args.customerId}
        and kind = 'mobile' and deleted_at is null
    `;
    const mobile = !existingMobile && !str(current.mobile) ? str(m.mobile) : null;
    if (mobile) {
      await ensurePrimaryContacts(tx, { workspaceId: args.workspaceId, customerId: args.customerId, mobile });
      await syncPrimaryMirror(tx, args.workspaceId, args.customerId);
    }
    if (!Object.keys(updates).length && !mobile) return false;
    await tx`
      update customers set ${tx({ ...updates, player_lookup_at: new Date() })}
      where id = ${args.customerId} and workspace_id = ${args.workspaceId}
    `;
    return true;
  });
}

export interface LinkArgs {
  workspaceId: string;
  customerId: string;
  reason: LinkReason;
  /**
   * The address that actually wrote in / was just added. A player whose casino
   * login is a SECONDARY address on the profile would never match on the
   * primary mirror, so callers that know the address pass it; the backfill
   * (which only knows the row) falls back to customers.email.
   */
  email?: string | null;
  /**
   * The signed-in agent whose action triggered the link (adding / promoting an
   * address). Recorded as the audit actor; omitted for headless paths (inbound
   * mail, portal, backfill), which audit as the system actor.
   */
  actorUserId?: string | null;
}

/**
 * Link by email or refresh the already-linked Maestro ID. Never throws — every
 * failure path logs and resolves to an outcome, so callers can `void` it.
 */
const activeLinks = new Map<string, Promise<LinkOutcome>>();

export async function linkCustomerToPlayer(args: LinkArgs): Promise<LinkOutcome> {
  const key = `${args.workspaceId}:${args.customerId}:${args.email ?? ''}`;
  const active = activeLinks.get(key);
  if (active) return active;
  const pending = runLink(args);
  activeLinks.set(key, pending);
  try { return await pending; }
  finally { activeLinks.delete(key); }
}

async function runLink(args: LinkArgs): Promise<LinkOutcome> {
  try {
    return await link(args);
  } catch (err) {
    console.warn(
      `[player-identity] link failed (${args.reason}, customer ${args.customerId}):`,
      err instanceof Error ? err.message : err,
    );
    return 'failed';
  }
}

/**
 * Fire-and-forget wrapper for request paths. On Vercel (staging / previews) a
 * function can be frozen the moment the response is sent, so the pending work
 * is registered with waitUntil — same guard as lib/outgoing-webhooks.ts. On
 * the long-running Node container (prod) the promise simply runs on.
 */
export function scheduleLink(args: LinkArgs): void {
  const p = linkCustomerToPlayer(args);
  if (process.env.VERCEL) {
    void import('@vercel/functions').then(({ waitUntil }) => waitUntil(p));
  }
}

interface CustomerRow {
  email: string | null;
  maestro_user_id: string | null;
  player_lookup_at: Date | string | null;
  erased_at: Date | string | null;
  merged_into_customer_id: string | null;
  username: string | null;
  vip_tier: string | null;
  jurisdiction: string | null;
  brand: string | null;
  mobile: string | null;
}

async function link(args: LinkArgs): Promise<LinkOutcome> {
  if (!workerMaestroConfigured()) return 'unconfigured';
  const sql = getDb();

  const [c] = await sql<CustomerRow[]>`
    select email, maestro_user_id, player_lookup_at, erased_at, merged_into_customer_id,
           username, vip_tier, jurisdiction, brand, mobile
    from customers
    where id = ${args.customerId} and workspace_id = ${args.workspaceId} and deleted_at is null
  `;
  if (!c || c.erased_at || c.merged_into_customer_id) return 'skipped';
  if (c.maestro_user_id && [c.username, c.vip_tier, c.jurisdiction, c.brand, c.mobile].every(str)) return 'skipped';
  const email = str(args.email) ?? c.email;
  if (!c.maestro_user_id && !email) return 'skipped';
  if (c.player_lookup_at && Date.now() - new Date(c.player_lookup_at).getTime() < LOOKUP_TTL_MS) return 'skipped';

  const brandId = await maestroBrandIdForWorkspace(args.workspaceId);
  if (!brandId) return 'no_brand';

  // Lookup is by ONE exact key. Not-found is a 200 envelope (memberNotFound);
  // a 404 from the gateway is treated the same way. A deterministic per-contact
  // rejection (400/422 — the gateway won't accept THIS address, e.g. malformed
  // or over-long) is stamped too, as its own outcome: retrying it every run
  // would pin `remaining` above zero forever, while a RUN of rejections is
  // something the backfill still aborts on (a changed API contract would
  // otherwise stamp every contact as checked). Everything else — 401/403
  // (token / brand grant), 429, 5xx, network — propagates to the outer catch
  // as 'failed' WITHOUT stamping, so a transient outage gets retried on the
  // contact's next email rather than waiting a day.
  let member: Member | null;
  try {
    const res = await workerFetch<Member>('/api/v1/proxy/member/lookup', {
      brandId,
      query: c.maestro_user_id ? { maestroUserId: c.maestro_user_id } : { email },
    });
    member = memberNotFound(res) ? null : res;
  } catch (err) {
    if (err instanceof MaestroError && err.status === 404) member = null;
    else if (err instanceof MaestroError && (err.status === 400 || err.status === 422)) {
      await stampLookup(sql, args);
      return 'rejected';
    } else throw err;
  }

  if (!member) {
    await stampLookup(sql, args);
    return 'not_found';
  }

  // The gateway's `email` param also matches usernames. A contact whose email
  // happens to equal some OTHER player's username would otherwise be linked to
  // that player — so only an exact (case-insensitive) email match counts.
  const memberEmail = str(member.email);
  if (!c.maestro_user_id && (!memberEmail || memberEmail.toLowerCase() !== email!.toLowerCase())) {
    await stampLookup(sql, args);
    return 'email_mismatch';
  }

  // No global id → nothing stable to link to. Stamp so we don't re-ask daily.
  if (!str(member.userId)) {
    await stampLookup(sql, args);
    return 'no_player_id';
  }

  if (c.maestro_user_id && str(member.userId) !== c.maestro_user_id) {
    await stampLookup(sql, args);
    return 'identity_mismatch';
  }

  const linked = await applyPlayerToCustomer(sql, { workspaceId: args.workspaceId, customerId: args.customerId, member });
  await stampLookup(sql, args);
  if (!linked) return 'skipped';   // a concurrent link won, or the row changed under us

  // Same shape as 'player.viewed' (routes/maestro.ts): categories, never
  // values. Actor = the agent whose contact edit triggered this, else the
  // system (inbound mail / portal / backfill have no signed-in user).
  await writeAudit({
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId ?? null,
    action: c.maestro_user_id ? 'customer.player_refreshed' : 'customer.player_linked',
    targetType: 'customer',
    targetId: args.customerId,
    metadata: { brand_id: brandId, reason: args.reason, accessed: linkedCategories(member) },
  });
  return 'linked';
}

async function stampLookup(sql: Db, args: { workspaceId: string; customerId: string }): Promise<void> {
  await sql`
    update customers set player_lookup_at = now()
    where id = ${args.customerId} and workspace_id = ${args.workspaceId}
      and erased_at is null and deleted_at is null and merged_into_customer_id is null
  `;
}

// ─── One-off backfill (cron-run.ts `player-identity-backfill`) ─────────────

export interface PlayerIdentityBackfillResult {
  workspaces: number;
  attempted: number;
  linked: number;
  notFound: number;
  mismatched: number;
  /** Gateway refused the address itself (400/422) — stamped, see LinkOutcome. */
  rejected: number;
  noPlayerId: number;
  skipped: number;
  failed: number;
  /** Unlinked, never-checked contacts still waiting after this run — re-run until 0. */
  remaining: number;
}

/** Consecutive 'failed' outcomes that abort a run — a dead/expired token or a
 *  brand the app isn't installed on fails EVERY lookup, and hammering the
 *  gateway 500 more times won't change that. */
export const BACKFILL_ABORT_AFTER_FAILURES = 5;

/** Consecutive 'rejected' (400/422) outcomes that abort a run. A handful of
 *  genuinely malformed addresses is normal and gets stamped; twenty in a row
 *  means the gateway is refusing the REQUEST shape (contract change), and
 *  stamping every contact as "checked" would hide that for a day. */
export const BACKFILL_ABORT_AFTER_REJECTIONS = 20;

/**
 * The job's own, operator-facing abort: carries the partial counts and a hint
 * (never values, never DB error text). HTTP callers may forward `.message`
 * verbatim; any OTHER error (DB down, schema mismatch) must stay generic.
 */
export class BackfillAbortError extends Error {
  constructor(
    message: string,
    public readonly result: PlayerIdentityBackfillResult,
    /** 'unconfigured' = pre-flight config gap (no page); 'gateway_failures' = the run itself died. */
    public readonly kind: 'unconfigured' | 'gateway_failures',
  ) {
    super(message);
    this.name = 'BackfillAbortError';
  }
}

/** A second backfill was requested while one is still running (any process). */
export class BackfillBusyError extends Error {
  constructor() {
    super('player-identity backfill is already running — wait for it to finish, then re-run');
    this.name = 'BackfillBusyError';
  }
}

// Single-flight guard, held in POSTGRES (session advisory lock on a reserved
// connection) so it spans every entry point — the HTTP route, the CLI in the
// container, a second replica, a redeploy overlap — not just this process.
// Two overlapping runs would select the same un-stamped candidates (the stamp
// lands only after each lookup) and double the gateway load; an HTTP caller
// looping "until remaining is 0" can easily do that when the previous call
// timed out at the edge while the job kept running.
const BACKFILL_LOCK_KEY = 'player-identity-backfill';

/**
 * Walk every Maestro-brand workspace and link its unlinked, never-checked
 * contacts, `perWorkspace` at a time with bounded concurrency. Idempotent:
 * every contact it touches is either linked or stamped, so re-running
 * converges. `failed` outcomes are NOT stamped (they retry next run); a run
 * of consecutive failures THROWS (cron-run exits 1) with the partial counts,
 * so an operator "repeating until remaining = 0" can't loop on a broken token.
 */
export interface BackfillOptions {
  /** Candidates selected per brand workspace per run (page size). */
  perWorkspace?: number;
  /** Parallel gateway lookups. */
  concurrency?: number;
  /**
   * Hard cap on contacts attempted per CALL, across all brands — the knob
   * that bounds an HTTP invocation's wall-clock (Cloudflare cuts responses
   * at ~100 s). The run stops cleanly at the cap and reports `remaining`.
   */
  maxAttempts?: number;
  /**
   * Wall-clock deadline for this call. Checked between chunks: once elapsed,
   * the run stops cleanly and reports `remaining` — the second half of the
   * HTTP bound (a 4-wide chunk of slow lookups can take a while each).
   */
  deadlineMs?: number;
}

export async function runPlayerIdentityBackfillJob(opts: BackfillOptions = {}): Promise<PlayerIdentityBackfillResult> {
  const sql = getDb();
  // Session-level advisory lock on a RESERVED connection (pg_try_advisory_lock
  // is per session; through the pool a later query could land elsewhere).
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${BACKFILL_LOCK_KEY})) as locked`;
    if (!locked) throw new BackfillBusyError();
    try {
      return await runBackfillInner(sql, opts);
    } finally {
      // Never let an unlock hiccup replace the job's own error. Note that
      // release() hands the connection BACK TO THE POOL (the session lives on,
      // and so would a lock still held on it), so on failure try the blunt
      // form once more; if the connection itself is broken — the realistic
      // cause — postgres.js drops it from the pool and the session-scoped
      // lock dies with it.
      try {
        await conn`select pg_advisory_unlock(hashtext(${BACKFILL_LOCK_KEY}))`;
      } catch (err) {
        console.warn('[player-identity] advisory unlock failed, retrying with unlock_all:', err instanceof Error ? err.message : err);
        try { await conn`select pg_advisory_unlock_all()`; } catch { /* connection is gone — lock gone with it */ }
      }
    }
  } finally {
    conn.release();
  }
}

async function runBackfillInner(sql: Db, opts: BackfillOptions): Promise<PlayerIdentityBackfillResult> {
  const perWorkspace = opts.perWorkspace ?? 500;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
  const result: PlayerIdentityBackfillResult = {
    workspaces: 0, attempted: 0, linked: 0, notFound: 0, mismatched: 0, rejected: 0, noPlayerId: 0, skipped: 0, failed: 0, remaining: 0,
  };

  if (!workerMaestroConfigured()) {
    result.remaining = await countRemaining(sql);
    throw new BackfillAbortError(
      `player-identity backfill: MAESTRO_API_TOKEN is not configured (${result.remaining} contacts waiting)`,
      result,
      'unconfigured',
    );
  }

  const workspaces = await sql<{ id: string }[]>`
    select id from workspaces where maestro_brand_id is not null and deleted_at is null order by created_at
  `;
  result.workspaces = workspaces.length;

  const startedAt = Date.now();
  const deadlineMs = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
  const outOfTime = (): boolean => Date.now() - startedAt >= deadlineMs;

  let consecutiveFailures = 0;
  let consecutiveRejections = 0;
  for (const ws of workspaces) {
    const budget = maxAttempts - result.attempted;
    if (budget <= 0 || outOfTime()) break;
    const candidates = await sql<{ id: string }[]>`
      select id from customers
      where workspace_id = ${ws.id}
        and maestro_user_id is null and email is not null and player_lookup_at is null
        and erased_at is null and deleted_at is null and merged_into_customer_id is null
      order by created_at asc
      limit ${Math.min(perWorkspace, budget)}
    `;
    for (let i = 0; i < candidates.length; i += concurrency) {
      if (outOfTime()) break;
      const outcomes = await Promise.all(
        candidates.slice(i, i + concurrency).map((c) =>
          linkCustomerToPlayer({ workspaceId: ws.id, customerId: c.id, reason: 'backfill' }),
        ),
      );
      for (const o of outcomes) {
        result.attempted++;
        if (o === 'linked') result.linked++;
        else if (o === 'not_found') result.notFound++;
        else if (o === 'email_mismatch') result.mismatched++;
        else if (o === 'rejected') result.rejected++;
        else if (o === 'no_player_id') result.noPlayerId++;
        else if (o === 'failed') result.failed++;
        else result.skipped++;
        consecutiveFailures = o === 'failed' ? consecutiveFailures + 1 : 0;
        consecutiveRejections = o === 'rejected' ? consecutiveRejections + 1 : 0;
      }
      if (consecutiveFailures >= BACKFILL_ABORT_AFTER_FAILURES) {
        result.remaining = await countRemaining(sql);
        throw new BackfillAbortError(
          `player-identity backfill aborted after ${consecutiveFailures} consecutive gateway failures ` +
          `(check MAESTRO_API_TOKEN / brand installation / gateway health): ${JSON.stringify(result)}`,
          result,
          'gateway_failures',
        );
      }
      if (consecutiveRejections >= BACKFILL_ABORT_AFTER_REJECTIONS) {
        result.remaining = await countRemaining(sql);
        throw new BackfillAbortError(
          `player-identity backfill aborted after ${consecutiveRejections} consecutive gateway rejections (400/422) ` +
          `— the lookup request shape is probably no longer accepted; check the member-lookup contract: ${JSON.stringify(result)}`,
          result,
          'gateway_failures',
        );
      }
    }
  }

  result.remaining = await countRemaining(sql);
  return result;
}

async function countRemaining(sql: Db): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n
    from customers c
    join workspaces w on w.id = c.workspace_id
    where w.maestro_brand_id is not null and w.deleted_at is null
      and c.maestro_user_id is null and c.email is not null and c.player_lookup_at is null
      and c.erased_at is null and c.deleted_at is null and c.merged_into_customer_id is null
  `;
  return n;
}
