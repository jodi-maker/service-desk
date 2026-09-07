// Scheduled-job implementations, shared by BOTH invocation paths:
//   - routes/cron.ts    — HTTP endpoints (Vercel Cron / manual curl, CRON_SECRET-gated)
//   - src/cron-run.ts   — CLI entry (self-hosted Dokploy schedules exec it in-container)
// Keeping the composition here means the two schedulers can never drift on
// WHAT a job does — only on when/how it's triggered.
import { getDb } from './db.js';
import { processPendingDeliveries } from './outgoing-webhooks.js';
import { purgeExpiredTickets } from './retention.js';
import { retryPendingObjectDeletions } from './gdpr-erasure.js';
import { STUCK_ATTEMPTS } from './object-outbox.js';
import { verifyAuditChains } from './audit-verify.js';
import { sweepEmailDomains } from './email-domains.js';
import { sendOpsAlert } from './alert.js';
import {
  BackfillAbortError, BackfillBusyError, runPlayerIdentityBackfillJob,
  type BackfillOptions, type PlayerIdentityBackfillResult,
} from './player-identity.js';

// One-off Maestro player-identity backfill (lib/player-identity.ts), wrapped
// with the same log + ops-alert + rethrow shape as the jobs below so BOTH
// entry points (CLI cron-run.ts and the HTTP route) page on a dead token.
// A "busy" rejection (already running) and the pre-flight "token not
// configured" abort are operator signals, not failures — no critical page (a
// page there would also burn the 1 h dedup cooldown that a REAL dead-token
// abort needs). Everything else alerts.
export async function runPlayerIdentityBackfill(opts: BackfillOptions = {}): Promise<PlayerIdentityBackfillResult> {
  try {
    return await runPlayerIdentityBackfillJob(opts);
  } catch (err) {
    if (err instanceof BackfillBusyError) throw err;
    if (err instanceof BackfillAbortError && err.kind === 'unconfigured') {
      console.warn('[cron] player-identity-backfill:', err.message);
      throw err;
    }
    await alertCronFailure('player-identity-backfill', err);
    throw err;
  }
}

// A cron job failed to run cleanly — fire a live alert (no-op until a channel
// is configured) so a silently-broken scheduled task surfaces. Signature is per
// job, so one alert per job per cooldown.
export async function alertCronFailure(job: string, err: unknown): Promise<void> {
  // One log line per failure lives HERE (not at every call site) so the
  // message shape — and any future redaction of raw error text — is decided once.
  console.error(`[cron] ${job} failed:`, err instanceof Error ? err.message : err);
  await sendOpsAlert({
    signature: `cron:${job}:fail`,
    severity: 'critical',
    title: `Cron job "${job}" failed`,
    detail: `The scheduled "${job}" job threw: ${err instanceof Error ? err.message : String(err)}`,
  });
}

// Webhook retry sweep. First attempts fire at dispatch time (inline flush /
// waitUntil in lib/outgoing-webhooks.ts), so this only catches rows whose
// retry backoff elapsed. Throws after alerting when the core sweep fails —
// callers translate that into their own failure signal (HTTP 500 / exit 1).
export async function runWebhookRetryJob(): Promise<{ processed: number }> {
  let processed: number;
  try {
    ({ processed } = await processPendingDeliveries());
  } catch (err) {
    await alertCronFailure('webhook-retry', err);
    throw err;
  }
  // Piggyback the daily housekeeping prunes (drop long-expired rate-limit
  // buckets and stale ops-alert dedup signatures). Best-effort.
  try { await getDb()`select prune_rate_limits()`; }
  catch (err) { console.warn('[cron] prune_rate_limits failed:', err instanceof Error ? err.message : err); }
  try { await getDb()`select prune_ops_alerts()`; }
  catch (err) { console.warn('[cron] prune_ops_alerts failed:', err instanceof Error ? err.message : err); }
  return { processed };
}

export interface RetentionJobResult {
  purgedTickets: number;
  // Attachment objects removed / left in the outbox by this run's purge.
  objectsDeleted: number;
  objectsFailed: number;
  audit?: { checked: number; tampered: number; full: boolean };
  objectRetry?: { swept: number; cleared: number; parkedKeysDeleted: number; stuck: number };
  emailDomains?: Awaited<ReturnType<typeof sweepEmailDomains>>;
}

