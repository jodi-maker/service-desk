import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { nextDisplayId } from '../lib/display-id.js';
import { applyAssignmentRules } from '../lib/assign-rules-engine.js';
import { notifySlack } from '../lib/slack-notify.js';
import { dispatchTicketEvent } from '../lib/outgoing-webhooks.js';
import { scoreMessageSentiment } from '../lib/sentiment.js';
import { ticketListCols } from '../lib/ticket-cols.js';
import { sendCsatSurvey } from '../lib/csat-survey.js';
import { notifyMentionedAgents } from '../lib/mention-notify.js';
import { sendAgentReplyEmail, type AgentReplyDelivery } from '../lib/agent-reply.js';
import { publishTicketChanged } from '../lib/pubby.js';
import { hasDeletePermission } from '../lib/authz.js';
import { writeAudit } from '../middleware/platform-admin.js';
import { getDb } from '../lib/db.js';
import {
  AttachmentClaimError, claimAttachments, decorateMessages, listAttachmentsForMessage,
  loadAttachmentsForTicket, loadOutboundFiles, storeUpload,
} from '../lib/message-attachments.js';
import {
  MAX_INLINE_IMAGES, MAX_REPLY_ATTACHMENT_BYTES, MAX_UPLOAD_FILE_BYTES,
} from '../lib/attachment-policy.js';
import { extractDataImages, sanitizeEmailHtml } from '../lib/email-html.js';
import { htmlToText } from '../lib/html-text.js';
import { isAttachmentsStorageConfigured } from '../lib/r2.js';
import { drainObjectDeletions, enqueueObjectDeletions } from '../lib/object-outbox.js';
import { enforceRateLimit } from '../lib/rate-limit.js';

// Migration to Neon — Step 3 (tickets megabatch). All direct queries use
// getDb() raw SQL, scoped by workspace_id (the auth middleware verifies
// membership). requireAuth/JWT verification is unchanged until the final
// auth-flip PR.
export const tickets = new Hono();

tickets.use('*', requireAuth);

// Realtime (Step 5): after any successful mutation on a /:id ticket route,
// push a "ticket.changed" signal so other viewers re-sync via their existing
// cursor fetch. This one post-response hook covers every /:id/* write (id from
// the path param); the create handler (POST /, no :id) publishes its new id
// explicitly. Best-effort and post-response — never affects the handler result
// (publishTicketChanged is a no-op when Pubby is unconfigured).
//
// Invariant: in THIS router `:id` is always a ticket id, and every non-GET
// here genuinely mutates that ticket (status/message/tags/snooze/merge/time/
// assign), so a `ticket.changed` for that id is always correct — including
// POST /:id/messages, a primary case. The signal only triggers a re-sync,
// which is idempotent and cheap, so an occasional list-invisible change (e.g.
// a time entry) costs at most one extra delta fetch. (The /:id/triage app is
// mounted separately and is unaffected by this hook.)
tickets.use('*', async (c, next) => {
  await next();
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (c.res.status >= 300) return;
  const id = c.req.param('id');
  const workspaceId = c.get('workspaceId');
  if (id && workspaceId) void publishTicketChanged(workspaceId, id);
});

// Pagination is offset-based for the skeleton; switch to keyset before
// ticket volumes get serious.
//
// Every direct query in this file uses getDb() (Neon via postgres.js) and
// explicitly scopes by workspace_id — the authorization that RLS used to
// enforce now lives here in the route + the auth middleware (which verifies
// the caller is a member of the active workspace).
tickets.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // The exact total (`count(*) over()`) scans every non-deleted ticket in the
  // workspace, so compute it only on the first page. The SPA seeds its "N of M"
  // + hasMore from page 0 and retains it across "load more" (`res.total ??
  // _ticketsTotal` in core/bootstrap.js), so later pages omit the count — this
  // turns a per-page full count into once per list-open.
  const withCount = offset === 0;
  const rows = await sql`
    select ${ticketListCols(sql)}
           ${withCount ? sql`, count(*) over() ::int as total_count` : sql``}
    from tickets
    where workspace_id = ${workspaceId} and deleted_at is null
    order by updated_at desc
    limit ${limit} offset ${offset}
  `;
  const tickets = rows.map(({ total_count, ...r }) => r);
  // Only send `total` when we computed it (page 0); the SPA keeps its prior
  // value otherwise. Empty first page → 0.
  if (withCount) {
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    return c.json({ tickets, total, limit, offset });
  }
  return c.json({ tickets, limit, offset });
});

// ─── GET /sync — incremental list deltas since a client cursor ──────────
//
// Drives the always-on list-sync polling. The SPA hits this every ~10s
// with the last cursor we returned; we return everything whose
// updated_at moved since (capped by `limit`) plus the new cursor to use
// next time.
//
// `deleted_at` rides on tombstone rows (slimmed to {id, updated_at,
// deleted_at}) so the client can drop them from its local TICKETS
// array via the same delta path — no separate deleted-IDs list, and
// no over-sharing of the soft-deleted row's content. The trigger
// added in PR #237 means child mutations (new messages, tag changes,
// AI accepts, time logged) all bubble through here via the parent's
// updated_at.
//
// First call with no cursor just stamps the current time and returns
// an empty list — the SPA already has the full set from bootstrap, so
// we don't want to redundantly dump it.
//
// Cursor is composite `<iso>|<uuid>` so two rows that share the same
// `updated_at` microsecond can't silently skip past a `limit`-truncated
// batch. The query is the standard tie-breaker shape:
// (updated_at > t) OR (updated_at = t AND id > i)
// ordered by (updated_at, id). Plain-ISO cursors still parse for
// backwards compat with anyone holding an older one.
tickets.get('/sync', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const rawCursor = c.req.query('cursor');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 500);

  // Coarse activity heartbeat: the SPA polls /sync every ~60s on every page,
  // so this is our "agent is in the app" signal for offline-notification
  // routing (lib/activity.ts). Awaited (not fire-and-forget) so the write
  // isn't dropped when the serverless function freezes after responding;
  // a stamp failure is swallowed so it never breaks the sync.
  try { await sql`update users set last_active_at = now() where id = ${userId}`; }
  catch (err) { console.warn('[activity] last_active_at stamp failed:', err instanceof Error ? err.message : err); }

  if (!rawCursor) {
    return c.json({ tickets: [], cursor: `${new Date().toISOString()}|` });
  }

  const pipeIdx = rawCursor.indexOf('|');
  const cursorTs = pipeIdx === -1 ? rawCursor : rawCursor.slice(0, pipeIdx);
  const cursorId = pipeIdx === -1 ? ''        : rawCursor.slice(pipeIdx + 1);

  const cols = sql`id, display_id, subject, status_key, priority_key, category_key, assigned_user_id,
    customer_id, sla_state, created_at, updated_at, snoozed_until, snoozed_at, snooze_reason,
    snooze_woken_at, merged_into_id, merged_at, status_before_merge, latest_customer_sentiment, deleted_at`;
  // Composite-cursor tie-break: rows strictly later in (updated_at, id) order.
  const cursorClause = cursorId
    ? sql`and (updated_at > ${cursorTs} or (updated_at = ${cursorTs} and id > ${cursorId}))`
    : sql`and updated_at > ${cursorTs}`;
  const rows = [...await sql`
    select ${cols},
           (select tm.role from ticket_messages tm
              where tm.ticket_id = tickets.id and tm.deleted_at is null
              order by tm.created_at desc limit 1) as last_message_role
    from tickets
    where workspace_id = ${workspaceId} ${cursorClause}
    order by updated_at asc, id asc
    limit ${limit}
  `];
  const last = rows[rows.length - 1];
  const newCursor = last
    ? `${last.updated_at}|${last.id}`
    : `${new Date().toISOString()}|`;

  // Slim tombstone rows so the response doesn't carry subject / status /
  // customer_id / etc. of soft-deleted tickets. The client only needs
  // `id` to splice the row out of its local TICKETS array — anything
  // more is over-sharing for a row the agent shouldn't actively see.
  const responseRows = rows.map((r: any) =>
    r.deleted_at
      ? { id: r.id, updated_at: r.updated_at, deleted_at: r.deleted_at }
      : r
  );

  return c.json({ tickets: responseRows, cursor: newCursor });
});

