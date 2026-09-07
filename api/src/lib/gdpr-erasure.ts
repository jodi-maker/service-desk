// GDPR right-to-erasure for a customer (data subject).
//
// Nulls/redacts the customer's personal data across every PII surface and
// writes a `gdpr_erasures` audit row, in ONE transaction. The customer + ticket
// rows are kept (anonymised) so the audit trail and aggregate analytics survive
// — see `20260520121300_gdpr.sql` for that design intent, and
// `docs/gdpr-pii-inventory.md` for the canonical surface list this implements.
//
// Idempotent: a customer already carrying `erased_at` short-circuits without a
// second pass or a duplicate audit row.

import { getDb } from './db.js';
import {
  deleteAttachmentObjects,
  drainObjectDeletions,
  enqueueObjectDeletions,
  sweepPendingObjectDeletions,
  type DeleteObjectsFn,
} from './object-outbox.js';
import { sendOpsAlert } from './alert.js';
import { inboxFromThisCustomer, repairCustomerContacts } from './customer-contacts.js';

// Marker for NOT NULL text columns we can't null (subject, message body).
const ERASED = '[erased]';

// The customers columns this nulls — recorded verbatim in gdpr_erasures.fields_erased.
//
// kyc_status stays here even though Phase 4 removed KYC from the product. The
// COLUMN still exists and every row created before that change still carries a
// value, so it is still personal data we hold. Erasure is idempotent (it
// short-circuits on erased_at), so a subject erased while it was omitted would
// keep that value forever — a later re-run would not clean it up. It comes out
// of this list in the same change that drops the column.
// Exported so other writers of customer data (routes/customers.ts PATCH audit)
// derive "which columns may have their VALUES logged" from this one list
// instead of keeping a second copy that can drift.
export const CUSTOMER_PII_FIELDS = [
  'first_name', 'last_name', 'username', 'email', 'mobile',
  'backoffice_url', 'kyc_status', 'jurisdiction',
  // Maestro player ids name the subject's casino account — direct identifiers.
  'maestro_user_id', 'maestro_member_id',
] as const;

// What gdpr_erasures.fields_erased records: the columns above plus 'contacts'
// — the customer_contacts rows (Phase 4 contacts model), which are a table,
// not a column, and are hard-deleted below.
const FIELDS_ERASED = [...CUSTOMER_PII_FIELDS, 'contacts'] as const;

export interface EraseResult {
  erased: boolean;
  alreadyErased: boolean;
  fieldsErased: string[];
  ticketsAffected: number;
  notesDeleted: number;
  messagesRedacted: number;
  inboxRedacted: number;
  attachmentsDeleted: number;
}

// The R2 object deleter — injectable so tests can record the keys without R2
// config or a network call. Defaults to the PRIVATE attachments bucket
// (lib/object-outbox.ts) — never the public brand-assets bucket.
export interface EraseDeps {
  deleteObjects?: DeleteObjectsFn;
}

/**
 * Erase a customer's personal data. Returns null if no such customer exists in
 * the workspace (caller maps to 404). Scoped by workspace_id throughout — there
 * is no DB-level tenant guard, so every statement carries the predicate.
 */
