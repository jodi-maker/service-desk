// Ticket attachments: storing inbound email files and serving them back.
//
// Objects live in the PRIVATE attachments bucket under
//   att/<workspaceId>/<ticketId>/<attachment uuid>/<sanitised filename>
// and rows in ticket_attachments (message_id = the message they belong to).
// The UI never gets a storage key — only short-lived presigned URLs minted
// here inside an authenticated ticket response.
//
// Ingest is two phases because `is_inline` is only knowable after the HTML has
// been sanitised against the cid map:
//   1. uploadInboundAttachments — classify, upload (bounded concurrency), and
//      return the rows-to-be plus the Content-ID → uuid map;
//   2. insertAttachmentRows — ONE multi-row insert once the caller knows which
//      uuids the sanitised HTML actually embeds.
// Both are best-effort per file: a blocked type, an oversize file, a storage
// outage or an unconfigured bucket SKIPS that file (the message still lands,
// with a note in its text body) — Postmark must always get its 200.

import type { Sql, TransactionSql } from 'postgres';
import { getDb } from './db.js';
import { attachmentsStore, contentDispositionFor, isAttachmentsStorageConfigured, type R2Store } from './r2.js';
import {
  classifyAttachment, fileExtension, formatSkipNote, DENY_EXT,
  MAX_INBOUND_FILE_BYTES, MAX_INBOUND_FILE_COUNT, sanitizeFilename,
} from './attachment-policy.js';
import { normaliseCid, rewriteCidsToUrls } from './email-html.js';
import { drainObjectDeletions, enqueueObjectDeletions } from './object-outbox.js';
import type { PostmarkInbound } from './postmark.js';

// The wire shape, derived from the zod schema so the two can't drift.
export type PostmarkAttachment = NonNullable<PostmarkInbound['Attachments']>[number];

// Simultaneous uploads. The webhook response waits on these, so they run
// concurrently (mirroring r2.ts deleteKeys) rather than one round-trip per file.
const UPLOAD_CONCURRENCY = 6;

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  is_inline: boolean;
  content_id: string | null;
  disposition: 'inline' | 'attachment';
  storage_key: string;
}

// What the API returns per attachment. `url` is null when storage is not
// configured (metadata still shows so the agent knows a file exists).
export interface PublicAttachment {
  id: string;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  is_inline: boolean;
  disposition: 'inline' | 'attachment';
  url: string | null;
}

// An uploaded object waiting for its DB row.
export interface PendingAttachment {
  id: string;
  filename: string;
  size: number;
  mime: string;
  disposition: 'inline' | 'attachment';
  // The email's own Content-ID (null for a regular attachment) — kept verbatim
  // so a future re-sanitise of the raw HTML on inbox_messages can rebuild the
  // cid → attachment mapping.
  contentId: string | null;
  storageKey: string;
}

export interface StoreDeps {
  // Injectable store (tests). Default: the private attachments bucket.
  store?: R2Store;
  configured?: () => boolean;
}

export interface UploadResult {
  pending: PendingAttachment[];
  // Content-ID (normalised) → our attachment uuid, for sanitizeEmailHtml.
  cidMap: Map<string, string>;
  // Human-readable notes for files we did not keep, for the message body.
  skipped: string[];
}

export function storageKeyFor(workspaceId: string, ticketId: string, attachmentId: string, filename: string): string {
  return `att/${workspaceId}/${ticketId}/${attachmentId}/${filename}`;
}