// Full ticket detail — the row itself plus all of its child collections.
// Used by the SPA's ticket-detail view to populate the conversation thread,
// tags, AI tags, and time entries that aren't returned by the list endpoint.
//
// 4 parallel queries instead of one big embedded select — clearer to read
// and to debug, with no measurable latency cost at v1 scale.
tickets.get('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const [ticket] = await sql`
    select * from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const [msgs, tags, aiTags, time, mergedFrom, mergedInto, attachmentsByMsg] = await Promise.all([
    sql<{ id: string; body_html: string | null }[]>`
        select id, role, author_user_id, author_label, body, body_html, mentions, merged_from_id, sentiment, created_at
        from ticket_messages where ticket_id = ${ticketId} and deleted_at is null order by created_at asc`,
    sql`select tag from ticket_tags where ticket_id = ${ticketId}`,
    sql`select tag, confidence, accepted from ticket_ai_tags where ticket_id = ${ticketId} order by confidence desc`,
    sql`select te.id, te.user_id, te.minutes, te.note, te.billable, te.created_at, u.name as user_name
        from time_entries te left join users u on u.id = te.user_id
        where te.ticket_id = ${ticketId} order by te.created_at desc`,
    sql`select display_id from tickets where merged_into_id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null`,
    ticket.merged_into_id
      ? sql`select display_id from tickets where id = ${ticket.merged_into_id}`
      : Promise.resolve([] as any[]),
    // Attachments per message with presigned URLs; body_html's cid: tokens are
    // swapped for the inline images' URLs in decorateMessages.
    loadAttachmentsForTicket(workspaceId, ticketId),
  ]);

  return c.json({
    ticket: {
      ...ticket,
      messages:     decorateMessages(msgs, attachmentsByMsg),
      tags:         tags.map((r: any) => r.tag),
      ai_tags:      aiTags,
      time_entries: time.map((te: any) => ({
        id: te.id, user_id: te.user_id, user_name: te.user_name || null,
        minutes: te.minutes, note: te.note, billable: te.billable, created_at: te.created_at,
      })),
      merged_from_display_ids: mergedFrom.map((r: any) => r.display_id),
      merged_into_display_id:  (mergedInto[0] as any)?.display_id || null,
    },
  });
});

// ─── PATCH /:id — update status / priority / assignment / category ───────
//
// All fields optional; only provided ones are written. Empty body is a
// 400 (probably a client bug, fail loudly). assigned_user_id may be null
// to unassign.
const PatchTicket = z.object({
  status_key:        z.string().optional(),
  priority_key:      z.string().optional(),
  category_key:      z.string().nullable().optional(),
  assigned_user_id:  z.string().uuid().nullable().optional(),
  // CSAT fields — the schema defaults to YYYY-MM-DD when written from the
  // SPA, but the column is timestamptz so any Postgres-parseable timestamp
  // is fine. Bad values bubble up as DB errors.
  csat_score:        z.number().int().min(1).max(5).nullable().optional(),
  csat_stars:        z.number().int().min(1).max(5).nullable().optional(),
  csat_comment:      z.string().nullable().optional(),
  csat_requested_at: z.string().nullable().optional(),
  csat_submitted_at: z.string().nullable().optional(),
}).strict();