export async function eraseCustomer(args: {
  workspaceId: string;
  customerId: string;
  requestedByUserId: string | null;
  reason?: string | null;
}, deps: EraseDeps = {}): Promise<EraseResult | null> {
  const { workspaceId, customerId, requestedByUserId, reason } = args;
  const deleteObjects = deps.deleteObjects ?? deleteAttachmentObjects;
  const db = getDb();

  // Captured inside the transaction, consumed after it commits: the R2 object
  // keys to delete. R2 is not transactional, so we do the (irreversible) object
  // delete only once the DB is durably consistent — not mid-transaction where a
  // later failure would roll the rows back to point at already-deleted files, or
  // hold a pooled connection + row lock across network I/O. The same keys are
  // written to the pending_object_deletions outbox IN the transaction, so a
  // crash between commit and delete can't orphan a file.
  let attachmentKeys: string[] = [];

  const result = await db.begin(async (sql) => {
    // Lock the customer row (scoped) so a concurrent erase can't double-run.
    const [cust] = await sql<{ id: string; email: string | null; erased_at: string | null }[]>`
      select id, email, erased_at from customers
      where id = ${customerId} and workspace_id = ${workspaceId}
      for update
    `;
    if (!cust) return null;
    if (cust.erased_at) {
      return { erased: true, alreadyErased: true, fieldsErased: [], ticketsAffected: 0, notesDeleted: 0, messagesRedacted: 0, inboxRedacted: 0, attachmentsDeleted: 0 };
    }
    // The scalar is captured BEFORE nulling — the inbox match below also uses
    // it for a legacy profile with no contact rows.
    const email = cust.email;

    const ticketRows = await sql<{ id: string }[]>`
      select id from tickets where workspace_id = ${workspaceId} and customer_id = ${customerId}
    `;
    const ticketIds = ticketRows.map((r) => r.id);

    let messagesRedacted = 0;
    let ticketsAffected = 0;
    let inboxRedacted = 0;
    let attachmentsDeleted = 0;

    if (ticketIds.length) {
      const msgs = await sql`
        update ticket_messages set
          body = ${ERASED},
          -- The formatted body holds the same personal data as the text body
          -- (plus the customer's own markup): it must go with it.
          body_html = null,
          author_label = case when role = 'customer' then ${ERASED} else author_label end
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
      `;
      messagesRedacted = msgs.count;

      const tks = await sql`
        update tickets set subject = ${ERASED}, csat_comment = null, snooze_reason = null
        where workspace_id = ${workspaceId} and id in ${sql(ticketIds)}
      `;
      ticketsAffected = tks.count;

      const inbConv = await sql`
        update inbox_messages set
          from_name = null, from_email = null, subject = null, body = null, body_html = null, raw = null
        where workspace_id = ${workspaceId} and converted_ticket_id in ${sql(ticketIds)}
      `;
      inboxRedacted += inbConv.count;

      // Attachments: files live in R2 keyed by storage_key; the rows link only to
      // tickets (ON DELETE CASCADE) — but erasure KEEPS the tickets (anonymised),
      // so nothing removes them unless we do it here. Delete the rows in-txn
      // (atomic with the rest of the erase) and stash the keys; the R2 objects
      // are deleted after commit (see below).
      const atts = await sql<{ storage_key: string }[]>`
        delete from ticket_attachments
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
        returning storage_key
      `;
      attachmentKeys = [...new Set(atts.map((a) => a.storage_key))];
      attachmentsDeleted = atts.length;
      await enqueueObjectDeletions(sql, attachmentKeys, 'erasure');
    }

    // Un-converted inbound mail still in the inbox, matched by sender address —
    // EVERY address the subject held, each within its own lifetime, so mail a
    // later holder of a released address sent is not this subject's
    // (inboxFromThisCustomer). Runs BEFORE the contact rows are deleted below.
    const inbMail = await sql`
      update inbox_messages set
        from_name = null, from_email = null, subject = null, body = null, body_html = null, raw = null
      where workspace_id = ${workspaceId} and ${inboxFromThisCustomer(sql, workspaceId, customerId, email)}
    `;
    inboxRedacted += inbMail.count;

    const notes = await sql`
      delete from customer_notes where workspace_id = ${workspaceId} and customer_id = ${customerId}
    `;
    const notesDeleted = notes.count;

    // Contact rows are HARD-deleted: a soft-deleted row would keep the address
    // as personal data forever (same treatment notes get). The erase route
    // un-merges a merged-away source first, so its rows are back on it here.
    // …including rows a merge re-homed onto a survivor (stamped with this
    // subject's id). The erase route un-merges a LIVE merged-away source first,
    // but a source soft-deleted after its merge can't be un-merged, and its
    // addresses are still the subject's data. Survivors that held them get
    // their primaries and mirror repaired.
    const goneRows = await sql<{ customer_id: string }[]>`
      delete from customer_contacts
      where workspace_id = ${workspaceId}
        and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
      returning customer_id
    `;
    for (const holderId of new Set(goneRows.map((r) => r.customer_id).filter((id) => id !== customerId))) {
      await repairCustomerContacts(sql, workspaceId, holderId);
    }

    await sql`
      update customers set
        first_name = null, last_name = null, username = null, email = null,
        mobile = null, backoffice_url = null, kyc_status = null, jurisdiction = null,
        maestro_user_id = null, maestro_member_id = null, player_lookup_at = null,
        erased_at = now()
      where id = ${customerId} and workspace_id = ${workspaceId}
    `;

    await sql`
      insert into gdpr_erasures (workspace_id, customer_id, requested_by_user_id, completed_at, fields_erased, reason)
      values (${workspaceId}, ${customerId}, ${requestedByUserId}, now(), ${[...FIELDS_ERASED]}, ${reason ?? null})
    `;

    return {
      erased: true,
      alreadyErased: false,
      fieldsErased: [...FIELDS_ERASED],
      ticketsAffected,
      notesDeleted,
      messagesRedacted,
      inboxRedacted,
      attachmentsDeleted,
    };
  });

  // Post-commit: delete the attachment objects from R2. Done outside the txn so
  // no DB connection/lock is held across network I/O, and only after the DB is
  // durably erased. Each key that succeeds is cleared from the outbox; any that
  // fail stay there for the retry sweep (retryPendingObjectDeletions, run from
  // the retention cron) — the attachment rows are already gone, so the outbox
  // is the only durable record of what's left to delete. We also alert.
  // (`result` is only reached on commit.)
  if (result && !result.alreadyErased && attachmentKeys.length) {
    const { failed } = await drainObjectDeletions(attachmentKeys, deleteObjects);
    if (failed.length) {
      console.error(
        `[gdpr-erase] R2 object deletion failed for ${failed.length} key(s) of customer ${customerId} (workspace ${workspaceId}) — left in the outbox for retry`,
      );
      await sendOpsAlert({
        signature: `gdpr-erase-r2-fail:${workspaceId}:${customerId}`,
        severity: 'critical',
        title: 'GDPR erasure: attachment file deletion failed',
        detail:
          `Customer ${customerId} (workspace ${workspaceId}) was erased in the database, but ` +
          `${failed.length} attachment object(s) could not be deleted from storage. ` +
          `Left in pending_object_deletions for automatic retry on the next retention cron.\nKeys:\n` +
          failed.map((k) => `  • ${k}`).join('\n'),
      }).catch(() => {});
    }
  }

  return result;
}

