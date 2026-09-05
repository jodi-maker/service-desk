// Outbox for R2 object deletions (pending_object_deletions).
//
// R2 is not transactional, so "delete the rows, then delete the files" has a
// window where a crash leaves files nobody can find any more. Callers that
// remove attachment rows (retention purge, GDPR erasure) therefore ENQUEUE the
// storage keys inside the same DB transaction, commit, and only then delete
// the objects — clearing each key from the outbox as it succeeds. Whatever is
// left (crash, storage outage, one bad key) is retried by the retention cron
// via sweepPendingObjectDeletions(), key by key, so a single permanently
// failing object can never block the others.

import type { Sql, TransactionSql } from 'postgres';
import { getDb } from './db.js';
import { attachmentsStore } from './r2.js';

export type DeleteObjectsFn = (keys: string[]) => Promise<void>;

// Default deleter — the PRIVATE attachments bucket. Injectable in tests.
export const deleteAttachmentObjects: DeleteObjectsFn = (keys) => attachmentsStore().deleteKeys(keys);

// How many object deletes are in flight at once during a drain. Each call
// deletes ONE key so a failure can be attributed to it (the store's own
// batching can't tell us which key of a batch failed).
const CONCURRENCY = 8;

// A drain runs inline in the request/cron that triggered it, so it must not run
// forever: with R2 timing out at 10 s per object, a large backlog would other-
// wise hold the retention cron open past the platform's request ceiling. When
// the budget is spent the remaining keys simply stay in the outbox for the next
// run — the whole point of having one.
const DEFAULT_BUDGET_MS = 20_000;

// After this many failed attempts a key is treated as stuck (a permanent
// problem — deleted bucket, revoked token, malformed key) and reported so an
// operator hears about it instead of it retrying silently forever.
export const STUCK_ATTEMPTS = 5;

// Truncate an error for the last_error column.
function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** In-transaction: record keys that are about to lose their DB pointer. */
export async function enqueueObjectDeletions(
  sql: TransactionSql | Sql,
  keys: string[],
  reason: 'retention' | 'erasure' | 'orphan',
): Promise<void> {
  if (keys.length === 0) return;
  await sql`
    insert into pending_object_deletions (storage_key, reason)
    select k, ${reason} from unnest(${keys}::text[]) as k
    on conflict (storage_key) do nothing
  `;
}

export interface DrainResult {
  deleted: string[];
  failed: string[];
  // Keys not attempted because the time budget ran out; still in the outbox.
  deferred: string[];
}

/**
 * Post-commit: delete the given objects one by one (bounded concurrency),
 * clearing each successful key from the outbox and stamping attempts /
 * last_error on the ones that failed. Never throws for a storage failure —
 * the caller decides whether to alert on `failed`.
 */
export async function drainObjectDeletions(
  keys: string[],
  deleteObjects: DeleteObjectsFn = deleteAttachmentObjects,
  opts: { budgetMs?: number } = {},
): Promise<DrainResult> {
  const sql = getDb();
  const deleted: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  const deadline = Date.now() + Math.max(1, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  let deferred: string[] = [];

  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      deferred = keys.slice(i);
      console.warn(`[object-outbox] time budget spent — ${deferred.length} key(s) left for the next run`);
      break;
    }
    const slice = keys.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(slice.map((key) => deleteObjects([key])));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') deleted.push(slice[idx]);
      else failed.push({ key: slice[idx], error: errText(r.reason) });
    });
  }

  // Bookkeeping is best-effort: a DB hiccup here leaves rows to be retried
  // (re-deleting an already-gone key is a 404 = success), never a lost file.
  try {
    if (deleted.length) {
      await sql`delete from pending_object_deletions where storage_key in ${sql(deleted)}`;
    }
    for (const f of failed) {
      await sql`
        update pending_object_deletions
        set attempts = attempts + 1, last_error = ${f.error}
        where storage_key = ${f.key}
      `;
    }
  } catch (err) {
    console.warn('[object-outbox] bookkeeping failed:', errText(err));
  }

  return { deleted, failed: failed.map((f) => f.key), deferred };
}

/**
 * Cron sweep: retry the oldest outbox rows. Per-key isolation via
 * drainObjectDeletions, so one stuck key never blocks the page or the rows
 * behind it (it just accrues attempts and stays visible).
 */
export async function sweepPendingObjectDeletions(
  limit = 200,
  deleteObjects: DeleteObjectsFn = deleteAttachmentObjects,
  opts: { budgetMs?: number } = {},
): Promise<DrainResult & { swept: number; stuck: StuckKey[] }> {
  const sql = getDb();
  const rows = await sql<{ storage_key: string }[]>`
    select storage_key from pending_object_deletions
    order by attempts asc, created_at asc
    limit ${Math.max(1, limit)}
  `;
  if (rows.length === 0) return { swept: 0, deleted: [], failed: [], deferred: [], stuck: [] };
  const res = await drainObjectDeletions(rows.map((r) => r.storage_key), deleteObjects, opts);
  return { swept: rows.length, ...res, stuck: await listStuckKeys() };
}

export interface StuckKey {
  storage_key: string;
  attempts: number;
  last_error: string | null;
}

/**
 * Outbox rows that have failed enough times to be a standing problem rather
 * than a blip. Reported by the retention cron so an operator is told about
 * files that can never be deleted (revoked token, wrong bucket, bad key).
 */
export async function listStuckKeys(limit = 20): Promise<StuckKey[]> {
  const sql = getDb();
  return sql<StuckKey[]>`
    select storage_key, attempts, last_error from pending_object_deletions
    where attempts >= ${STUCK_ATTEMPTS}
    order by attempts desc, created_at asc
    limit ${Math.max(1, limit)}
  `;
}