tickets.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = PatchTicket.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // Workspace-scope check before the update; also captures the pre-update
  // column values used below for change-detection (Slack / webhook events).
  const [existing] = await sql<{ status_key: string; priority_key: string | null; category_key: string | null }[]>`
    select status_key, priority_key, category_key from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!existing) return c.json({ error: 'Ticket not found' }, 404);

  // Reject assigning an unknown/disabled category (null clears; non-null must
  // match an active row). Skipped when unchanged.
  if (updates.category_key != null && updates.category_key !== existing.category_key) {
    const [cat] = await sql`
      select key from ticket_categories
      where workspace_id = ${workspaceId} and key = ${updates.category_key} and is_active = true
    `;
    if (!cat) return c.json({ error: `Unknown or inactive category: ${updates.category_key}` }, 400);
  }

  // Reject assigning the ticket to a user who isn't an active member of this
  // workspace (advisory #9). null clears the assignment and needs no check;
  // mirrors the customer_id membership check on create.
  if (updates.assigned_user_id != null) {
    const [member] = await sql`
      select 1 from workspace_members
      where user_id = ${updates.assigned_user_id} and workspace_id = ${workspaceId} and active = true
    `;
    if (!member) return c.json({ error: 'Assignee is not an active member of this workspace' }, 400);
  }

  // resolved_at follows the status transitions: stamped on entry into
  // 'resolved', cleared on the way out. The column powers the SLA breach
  // report and the data-retention purge — before this it was never written
  // (only the demo seed set it), so both features silently no-oped on live
  // data. Kept idempotent: re-PATCHing 'resolved' on an already-resolved
  // ticket is not a transition and leaves the original timestamp. Uses the
  // DB clock (now()) like the merge path, not app-server time.
  const statusTransition = updates.status_key !== undefined && updates.status_key !== existing.status_key;
  const resolvedAtSet = !statusTransition ? sql`` :
    updates.status_key === 'resolved' ? sql`, resolved_at = now()` :
    existing.status_key === 'resolved' ? sql`, resolved_at = null` : sql``;
  await sql`update tickets set ${sql(updates)}${resolvedAtSet} where id = ${ticketId} and workspace_id = ${workspaceId}`;

  // Slack notifications for the state transitions the workspace cares about.
  const statusChanged   = updates.status_key   !== undefined && updates.status_key   !== existing.status_key;
  const priorityChanged = updates.priority_key !== undefined && updates.priority_key !== existing.priority_key;
  if (statusChanged && updates.status_key === 'resolved') {
    try { await notifySlack({ workspaceId, event: 'ticket.resolved',  ticketId }); }
    catch (err) { console.warn('[slack] notify resolved failed:', err); }
    try { await dispatchTicketEvent({ workspaceId, event: 'ticket.resolved',  ticketId }); }
    catch (err) { console.warn('[outgoing-webhooks] resolved failed:', err); }
    // Auto-send a CSAT survey email. The lib short-circuits on
    // already-requested / no-email / postmark-not-configured paths,
    // so this is safe to fire-and-forget for every resolution.
    try { await sendCsatSurvey({ workspaceId, ticketId }); }
    catch (err) { console.warn('[csat] auto-survey failed:', err); }
  }
  if (statusChanged && updates.status_key === 'escalated') {
    try { await notifySlack({ workspaceId, event: 'ticket.escalated', ticketId }); }
    catch (err) { console.warn('[slack] notify escalated failed:', err); }
    try { await dispatchTicketEvent({ workspaceId, event: 'ticket.escalated', ticketId }); }
    catch (err) { console.warn('[outgoing-webhooks] escalated failed:', err); }
  }
  if (priorityChanged && updates.priority_key === 'urgent') {
    try { await notifySlack({ workspaceId, event: 'priority.urgent',  ticketId }); }
    catch (err) { console.warn('[slack] notify urgent failed:', err); }
    try { await dispatchTicketEvent({ workspaceId, event: 'priority.urgent',  ticketId }); }
    catch (err) { console.warn('[outgoing-webhooks] urgent failed:', err); }
  }

  const [updated] = await sql`
    select id, display_id, status_key, priority_key, category_key, assigned_user_id, sla_state, updated_at,
           csat_score, csat_stars, csat_comment, csat_requested_at, csat_submitted_at
    from tickets where id = ${ticketId} and workspace_id = ${workspaceId}
  `;
  return c.json({ ticket: updated });
});

// ─── POST /:id/attachments — upload a file for the next reply ────────────
//
// Uploads are UNCLAIMED (message_id null) until the reply is posted; the
// retention cron sweeps anything still unclaimed after a day. Stored in the
// private bucket and only ever served through a short-lived presigned URL.
tickets.post('/:id/attachments', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');

  if (!isAttachmentsStorageConfigured()) {
    return c.json({ error: 'Attachment storage is not configured on this server' }, 503);
  }
  // A busy agent uploads a handful of files; anything beyond this is abuse.
  const limited = await enforceRateLimit(c, { name: 'attachment-upload', by: userId, max: 60, windowSeconds: 60 });
  if (limited) return limited;

  const [ticket] = await sql`
    select id from tickets where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Coarse pre-filter on the multipart envelope before parseBody buffers it
  // (same guard as the logo upload); file.size below is authoritative.
  const declaredLen = Number(c.req.header('content-length') || 0);
  if (declaredLen > MAX_UPLOAD_FILE_BYTES + 8192) {
    return c.json({ error: `File too large; max ${MAX_UPLOAD_FILE_BYTES} bytes` }, 400);
  }
  const form = await c.req.parseBody({ all: false }).catch(() => null);
  const file = form?.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'Missing file part' }, 400);
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    return c.json({ error: `File too large; max ${MAX_UPLOAD_FILE_BYTES} bytes` }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let stored;
  try {
    stored = await storeUpload(sql, {
      workspaceId, ticketId, uploadedByUserId: userId,
      filename: file.name, declaredMime: file.type || null, bytes, maxBytes: MAX_UPLOAD_FILE_BYTES,
    });
  } catch (err) {
    console.error('[attachments] upload failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Upload failed' }, 500);
  }
  if (!stored.ok) return c.json({ error: `Cannot attach this file: ${stored.reason}` }, 400);
  return c.json({ attachment: stored.row }, 201);
});

// ─── DELETE /:id/attachments/:attId — drop an unsent upload ──────────────
tickets.delete('/:id/attachments/:attId', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');
  const attId = c.req.param('attId');

  // Only an UNSENT upload, only on this ticket, only the agent who uploaded it
  // — a file already attached to a message is part of the conversation record.
  const [row] = await sql<{ storage_key: string }[]>`
    delete from ticket_attachments
    where id = ${attId} and workspace_id = ${workspaceId} and ticket_id = ${ticketId}
      and message_id is null and uploaded_by_user_id = ${userId}
    returning storage_key
  `;
  if (!row) return c.json({ error: 'Attachment not found' }, 404);
  try {
    await enqueueObjectDeletions(sql, [row.storage_key], 'orphan');
    await drainObjectDeletions([row.storage_key]);
  } catch (err) {
    // The row is gone and the key is parked; the cron finishes the job.
    console.warn('[attachments] delete cleanup deferred:', err instanceof Error ? err.message : err);
  }
  return c.json({ ok: true });
});

// ─── POST /:id/messages — agent reply or internal note ───────────────────
const PostMessage = z.object({
  role:     z.enum(['agent', 'note']),
  // Plain-text body. Optional only when body_html is supplied (the text part
  // is then derived from it for plain-text mail clients and search).
  body:     z.string().min(1).max(100_000).optional(),
  // Rich-text body from the composer. Sanitised server-side before storage —
  // never trusted as-is.
  body_html: z.string().max(2_000_000).optional(),
  // Ids from POST /:id/attachments, still unclaimed.
  attachment_ids: z.array(z.string().uuid()).max(20).optional(),
  mentions: z.array(z.string().uuid()).optional(),
}).refine((v) => (v.body && v.body.trim()) || (v.body_html && v.body_html.trim()), {
  message: 'Either body or body_html is required',
});