// Data-retention purge — deletes resolved tickets (and cascaded children) past
// each workspace's retention window. Idempotent: a re-run just deletes whatever
// is now expired. Safe to run daily. Throws (after alerting) only when the
// core purge fails; the piggybacked sweeps are best-effort with their own
// alerts, mirroring the original route semantics.
export async function runRetentionJob(): Promise<RetentionJobResult> {
  let purged: Awaited<ReturnType<typeof purgeExpiredTickets>>;
  try {
    purged = await purgeExpiredTickets();
  } catch (err) {
    await alertCronFailure('retention', err);
    throw err;
  }
  const result: RetentionJobResult = {
    purgedTickets: purged.purgedTickets,
    objectsDeleted: purged.objectsDeleted,
    objectsFailed: purged.objectsFailed,
  };
  // Rows purged but files still in storage (R2 down, bucket unset, bad token):
  // the outbox retries nightly, but an operator must know — otherwise expired
  // customer files sit in the bucket with the cron reporting ok. Deduped by
  // signature inside sendOpsAlert; best-effort.
  if (purged.objectsFailed > 0) {
    await sendOpsAlert({
      signature: 'retention-r2-object-delete-fail',
      severity: 'critical',
      title: 'Retention purge: attachment file deletion failed',
      detail:
        `${purged.objectsFailed} attachment object(s) of purged tickets could not be deleted from storage ` +
        `(${purged.objectsDeleted} succeeded). They stay in pending_object_deletions and are retried on every ` +
        `retention run — check R2_ATTACHMENTS_BUCKET / R2 credentials if this repeats.`,
    }).catch(() => {});
  }
  // Piggyback the daily audit-chain integrity check (Hobby plan caps cron jobs,
  // so this compliance sweep rides the existing daily cron rather than spending a
  // slot). Incremental by default (cost ∝ new rows); a full re-verify runs weekly
  // (Sundays, UTC) via resetFirst to catch a historical tamper below a checkpoint
  // — a stateless calendar gate, so a missed Sunday just delays a week. Best-
  // effort: a verify failure is logged/alerted inside verifyAuditChains but must
  // not fail the purge result. Only a COUNT is embedded here; the alert (Sentry +
  // ops) fires inside verifyAuditChains regardless of caller.
  try {
    const full = new Date().getUTCDay() === 0;
    const { checked, tampered } = await verifyAuditChains({ resetFirst: full });
    result.audit = { checked, tampered: tampered.length, full };
  } catch (err) {
    await alertCronFailure('audit-verify', err);
  }
  // Piggyback the object-deletion retry sweep (finishes any R2 deletes that
  // failed at erase or purge time — the pending_object_deletions outbox plus
  // legacy gdpr_erasures.pending_object_keys). Best-effort — a failure here
  // must not fail the purge result.
  try {
    const { swept, cleared, parkedKeysDeleted, stuck } = await retryPendingObjectDeletions();
    result.objectRetry = { swept, cleared, parkedKeysDeleted, stuck: stuck.length };
    // A key that has failed repeatedly is a standing problem (revoked token,
    // wrong bucket, bad key), not a blip: the file is still in storage and no
    // amount of retrying will remove it, so page rather than log. Deduped by
    // signature inside sendOpsAlert.
    if (stuck.length) {
      await sendOpsAlert({
        signature: 'object-outbox-stuck-keys',
        severity: 'critical',
        title: 'Attachment deletion is stuck',
        detail:
          `${stuck.length} attachment object(s) have failed deletion at least ${STUCK_ATTEMPTS} times and are still ` +
          `in storage after their rows were removed (GDPR erasure / retention purge). Check R2_ATTACHMENTS_BUCKET ` +
          `and the R2 token's permissions.\n` +
          stuck.map((k) => `  • ${k.storage_key} (${k.attempts} attempts) — ${k.last_error ?? 'no error recorded'}`).join('\n'),
      }).catch(() => {});
    }
  } catch (err) {
    await alertCronFailure('gdpr-object-retry', err);
  }
  // Piggyback the sender-domain sweep (same Hobby cron-cap reasoning): verify
  // pending domains (auto-stamps owners who never revisit the settings page),
  // drift-check verified ones (lapse => degraded + ops alert inside the
  // sweep), and expire 30-day-old unverified claims. Best-effort.
  try {
    result.emailDomains = await sweepEmailDomains();
  } catch (err) {
    await alertCronFailure('email-domain-sweep', err);
  }
  return result;
}