// Decoded size of a base64 payload, without decoding it — lets a 30 MB file be
// rejected before it is materialised in memory on the webhook hot path.
function base64Bytes(b64: string): number {
  const s = b64.replace(/[\r\n]/g, '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/**
 * Upload every acceptable attachment. Never throws for a per-file problem —
 * each is reported in `skipped`. No DB writes happen here.
 */
export async function uploadInboundAttachments(
  args: { workspaceId: string; ticketId: string; attachments: PostmarkAttachment[] | undefined },
  deps: StoreDeps = {},
): Promise<UploadResult> {
  const result: UploadResult = { pending: [], cidMap: new Map(), skipped: [] };
  const list = args.attachments ?? [];
  if (list.length === 0) return result;

  const configured = deps.configured ?? isAttachmentsStorageConfigured;
  if (!deps.store && !configured()) {
    console.warn(`[attachments] ${list.length} inbound file(s) dropped — R2_ATTACHMENTS_BUCKET is not configured`);
    for (const a of list) result.skipped.push(formatSkipNote(sanitizeFilename(a.Name), 'attachment storage not configured'));
    return result;
  }
  const store = deps.store ?? attachmentsStore();

  // Cheap rejections first: extension and declared size need no decode.
  type Candidate = { filename: string; bytes: Uint8Array; mime: string; disposition: 'inline' | 'attachment'; contentId: string | null };
  const candidates: Candidate[] = [];
  for (const a of list.slice(MAX_INBOUND_FILE_COUNT)) {
    result.skipped.push(formatSkipNote(sanitizeFilename(a.Name), `over the ${MAX_INBOUND_FILE_COUNT}-file limit for one email`));
  }
  for (const a of list.slice(0, MAX_INBOUND_FILE_COUNT)) {
    const filename = sanitizeFilename(a.Name);
    if (DENY_EXT.has(fileExtension(filename))) { result.skipped.push(formatSkipNote(filename, 'blocked type')); continue; }
    const declaredSize = a.ContentLength ?? base64Bytes(a.Content);
    if (declaredSize > MAX_INBOUND_FILE_BYTES) { result.skipped.push(formatSkipNote(filename, 'too large', declaredSize)); continue; }
    // Buffer IS a Uint8Array — no copy. Invalid base64 decodes to garbage
    // rather than throwing; classifyAttachment then judges the real bytes.
    const bytes: Uint8Array = Buffer.from(a.Content, 'base64');
    const verdict = classifyAttachment(filename, a.ContentType, bytes, MAX_INBOUND_FILE_BYTES);
    if (!verdict.ok) {
      result.skipped.push(formatSkipNote(filename, verdict.reason, verdict.reason === 'too large' ? bytes.length : undefined));
      continue;
    }
    const rawCid = normaliseCid(a.ContentID ?? '');
    candidates.push({ filename, bytes, mime: verdict.mime, disposition: verdict.disposition, contentId: rawCid || null });
  }

  for (let i = 0; i < candidates.length; i += UPLOAD_CONCURRENCY) {
    const slice = candidates.slice(i, i + UPLOAD_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map(async (c): Promise<PendingAttachment> => {
        const id = crypto.randomUUID();
        const storageKey = storageKeyFor(args.workspaceId, args.ticketId, id, c.filename);
        await store.putObject(storageKey, c.bytes, {
          contentType: c.mime,
          contentDisposition: contentDispositionFor(c.disposition, c.filename),
        });
        return { id, filename: c.filename, size: c.bytes.length, mime: c.mime, disposition: c.disposition, contentId: c.contentId, storageKey };
      }),
    );
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        result.pending.push(r.value);
        if (r.value.contentId) result.cidMap.set(r.value.contentId, r.value.id);
      } else {
        console.error(`[attachments] R2 upload failed for ${slice[idx].filename}:`, r.reason instanceof Error ? r.reason.message : r.reason);
        result.skipped.push(formatSkipNote(slice[idx].filename, 'storage error'));
      }
    });
  }
  return result;
}

/**
 * Insert the rows for already-uploaded objects in ONE statement. `usedCids` is
 * the set of attachment ids the sanitised HTML embeds — those are the inline
 * ones. If the insert fails the objects are handed to the deletion outbox so
 * they can never become orphans.
 */