tickets.post('/:id/messages', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostMessage.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const [ticket] = await sql`
    select id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Resolve author display name from public.users so the row carries the
  // canonical name without trusting the client.
  const [user] = await sql`select name, email from users where id = ${userId}`;
  const authorLabel = user?.name || user?.email || 'Agent';

  // ── Rich body: sanitise, pull pasted images out into real attachments ──
  // An agent's HTML is untrusted too (they can be phished, and their markup is
  // shown to colleagues), so it goes through the same sanitiser as inbound mail.
  // Pasted data: images become cid:<uuid> references backed by stored files —
  // a screenshot must never be inlined into a database column or an email body.
  let bodyHtml: string | null = null;
  let inlineIds: string[] = [];
  if (input.body_html) {
    const sanitised = sanitizeEmailHtml(input.body_html, { allowDataImages: true });
    const extracted = extractDataImages(sanitised.html);
    bodyHtml = extracted.html || null;
    if (extracted.images.length) {
      if (!isAttachmentsStorageConfigured()) {
        return c.json({ error: 'Attachment storage is not configured on this server' }, 503);
      }
      // Bounded: a paste-happy editor (or a crafted request) must not turn one
      // reply into an unbounded upload loop held open by the agent's request.
      if (extracted.images.length > MAX_INLINE_IMAGES) {
        return c.json({ error: `Too many embedded images (max ${MAX_INLINE_IMAGES}); attach the rest as files instead` }, 400);
      }
      let html = bodyHtml ?? '';
      for (const img of extracted.images) {
        try {
          const stored = await storeUpload(sql, {
            workspaceId, ticketId, uploadedByUserId: userId,
            filename: `image-${img.id.slice(0, 8)}.${img.mime.split('/')[1]}`,
            declaredMime: img.mime, bytes: img.bytes, maxBytes: MAX_UPLOAD_FILE_BYTES, isInline: true,
          }, {});
          if (!stored.ok) return c.json({ error: `Cannot embed a pasted image: ${stored.reason}` }, 400);
          // storeUpload mints its own id; point the HTML at that one.
          html = html.replace(`cid:${img.id}`, `cid:${stored.row.id}`);
          inlineIds.push(stored.row.id);
        } catch (err) {
          console.error('[attachments] inline image upload failed:', err instanceof Error ? err.message : err);
          return c.json({ error: 'Could not store a pasted image' }, 500);
        }
      }
      bodyHtml = html || null;
    }
  }
  // The text part: what the agent typed, or a readable rendering of their HTML
  // for plain-text mail clients, search and the AI context.
  const bodyText = (input.body?.trim() || (bodyHtml ? htmlToText(bodyHtml) : '')) || '(empty message)';

  const claimIds = [...(input.attachment_ids ?? []), ...inlineIds];
  // Postmark rejects a message over 10 MB including base64 overhead; refuse
  // before the row exists so the agent can drop a file and retry.
  if (claimIds.length) {
    const [{ total }] = await sql<{ total: number }[]>`
      select coalesce(sum(size_bytes), 0)::bigint as total from ticket_attachments
      where workspace_id = ${workspaceId} and ticket_id = ${ticketId} and id in ${sql(claimIds)} and message_id is null
    `;
    if (Number(total) > MAX_REPLY_ATTACHMENT_BYTES) {
      return c.json({ error: `Attachments are too large to email (max ${Math.floor(MAX_REPLY_ATTACHMENT_BYTES / (1024 * 1024))} MB in total)` }, 400);
    }
  }

  // The message and the binding of its files are one unit: a bad attachment id
  // must not leave a reply quoting files it does not have.
  let message;
  try {
    message = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into ticket_messages (workspace_id, ticket_id, role, author_user_id, author_label, body, body_html, mentions)
        values (${workspaceId}, ${ticketId}, ${input.role}, ${userId}, ${authorLabel}, ${bodyText}, ${bodyHtml}, ${input.mentions || []})
        returning id, role, author_user_id, author_label, body, body_html, mentions, created_at
      `;
      await claimAttachments(tx, { workspaceId, ticketId, messageId: row.id, ids: claimIds });
      return row;
    });
  } catch (err) {
    if (err instanceof AttachmentClaimError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // Fire-and-forget email notifications when a note @mentions other
  // agents. Service-role for the user lookup (cross-workspace
  // peer-read works under RLS too, but admin is cleaner for the
  // background path). Failures stay out of the response.
  if (input.role === 'note' && input.mentions && input.mentions.length > 0) {
    notifyMentionedAgents({
      workspaceId,
      ticketId,
      authorUserId: userId,
      authorLabel,
      mentions:     input.mentions,
      body:         bodyText,
    }).catch((err) => console.warn('[mention-notify] failed:', err instanceof Error ? err.message : err));
  }

  // Public agent replies are emailed to the customer (internal notes are not).
  // Sent inline so the response carries the delivery outcome for the composer
  // to surface; the message row above persists regardless of the email result.
  // Any unexpected error degrades to a generic 'send_failed' — never a 500 —
  // so a saved reply is never lost to a mail hiccup.
  let delivery: AgentReplyDelivery | undefined;
  if (input.role === 'agent') {
    // The agent is handling this ticket again — clear the offline-push throttle
    // so the next customer reply re-notifies. Awaited (serverless-safe) and
    // swallowed so it never blocks the reply.
    try { await sql`update tickets set last_reply_notified_at = null where id = ${ticketId} and workspace_id = ${workspaceId}`; }
    catch (err) { console.warn('[push] clear notify throttle failed:', err instanceof Error ? err.message : err); }
    try {
      // Load the bytes of everything bound to this message so Postmark can
      // carry them (inline images keep the cid: token the HTML references).
      const files = claimIds.length
        ? await loadOutboundFiles(await listAttachmentsForMessage(workspaceId, message.id))
        : [];
      delivery = await sendAgentReplyEmail({
        workspaceId, ticketId, messageId: message.id, authorUserId: userId,
        body: bodyText, bodyHtml, attachments: files,
      });
    } catch (err) {
      console.error('[agent-reply] send threw:', err instanceof Error ? err.message : err);
      delivery = { emailed: false, reason: 'send_failed' };
    }
  }

  // Return the message in the same shape GET /:id uses (cid: tokens swapped for
  // presigned URLs, attachments listed) so the composer can push it straight
  // into the thread.
  const decorated = claimIds.length
    ? decorateMessages([message as { id: string; body_html?: string | null }], await loadAttachmentsForTicket(workspaceId, ticketId))[0]
    : { ...message, attachments: [] };
  return c.json({ message: decorated, delivery }, 201);
});

