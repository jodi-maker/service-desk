// Data-retention purge (owner decision 2026-06-22): delete resolved tickets once
// they pass their workspace's retention window, measured from resolved_at. The
// PII-bearing child ROWS (messages, attachments, csat, time entries, viewers, …)
// are removed by the ON DELETE CASCADE FKs to tickets; aggregate logs that
// reference a ticket with ON DELETE SET NULL (ai_usage_log, automation events)
// are retained with their ticket link nulled.
//
// Attachment FILES live in R2 (ticket_attachments.storage_key) and the cascade
// can't reach them. Each batch therefore, inside ONE transaction: locks the
// victim tickets (FOR UPDATE — an inbound reply inserting an attachment row
// takes FOR KEY SHARE on the ticket, so it waits and then fails the FK rather
// than slipping a file past us), gathers their keys, writes them to the
// pending_object_deletions OUTBOX, and deletes the tickets. After commit the
// objects are deleted and the outbox rows cleared (lib/object-outbox.ts). A
// crash or storage outage anywhere leaves a durable pointer for the cron
// sweep — never an orphaned customer file.
//
// Set-based across all workspaces, each applying its own retention_days — no
// per-workspace loop, so cost doesn't grow with brand count. NULL retention_days
// = purge disabled for that workspace (legal hold).
//
// Deleted in bounded batches rather than one statement: a large expiry backlog
// (and its ON DELETE CASCADE children) in a single transaction means a long
// lock, big WAL, and statement-timeout risk. Each batch is its own transaction,
// so total work is unchanged but no single one is unbounded. Termination: when a
// batch removes fewer than batchSize rows, nothing expired remains.

import { getDb } from './db.js';
import { deleteAttachmentObjects, drainObjectDeletions, enqueueObjectDeletions, type DeleteObjectsFn } from './object-outbox.js';

export interface RetentionDeps {
  // Injectable so tests can record the keys without R2 config or a network call.
  deleteObjects?: DeleteObjectsFn;
}

export interface PurgeResult {
  purgedTickets: number;
  // Attachment objects removed from storage in this run.
  objectsDeleted: number;
  // Attachment objects whose delete failed; they stay in the outbox for the
  // cron sweep. The caller alerts when this is non-zero.
  objectsFailed: number;
}

export async function purgeExpiredTickets(batchSize = 500, deps: RetentionDeps = {}): Promise<PurgeResult> {
  const deleteObjects = deps.deleteObjects ?? deleteAttachmentObjects;
  const db = getDb();
  const batch = Math.max(1, batchSize); // guard against a 0/negative → infinite loop
  const result: PurgeResult = { purgedTickets: 0, objectsDeleted: 0, objectsFailed: 0 };
  for (;;) {
    const { count, keys } = await db.begin(async (sql) => {
      const expiring = await sql<{ id: string }[]>`
        select t.id
        from tickets t
        join workspaces w on w.id = t.workspace_id
        where w.deleted_at is null
          and w.retention_days is not null
          and t.resolved_at is not null
          and t.resolved_at < now() - make_interval(days => w.retention_days)
        limit ${batch}
        for update of t skip locked
      `;
      if (expiring.length === 0) return { count: 0, keys: [] as string[] };
      const ids = expiring.map((r) => r.id);
      const atts = await sql<{ storage_key: string }[]>`
        select storage_key from ticket_attachments where ticket_id in ${sql(ids)}
      `;
      const keys = [...new Set(atts.map((a) => a.storage_key))];
      await enqueueObjectDeletions(sql, keys, 'retention');
      const deleted = await sql`delete from tickets where id in ${sql(ids)}`;
      return { count: deleted.count, keys };
    });
    result.purgedTickets += count;

    if (keys.length) {
      const drained = await drainObjectDeletions(keys, deleteObjects);
      result.objectsDeleted += drained.deleted.length;
      result.objectsFailed += drained.failed.length;
      if (drained.failed.length) {
        console.error(
          `[retention] ${drained.failed.length} attachment object(s) could not be deleted — left in pending_object_deletions for the cron sweep`,
        );
      }
    }

    if (count < batch) break;
  }
  return result;
}