export async function insertAttachmentRows(
  sql: Sql | TransactionSql,
  args: { workspaceId: string; ticketId: string; messageId: string },
  pending: PendingAttachment[],
  usedCids: Set<string>,
  deps: StoreDeps = {},
): Promise<void> {
  if (pending.length === 0) return;
  const rows = pending.map((p) => ({
    id: p.id,
    workspace_id: args.workspaceId,
    ticket_id: args.ticketId,
    message_id: args.messageId,
    filename: p.filename,
    size_bytes: p.size,
    storage_key: p.storageKey,
    mime_type: p.mime,
    content_id: p.contentId,
    is_inline: usedCids.has(p.id),
    disposition: p.disposition,
  }));
  try {
    await sql`insert into ticket_attachments ${sql(rows)}`;
  } catch (err) {
    console.error('[attachments] row insert failed — queueing objects for deletion:', err instanceof Error ? err.message : err);
    const keys = pending.map((p) => p.storageKey);
    const deleter = deps.store ? (k: string[]) => deps.store!.deleteKeys(k) : undefined;
    try {
      await enqueueObjectDeletions(getDb(), keys, 'orphan');
      await drainObjectDeletions(keys, deleter);
    } catch (cleanupErr) {
      console.error('[attachments] orphan cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    }
    throw err;
  }
}

/**
 * All attachments of a ticket's messages, grouped by message id, each with a
 * presigned URL. Unclaimed uploads (message_id null) are excluded.
 */
export async function loadAttachmentsForTicket(
  workspaceId: string,
  ticketId: string,
  deps: StoreDeps = {},
): Promise<Map<string, PublicAttachment[]>> {
  const sql = getDb();
  const rows = await sql<AttachmentRow[]>`
    select id, message_id, filename, size_bytes, mime_type, is_inline, content_id, disposition, storage_key
    from ticket_attachments
    where workspace_id = ${workspaceId} and ticket_id = ${ticketId} and message_id is not null
    order by created_at asc
  `;
  const byMessage = new Map<string, PublicAttachment[]>();
  if (rows.length === 0) return byMessage;

  const configured = deps.configured ?? isAttachmentsStorageConfigured;
  const store = deps.store ?? (configured() ? attachmentsStore() : null);
  const urls = await Promise.all(
    rows.map(async (r) => {
      if (!store) return null;
      try {
        return await store.presignGet(r.storage_key);
      } catch (err) {
        console.warn(`[attachments] presign failed for ${r.id}:`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  rows.forEach((r, i) => {
    const list = byMessage.get(r.message_id!) ?? [];
    list.push({
      id: r.id,
      filename: r.filename,
      size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
      mime_type: r.mime_type,
      is_inline: r.is_inline,
      disposition: r.disposition,
      url: urls[i],
    });
    byMessage.set(r.message_id!, list);
  });
  return byMessage;
}

/**
 * Attach `attachments` to each message row and swap cid: tokens in body_html
 * for the inline images' URLs. Pure — used by GET /tickets/:id and by the
 * reply route's response.
 */
export function decorateMessages<M extends { id: string; body_html?: string | null }>(
  messages: M[],
  byMessage: Map<string, PublicAttachment[]>,
): Array<M & { attachments: PublicAttachment[] }> {
  return messages.map((m) => {
    const attachments = byMessage.get(m.id) ?? [];
    const urlById = new Map<string, string>();
    for (const a of attachments) if (a.is_inline && a.url) urlById.set(a.id, a.url);
    return { ...m, body_html: m.body_html ? rewriteCidsToUrls(m.body_html, urlById) : null, attachments };
  });
}

// ─── Agent uploads (outbound) ────────────────────────────────────────────────

export interface UploadedAttachment {
  id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  is_inline: boolean;
  disposition: 'inline' | 'attachment';
}

/**
 * Store one agent-uploaded file as an UNCLAIMED attachment (message_id null).
 * It is bound to a message when the reply is posted; anything left unclaimed
 * is swept after a day (sweepUnclaimedAttachments).
 */
export async function storeUpload(
  sql: Sql | TransactionSql,
  args: {
    workspaceId: string; ticketId: string; uploadedByUserId: string | null;
    filename: string; declaredMime: string | null; bytes: Uint8Array; maxBytes: number;
    isInline?: boolean;
  },
  deps: StoreDeps = {},
): Promise<{ ok: true; row: UploadedAttachment } | { ok: false; reason: string }> {
  const filename = sanitizeFilename(args.filename);
  const verdict = classifyAttachment(filename, args.declaredMime, args.bytes, args.maxBytes);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  // An inline image must really be an image — an agent's editor must not be
  // able to embed a document as if it rendered.
  if (args.isInline && verdict.disposition !== 'inline') return { ok: false, reason: 'not an image' };

  const configured = deps.configured ?? isAttachmentsStorageConfigured;
  if (!deps.store && !configured()) return { ok: false, reason: 'attachment storage not configured' };
  const store = deps.store ?? attachmentsStore();

  const id = crypto.randomUUID();
  const storageKey = storageKeyFor(args.workspaceId, args.ticketId, id, filename);
  await store.putObject(storageKey, args.bytes, {
    contentType: verdict.mime,
    contentDisposition: contentDispositionFor(verdict.disposition, filename),
  });
  try {
    await sql`
      insert into ticket_attachments
        (id, workspace_id, ticket_id, message_id, filename, size_bytes, storage_key, mime_type, content_id, is_inline, uploaded_by_user_id, disposition)
      values
        (${id}, ${args.workspaceId}, ${args.ticketId}, null, ${filename}, ${verdict.size}, ${storageKey},
         ${verdict.mime}, ${args.isInline ? id : null}, ${!!args.isInline}, ${args.uploadedByUserId}, ${verdict.disposition})
    `;
  } catch (err) {
    const deleter = deps.store ? (k: string[]) => deps.store!.deleteKeys(k) : undefined;
    try {
      await enqueueObjectDeletions(getDb(), [storageKey], 'orphan');
      await drainObjectDeletions([storageKey], deleter);
    } catch { /* stays in the outbox for the cron sweep */ }
    throw err;
  }
  return {
    ok: true,
    row: { id, filename, size_bytes: verdict.size, mime_type: verdict.mime, is_inline: !!args.isInline, disposition: verdict.disposition },
  };
}

/**
 * Bind previously-uploaded attachments to a message. Only rows that are in the
 * same workspace AND ticket AND still unclaimed can be bound, so an id from
 * another ticket (or one already sent) is refused — the caller rolls back.
 */
export async function claimAttachments(
  sql: Sql | TransactionSql,
  args: { workspaceId: string; ticketId: string; messageId: string; ids: string[] },
): Promise<AttachmentRow[]> {
  if (args.ids.length === 0) return [];
  const rows = await sql<AttachmentRow[]>`
    update ticket_attachments set message_id = ${args.messageId}
    where id in ${sql(args.ids)}
      and workspace_id = ${args.workspaceId}
      and ticket_id = ${args.ticketId}
      and message_id is null
    returning id, message_id, filename, size_bytes, mime_type, is_inline, content_id, disposition, storage_key
  `;
  if (rows.length !== args.ids.length) {
    throw new AttachmentClaimError(`${args.ids.length - rows.length} attachment(s) are unknown, already sent, or belong to another ticket`);
  }
  return rows;
}

export class AttachmentClaimError extends Error {
  constructor(message: string) { super(message); this.name = 'AttachmentClaimError'; }
}

/** Metadata for the attachments already bound to a message. */
export async function listAttachmentsForMessage(workspaceId: string, messageId: string): Promise<AttachmentRow[]> {
  const sql = getDb();
  return sql<AttachmentRow[]>`
    select id, message_id, filename, size_bytes, mime_type, is_inline, content_id, disposition, storage_key
    from ticket_attachments
    where workspace_id = ${workspaceId} and message_id = ${messageId}
    order by created_at asc
  `;
}

export interface OutboundFile {
  filename: string;
  mime: string;
  base64: string;
  // Set for inline images: Postmark expects "cid:<token>" here and the HTML
  // references the same token.
  contentId: string | null;
}

/** Fetch the bytes of stored attachments for an outgoing email. */
export async function loadOutboundFiles(rows: AttachmentRow[], deps: StoreDeps = {}): Promise<OutboundFile[]> {
  if (rows.length === 0) return [];
  const store = deps.store ?? attachmentsStore();
  const files = await Promise.all(
    rows.map(async (r) => {
      const { bytes } = await store.getObject(r.storage_key);
      return {
        filename: r.filename,
        mime: r.mime_type || 'application/octet-stream',
        base64: Buffer.from(bytes).toString('base64'),
        contentId: r.is_inline ? `cid:${r.id}` : null,
      };
    }),
  );
  return files;
}

/**
 * Delete uploads nobody attached to a message. Runs from the retention cron.
 * Objects go through the outbox so a storage failure is retried rather than
 * leaving a file with no row.
 */
export async function sweepUnclaimedAttachments(olderThanHours = 24, deps: StoreDeps = {}): Promise<{ removed: number }> {
  const sql = getDb();
  const rows = await sql<{ id: string; storage_key: string }[]>`
    select id, storage_key from ticket_attachments
    where message_id is null and created_at < now() - make_interval(hours => ${Math.max(1, olderThanHours)})
    limit 500
  `;
  if (rows.length === 0) return { removed: 0 };
  const keys = rows.map((r) => r.storage_key);
  await sql.begin(async (tx) => {
    await enqueueObjectDeletions(tx, keys, 'orphan');
    await tx`delete from ticket_attachments where id in ${tx(rows.map((r) => r.id))}`;
  });
  await drainObjectDeletions(keys, deps.store ? (k) => deps.store!.deleteKeys(k) : undefined);
  return { removed: rows.length };
}