// ─── POST /:id/sentiment/backfill — score unscored customer messages ─────
//
// For tickets created before sentiment scoring shipped (or whose
// scoring was skipped due to a previous budget exhaustion / API
// outage). Scores every customer message on this ticket whose
// sentiment is currently null, sequentially. Sequential rather than
// parallel because:
//   - rate-limit headroom is small for non-Sonnet/Haiku free tiers
//   - budget exhaustion mid-batch should stop the rest cleanly, not
//     burn through every message before the gate trips
//
// Sentiment-scoring stays on service-role because the lib already
// expects the privileged client (it inserts into ai_usage_log and
// updates tickets.priority_key on anger).
tickets.post('/:id/sentiment/backfill', async (c) => {
  const sql      = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId    = c.req.param('id');

  // Confirm the ticket exists in this workspace before doing any AI
  // work — also surfaces a clean 404 instead of "0 scored" if the
  // caller fat-fingers the id.
  const [ticket] = await sql`
    select id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const unscored = await sql<{ id: string; body: string | null }[]>`
    select id, body from ticket_messages
    where ticket_id = ${ticketId} and workspace_id = ${workspaceId}
      and role = 'customer' and sentiment is null and deleted_at is null
    order by created_at asc
  `;
  if (unscored.length === 0) {
    return c.json({ scored: 0, sentiments: {} });
  }

  // Sequential scoring with early exit on null result (likely budget
  // exhaustion). We don't bubble the BudgetExceededError because the
  // lib catches it internally and returns null — but the null does
  // mean further calls would also fail, so stop.
  const sentiments: Record<string, string> = {};
  let scored = 0;
  for (const m of unscored) {
    const result = await scoreMessageSentiment({
      workspaceId, ticketId, messageId: m.id, body: m.body || '',
    });
    if (!result) break;
    sentiments[m.id] = result;
    scored++;
  }

  return c.json({ scored, total: unscored.length, sentiments });
});

// ─── POST /:id/tags — add a manual tag ───────────────────────────────────
//
// Tag is normalised the same way the SPA used to (lowercase, hyphenated,
// alphanumeric-only) so a value that round-trips through the API matches
// what `data.js` set. On insert, also upsert into tag_library so the
// workspace's tag catalogue stays in sync — kind='manual', no confidence.
const PostTag = z.object({
  tag: z.string().min(1).max(64),
});

function normaliseTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

tickets.post('/:id/tags', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostTag.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const tag = normaliseTag(parsed.data.tag);
  if (!tag) return c.json({ error: 'Tag is empty after normalisation' }, 400);

  // Confirm ticket exists in this workspace.
  const [ticket] = await sql`
    select id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Idempotent — ON CONFLICT does nothing because (ticket_id, tag) is the PK.
  await sql`
    insert into ticket_tags (workspace_id, ticket_id, tag)
    values (${workspaceId}, ${ticketId}, ${tag})
    on conflict (ticket_id, tag) do nothing
  `;

  // Keep the workspace tag library populated. Best-effort — failure here
  // shouldn't fail the request because the ticket_tags row already landed.
  try {
    await sql`
      insert into tag_library (workspace_id, tag, kind)
      values (${workspaceId}, ${tag}, 'manual')
      on conflict (workspace_id, tag) do nothing
    `;
  } catch (err) {
    console.warn('[tickets] tag_library upsert failed:', err instanceof Error ? err.message : err);
  }

  return c.json({ tag }, 201);
});

// ─── DELETE /:id/tags/:tag — remove a manual tag ─────────────────────────
//
// Tags are unique by (ticket_id, tag), so we route by URL. Returns 204
// on success whether or not the tag was actually present (idempotent).
tickets.delete('/:id/tags/:tag', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');
  const tag = normaliseTag(c.req.param('tag'));

  // Workspace-scope check.
  const [ticket] = await sql`
    select id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  await sql`delete from ticket_tags where ticket_id = ${ticketId} and tag = ${tag}`;

  return new Response(null, { status: 204 });
});

// ─── PATCH /:id/ai_tags/:tag — accept an AI-suggested tag ────────────────
//
// The UI only ever flips accepted=true (there's no "un-accept" button).
// On accept, also writes a ticket_tags row so the accepted suggestion
// becomes a real manual tag — single source of truth for "what tags does
// this ticket have" stays the manual tags array. tag_library upsert is
// best-effort, same shape as POST /tags.
const PatchAITag = z.object({
  accepted: z.literal(true),
});

tickets.patch('/:id/ai_tags/:tag', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');
  const tag = c.req.param('tag');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchAITag.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  // Workspace-scope check + confirm the AI tag actually exists on this
  // ticket. Catches stale UI submitting an accept for a tag the server
  // no longer has. The inner join to tickets enforces the workspace +
  // not-deleted constraint in one round trip.
  const [existing] = await sql`
    select at.tag
    from ticket_ai_tags at
    join tickets t on t.id = at.ticket_id
    where at.ticket_id = ${ticketId} and at.tag = ${tag}
      and t.workspace_id = ${workspaceId} and t.deleted_at is null
  `;
  if (!existing) return c.json({ error: 'AI tag not found' }, 404);

  // 1. Flip accepted=true on the ai_tags row (no-op if already accepted).
  await sql`update ticket_ai_tags set accepted = true where ticket_id = ${ticketId} and tag = ${tag}`;

  // 2. Promote to a manual ticket_tags row. Idempotent via the PK.
  await sql`
    insert into ticket_tags (workspace_id, ticket_id, tag)
    values (${workspaceId}, ${ticketId}, ${tag})
    on conflict (ticket_id, tag) do nothing
  `;

  // 3. Keep the workspace tag library populated. Best-effort.
  try {
    await sql`
      insert into tag_library (workspace_id, tag, kind)
      values (${workspaceId}, ${tag}, 'manual')
      on conflict (workspace_id, tag) do nothing
    `;
  } catch (err) {
    console.warn('[tickets] tag_library upsert failed:', err instanceof Error ? err.message : err);
  }

  return c.json({ tag, accepted: true });
});

// ─── POST /:id/snooze — set snoozed_until + reason ───────────────────────
//
// Server stamps snoozed_at, snoozed_by_user_id, and clears any prior
// snooze_woken_at so re-snoozing a previously-woken ticket reads as fresh.
// `until` must be a future ISO timestamp.
const PostSnooze = z.object({
  until:  z.string().datetime({ offset: true }),
  reason: z.string().nullable().optional(),
});

tickets.post('/:id/snooze', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostSnooze.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const { until, reason } = parsed.data;
  if (new Date(until).getTime() <= Date.now()) {
    return c.json({ error: 'Snooze time must be in the future' }, 400);
  }

  // Workspace-scope check.
  const [existing] = await sql`
    select id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!existing)  return c.json({ error: 'Ticket not found' }, 404);

  const [updated] = await sql`
    update tickets set
      snoozed_until      = ${until},
      snoozed_at         = now(),
      snoozed_by_user_id = ${userId},
      snooze_reason      = ${reason || null},
      snooze_woken_at    = null
    where id = ${ticketId} and workspace_id = ${workspaceId}
    returning id, snoozed_until, snoozed_at, snoozed_by_user_id, snooze_reason, snooze_woken_at, updated_at
  `;

  return c.json({ ticket: updated });
});