/**
 * Retry sweep for attachment objects that failed to delete during erasure. Reads
 * gdpr_erasures rows still carrying pending_object_keys, re-attempts the R2
 * delete, and clears the keys on success. Idempotent and safe to run repeatedly
 * (re-deleting an already-gone key is a 404 = success). Best-effort per row: one
 * row's failure doesn't block the others. Runs from the retention cron.
 */
export async function retryPendingObjectDeletions(
  limit = 100,
  deps: EraseDeps = {},
): Promise<{
  swept: number; cleared: number; keysDeleted: number; parkedKeysDeleted: number;
  // Outbox keys that keep failing — the caller alerts on these.
  stuck: Array<{ storage_key: string; attempts: number; last_error: string | null }>;
}> {
  const deleteObjects = deps.deleteObjects ?? deleteAttachmentObjects;
  const sql = getDb();
  // The outbox (pending_object_deletions) — written by erasure AND the
  // retention purge. Per-key isolation inside the sweep: one stuck object
  // accrues attempts, everything else drains.
  let parkedKeysDeleted = 0;
  let stuck: Awaited<ReturnType<typeof sweepPendingObjectDeletions>>['stuck'] = [];
  try {
    const swept = await sweepPendingObjectDeletions(Math.max(1, limit), deleteObjects);
    parkedKeysDeleted = swept.deleted.length;
    stuck = swept.stuck;
    if (swept.failed.length) {
      console.warn(`[object-outbox] ${swept.failed.length} parked object deletion(s) still failing`);
    }
  } catch (err) {
    console.warn('[object-outbox] sweep failed:', err instanceof Error ? err.message : err);
  }
  // Legacy: keys parked on gdpr_erasures.pending_object_keys by erasures that
  // ran before the outbox existed. Drained here until the column is empty.
  const rows = await sql<{ id: string; pending_object_keys: string[] }[]>`
    select id, pending_object_keys from gdpr_erasures
    where pending_object_keys is not null and cardinality(pending_object_keys) > 0
    order by completed_at asc
    limit ${Math.max(1, limit)}
  `;
  let cleared = 0;
  let keysDeleted = 0;
  for (const row of rows) {
    try {
      await deleteObjects(row.pending_object_keys);
      await sql`update gdpr_erasures set pending_object_keys = null where id = ${row.id}`;
      cleared++;
      keysDeleted += row.pending_object_keys.length;
    } catch (err) {
      console.warn(`[gdpr-erase] retry still failing for erasure ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { swept: rows.length, cleared, keysDeleted, parkedKeysDeleted, stuck };
}