// ─── DELETE /:id/snooze — clear snooze (manual or auto wakeup) ───────────
//
// ?via_wakeup=true → server stamps snooze_woken_at = now() so the activity
// log can distinguish "snooze elapsed" from "agent un-snoozed manually".
tickets.delete('/:id/snooze', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');
  const viaWakeup = c.req.query('via_wakeup') === 'true';

  const [existing] = await sql`
    select id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!existing)  return c.json({ error: 'Ticket not found' }, 404);

  const [updated] = await sql`
    update tickets set
      snoozed_until      = null,
      snoozed_at         = null,
      snoozed_by_user_id = null,
      snooze_reason      = null,
      snooze_woken_at    = ${viaWakeup ? sql`now()` : null}
    where id = ${ticketId} and workspace_id = ${workspaceId}
    returning id, snoozed_until, snoozed_at, snoozed_by_user_id, snooze_reason, snooze_woken_at, updated_at
  `;

  return c.json({ ticket: updated });
});

// ─── POST /:id/merge — merge this ticket into another as a duplicate ─────
//
// :id is the SOURCE (the duplicate); body's into_id is the PRIMARY (the
// one that keeps the customer-facing thread). Server:
//   1. Validates both tickets exist in workspace; primary isn't itself merged.
//   2. Stamps merged_into_id, merged_at, status_before_merge on source.
//   3. Copies source's messages to primary with merged_from_id=source so
//      the primary's thread shows the merged history. Existing primary
//      messages aren't touched.
//   4. Inserts a "── Merged from TK-XXX ──" system marker on primary.
//   5. Resolves the source ticket (status_key='resolved') if it wasn't
//      already, so it leaves the open queue.
const PostMerge = z.object({
  into_id: z.string().uuid(),
});

tickets.post('/:id/merge', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const sourceId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostMerge.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const primaryId = parsed.data.into_id;
  if (primaryId === sourceId) {
    return c.json({ error: 'Cannot merge a ticket into itself' }, 400);
  }

  // Fetch both tickets in the workspace.
  const rows = await sql<{ id: string; display_id: string; subject: string; status_key: string | null; merged_into_id: string | null }[]>`
    select id, display_id, subject, status_key, merged_into_id
    from tickets
    where id = any(${[sourceId, primaryId]}) and workspace_id = ${workspaceId} and deleted_at is null
  `;
  const source = rows.find((r) => r.id === sourceId);
  const primary = rows.find((r) => r.id === primaryId);
  if (!source)  return c.json({ error: 'Source ticket not found' }, 404);
  if (!primary) return c.json({ error: 'Primary ticket not found' }, 404);
  if (source.merged_into_id) {
    return c.json({ error: 'Source is already merged' }, 409);
  }
  if (primary.merged_into_id) {
    return c.json({ error: 'Primary is itself a duplicate — pick the chain primary instead' }, 409);
  }

  // 1. Update source row.
  const wasResolved = source.status_key === 'resolved';
  await sql`
    update tickets set
      merged_into_id      = ${primaryId},
      merged_at           = now(),
      status_before_merge = ${wasResolved ? null : source.status_key},
      status_key          = 'resolved',
      resolved_at         = coalesce(resolved_at, now())
    where id = ${sourceId} and workspace_id = ${workspaceId}
  `;

  // 2. Copy source messages onto primary, tagged with merged_from_id.
  const srcMsgs = await sql<{ role: string; author_user_id: string | null; author_label: string | null; body: string | null; mentions: string[] | null }[]>`
    select role, author_user_id, author_label, body, mentions
    from ticket_messages
    where ticket_id = ${sourceId} and deleted_at is null
    order by created_at asc
  `;

  // Merge marker first so it shows up at the top of the merged block.
  await sql`
    insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, mentions, merged_from_id)
    values (${workspaceId}, ${primaryId}, 'system', 'System',
            ${`── Merged from ${source.display_id}: "${source.subject}" ──`}, ${[]}, ${sourceId})
  `;
  for (const m of srcMsgs) {
    await sql`
      insert into ticket_messages (workspace_id, ticket_id, role, author_user_id, author_label, body, mentions, merged_from_id)
      values (${workspaceId}, ${primaryId}, ${m.role}, ${m.author_user_id}, ${m.author_label},
              ${m.body}, ${m.mentions || []}, ${sourceId})
    `;
  }

  return c.json({
    source: { id: sourceId, merged_into_display_id: primary.display_id },
    primary: { id: primaryId, display_id: primary.display_id },
  });
});

// ─── POST /:id/unmerge — undo a merge ────────────────────────────────────
//
// :id is the SOURCE (currently merged). Server:
//   1. Strips messages from the primary where merged_from_id = source.
//   2. Restores status_key from status_before_merge (default 'open' if
//      somehow missing — shouldn't happen for clean merges).
//   3. Clears merged_into_id, merged_at, status_before_merge.
tickets.post('/:id/unmerge', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const sourceId = c.req.param('id');

  const [source] = await sql<{ id: string; merged_into_id: string | null; status_before_merge: string | null }[]>`
    select id, merged_into_id, status_before_merge
    from tickets
    where id = ${sourceId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!source) return c.json({ error: 'Source ticket not found' }, 404);
  if (!source.merged_into_id) {
    return c.json({ error: 'Ticket is not merged' }, 409);
  }

  // 1. Strip merged messages from the primary.
  await sql`
    delete from ticket_messages
    where workspace_id = ${workspaceId} and ticket_id = ${source.merged_into_id} and merged_from_id = ${sourceId}
  `;

  // 2. Restore source row. restoredStatus is never 'resolved' (merge nulls
  // status_before_merge for already-resolved sources), so the merge-time
  // resolved_at stamp is always cleared with it.
  const restoredStatus = source.status_before_merge || 'open';
  await sql`
    update tickets set
      merged_into_id      = null,
      merged_at           = null,
      status_before_merge = null,
      status_key          = ${restoredStatus},
      resolved_at         = null
    where id = ${sourceId} and workspace_id = ${workspaceId}
  `;

  return c.json({
    source: { id: sourceId, status_key: restoredStatus },
    primary: { id: source.merged_into_id },
  });
});

// ─── DELETE /:id — soft-delete a ticket ──────────────────────────────────
//
// Permission: the caller's role carries can_delete (or is admin / platform
// admin) — OR the ticket is BLANK, which any member may bin. Blank = no
// non-deleted message with a real role ('customer','agent','ai','note');
// 'system' rows are merge/audit bookkeeping and don't count. A ticket
// started in error therefore stays deletable by whoever opened it (unsent
// compose drafts live in localStorage and never reach the server, so they
// can't make a ticket non-blank).
//
// SOFT delete, same reasoning as channels.ts: a hard delete would cascade
// ticket_messages and destroy the correspondence trail. Every list/sync/
// detail query already filters deleted_at, /tickets/sync ships {id,
// updated_at, deleted_at} tombstones (this UPDATE fires set_updated_at, so
// the tombstone crosses the sync cursor), and the router-level non-GET hook
// publishes ticket.changed — other tabs drop the row within one poll.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

tickets.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');
  // A non-uuid here (e.g. the display id "T-1024" pasted into a curl) must
  // 404 like any other miss — unguarded it would raise Postgres 22P02 and
  // surface as a 500 + ops alert.
  if (!UUID_RE.test(ticketId)) return c.json({ error: 'Ticket not found' }, 404);

  const [t] = await sql<{ id: string; display_id: string; subject: string; customer_id: string }[]>`
    select id, display_id, subject, customer_id
    from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!t) return c.json({ error: 'Ticket not found' }, 404);

  // Blank is computed even for permitted callers — it rides into the audit
  // metadata so the trail records which rule allowed the delete.
  const [{ blank }] = await sql<{ blank: boolean }[]>`
    select not exists (
      select 1 from ticket_messages
      where workspace_id = ${workspaceId} and ticket_id = ${ticketId}
        and deleted_at is null
        and role in ('customer','agent','ai','note')
    ) as blank
  `;
  if (!blank && !(await hasDeletePermission(c))) {
    return c.json({ error: 'You do not have permission to delete tickets' }, 403);
  }

  // A merge primary with live duplicates can't be deleted: the duplicates'
  // unmerge would strip messages from (and point at) a hidden ticket.
  // Deleting a merged SOURCE is allowed — its messages already live on the
  // primary; it just forfeits its unmerge (the unmerge route filters
  // deleted_at is null).
  const [child] = await sql`
    select 1 from tickets
    where workspace_id = ${workspaceId} and merged_into_id = ${ticketId} and deleted_at is null
    limit 1
  `;
  if (child) {
    return c.json({ error: 'This ticket has merged duplicates — unmerge them first', code: 'has_merged_children' }, 409);
  }

  await sql`
    update tickets set deleted_at = now()
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'ticket.deleted',
    targetType: 'ticket',
    targetId: t.id,
    metadata: { display_id: t.display_id, subject: t.subject, customer_id: t.customer_id, blank },
  });
  return new Response(null, { status: 204 });
});

// ─── POST /:id/time — log a time entry ───────────────────────────────────
//
// minutes must be a positive integer. user_id is stamped from the JWT
// (the agent who clicked "Log time"), not trusted from the client.
const PostTime = z.object({
  minutes:  z.number().int().positive().max(60 * 24),  // max 24h per entry
  note:     z.string().nullable().optional(),
  billable: z.boolean().optional(),
});

tickets.post('/:id/time', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostTime.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const { minutes, note, billable } = parsed.data;

  // Workspace-scope check.
  const [ticket] = await sql`
    select id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const [entry] = await sql<{ id: string; user_id: string; minutes: number; note: string | null; billable: boolean; created_at: string; user_name: string | null }[]>`
    with ins as (
      insert into time_entries (workspace_id, ticket_id, user_id, minutes, note, billable)
      values (${workspaceId}, ${ticketId}, ${userId}, ${minutes}, ${note ?? null}, ${billable ?? true})
      returning id, user_id, minutes, note, billable, created_at
    )
    select ins.*, u.name as user_name
    from ins left join users u on u.id = ins.user_id
  `;

  // Flatten the user join so the client gets a consistent shape with the
  // detail-endpoint time_entries payload.
  return c.json({
    entry: {
      id:         entry.id,
      user_id:    entry.user_id,
      user_name:  entry.user_name || null,
      minutes:    entry.minutes,
      note:       entry.note,
      billable:   entry.billable,
      created_at: entry.created_at,
    },
  }, 201);
});

// ─── DELETE /:id/time/:entryId — remove a time entry ─────────────────────
//
// Only the original logger can delete, with two escape hatches: platform
// admins (already past the auth middleware) and workspace-role admins.
// Mirrors the client-side guard.
tickets.delete('/:id/time/:entryId', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');
  const entryId = c.req.param('entryId');

  const [entry] = await sql<{ id: string; user_id: string; workspace_id: string; ticket_id: string }[]>`
    select id, user_id, workspace_id, ticket_id from time_entries where id = ${entryId}
  `;
  if (!entry || entry.workspace_id !== workspaceId || entry.ticket_id !== ticketId) {
    return c.json({ error: 'Time entry not found' }, 404);
  }

  if (entry.user_id !== userId) {
    // Caller didn't log it — allow if they're a platform admin or a
    // workspace-role admin. Both checks in parallel.
    const [paRows, waRows] = await Promise.all([
      sql<{ is_platform_admin: boolean | null }[]>`select is_platform_admin from users where id = ${userId}`,
      sql<{ is_admin: boolean | null }[]>`
        select r.is_admin
        from workspace_members wm join roles r on r.id = wm.role_id
        where wm.user_id = ${userId} and wm.workspace_id = ${workspaceId} and wm.active = true
      `,
    ]);
    const isPlatformAdmin  = Boolean(paRows[0]?.is_platform_admin);
    const isWorkspaceAdmin = Boolean(waRows[0]?.is_admin);
    if (!isPlatformAdmin && !isWorkspaceAdmin) {
      return c.json({ error: 'Only the original logger or an admin can remove this entry' }, 403);
    }
  }

  await sql`delete from time_entries where id = ${entryId}`;

  return new Response(null, { status: 204 });
});

// ─── POST /:id/apply-rules — run assignment rules against this ticket ──
//
// Returns { matched: false } when no rule fires (rule.matchCount stays
// flat, no ticket update). Otherwise { matched: true, rule, ticket }
// reflecting the post-engine state.
tickets.post('/:id/apply-rules', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const result = await applyAssignmentRules({ workspaceId, ticketId });
  if (!result) return c.json({ matched: false });

  const [ticket] = await sql`
    select id, display_id, assigned_user_id, status_key, priority_key, category_key
    from tickets where id = ${ticketId} and workspace_id = ${workspaceId}
  `;

  return c.json({
    matched:  true,
    rule:     { id: result.rule_id, name: result.rule_name },
    ticket,
  });
});

const CreateTicket = z.object({
  subject: z.string().min(1).max(500),
  customer_id: z.string().uuid(),
  status_key: z.string().default('open'),
  priority_key: z.string().default('normal'),
  // Bounded like every other free-text field — the value is validated
  // against the workspace's categories below, but an unbounded string
  // shouldn't reach the query in the first place.
  category_key: z.string().min(1).max(100).optional(),
  // Explicit assignee (the new-ticket flow's step-1 pick). When present the
  // assignment-rules engine is SKIPPED — an agent's deliberate choice wins.
  assigned_user_id: z.string().uuid().optional(),
  // API-only convenience (external callers): inserts a role='customer'
  // message labelled 'API caller' — NOT emailed. The SPA never uses it; its
  // agent-authored first message goes through POST /:id/messages so it gets
  // real authorship + email delivery.
  initial_message: z.string().min(1).optional(),
});

tickets.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');

  const body = await c.req.json().catch(() => null);
  const parsed = CreateTicket.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Confirm the customer belongs to this workspace — never insert a ticket that
  // references another workspace's customer (advisory #16).
  const [customer] = await sql`
    select 1 from customers
    where id = ${input.customer_id} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!customer) return c.json({ error: 'Customer not found' }, 404);

  // Reject an unknown/disabled category — same rule the PATCH handler
  // enforces. Omitted stays nullable (player-lookup and API callers send
  // none). Matched case-insensitively, like the rules engine's catEq
  // (lib/assign-rules-engine.ts), so a caller can't be refused here for a
  // key that downstream matching would happily accept; the row stores the
  // canonical key.
  let categoryKey = input.category_key ?? null;
  if (categoryKey != null) {
    const [cat] = await sql<{ key: string }[]>`
      select key from ticket_categories
      where workspace_id = ${workspaceId} and lower(key) = lower(${categoryKey}) and is_active = true
    `;
    if (!cat) return c.json({ error: `Unknown or inactive category: ${categoryKey}` }, 400);
    categoryKey = cat.key;
  }

  // Reject an explicit assignee who isn't an active member — mirrors the
  // PATCH handler's assignee check and the customer_id check above.
  if (input.assigned_user_id != null) {
    const [member] = await sql`
      select 1 from workspace_members
      where user_id = ${input.assigned_user_id} and workspace_id = ${workspaceId} and active = true
    `;
    if (!member) return c.json({ error: 'Assignee is not an active member of this workspace' }, 400);
  }

  const displayId = await nextDisplayId(sql, workspaceId, 'ticket');

  const [created] = await sql<{ id: string }[]>`
    insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, category_key, assigned_user_id)
    values (${workspaceId}, ${displayId}, ${input.subject}, ${input.customer_id},
            ${input.status_key}, ${input.priority_key}, ${categoryKey},
            ${input.assigned_user_id ?? userId})
    returning id
  `;

  if (input.initial_message) {
    await sql`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
      values (${workspaceId}, ${created.id}, 'customer', 'API caller', ${input.initial_message})
    `;
  }

  // Auto-apply assignment rules on the freshly-created ticket — but ONLY
  // when no explicit assignee was given (a deliberate step-1 pick must not
  // be overridden by a rule). Errors swallowed (logged) so a misconfigured
  // rule can't break ticket creation. Without an explicit assignee the
  // insert stamps assigned_user_id=userId (the creating agent) and the
  // engine may override that with a rule's pick.
  if (input.assigned_user_id == null) {
    try { await applyAssignmentRules({ workspaceId, ticketId: created.id }); }
    catch (err) { console.error('[assign-rules-engine] post-create failure:', err); }
  }

  // Slack notification on creation. AWAITED deliberately: an unawaited
  // dispatch can be dropped when the runtime freezes the moment the response
  // is written (the same reason /sync awaits its last_active_at stamp).
  try { await notifySlack({ workspaceId, event: 'ticket.created', ticketId: created.id }); }
  catch (err) { console.warn('[slack] notify created failed:', err); }
  // Generic outgoing webhooks (any URL the workspace configured) — awaited
  // for the same durability reason.
  try { await dispatchTicketEvent({ workspaceId, event: 'ticket.created', ticketId: created.id }); }
  catch (err) { console.warn('[outgoing-webhooks] created failed:', err); }

  void publishTicketChanged(workspaceId, created.id);

  // Re-select AFTER the rules step with the list endpoint's exact column
  // set, so the SPA can upsert the row locally without a follow-up fetch —
  // the insert's `returning` would show the pre-rules assignee.
  const [ticket] = await sql`
    select ${ticketListCols(sql)}
    from tickets
    where id = ${created.id} and workspace_id = ${workspaceId}
  `;
  // The row was just inserted in this request and nothing deletes between —
  // but never hand the SPA an undefined row if that ever changes.
  if (!ticket) return c.json({ ticket: { id: created.id, display_id: displayId } }, 201);
  return c.json({ ticket }, 201);
});

// Presence routes (POST/DELETE /:id/presence) moved to
// api/src/routes/presence.ts in PR #239 and generalised to
// /api/v1/presence/:entity_type/:entity_id so non-ticket
// surfaces can opt in too. See that file for the live-sync
// piggyback that used to live here.
