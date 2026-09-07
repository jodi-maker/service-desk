import { getDb } from './db.js';
import { nextDisplayId } from './display-id.js';
import { resolveCustomerByContact, ensurePrimaryContacts } from './customer-contacts.js';
import { scheduleLink } from './player-identity.js';
import {
  extractInReplyTo,
  extractMessageId,
  parseFrom,
  parseTo,
  pickBody,
  type PostmarkInbound,
} from './postmark.js';
import { triageTicket } from './triage.js';
import { BudgetExceededError } from './budget.js';
import { scoreMessageSentiment } from './sentiment.js';
import { publishTicketChanged } from './pubby.js';
import { isUserActive } from './activity.js';
import { isPushConfigured, sendPushToUser } from './push.js';
import { sanitizeEmailHtml } from './email-html.js';
import { insertAttachmentRows, uploadInboundAttachments, type StoreDeps } from './message-attachments.js';

// Optional injection points (tests): the attachment store.
export interface InboundDeps {
  attachments?: StoreDeps;
}

// Store the email's files under the just-inserted message, sanitise its HTML
// with the resulting cid map, and persist body_html (+ skip notes appended to
// the text body). Best-effort as a whole: any failure here is logged and the
// message stays as plain text — Postmark must always get its 200.
async function persistRichBody(args: {
  workspaceId: string;
  ticketId: string;
  messageId: string;
  body: string;
  payload: PostmarkInbound;
  deps?: InboundDeps;
}): Promise<void> {
  const { workspaceId, ticketId, messageId, body, payload } = args;
  const sql = getDb();
  try {
    // Upload first: the sanitiser needs the Content-ID → attachment-id map, and
    // the rows need to know which of those the HTML actually embeds.
    const uploaded = await uploadInboundAttachments(
      { workspaceId, ticketId, attachments: payload.Attachments },
      args.deps?.attachments,
    );
    const { html, usedCids } = sanitizeEmailHtml(payload.HtmlBody ?? '', { cidMap: uploaded.cidMap });
    await insertAttachmentRows(sql, { workspaceId, ticketId, messageId }, uploaded.pending, usedCids, args.deps?.attachments);

    const skipped = uploaded.skipped.length > 0;
    if (html || skipped) {
      const newBody = skipped ? `${body}\n\n${uploaded.skipped.join('\n')}` : body;
      await sql`
        update ticket_messages
        set body_html = ${html || null}, body = ${newBody}
        where id = ${messageId} and workspace_id = ${workspaceId}
      `;
    }
  } catch (err) {
    console.error('[inbound-email] rich body/attachments failed (message kept as text):', err instanceof Error ? err.message : err);
  }
}

// Fire-and-forget wrapper around scoreMessageSentiment used by the
// inbound-email and reply paths. We never want sentiment to break the
// webhook response — log + swallow on any throw so Postmark still
// gets its 200 and the message row is already persisted.
function scoreInboundMessage(args: { workspaceId: string; ticketId: string; messageId: string; body: string }): void {
  void scoreMessageSentiment(args).catch((err) => {
    console.warn('[sentiment] inbound score failed:', err instanceof Error ? err.message : err);
  });
}

// ─── Channel resolution ──────────────────────────────────────────────────
//
// Resolves the workspace's channel for an inbound email: best match by To:
// address (case-insensitive), else the oldest active email channel, else
// null (e.g. unrouted bucket, freshly provisioned brand with no channels
// seeded). The resolved channel always drives the inbox_messages
// attribution (that column is NOT NULL, so the fallback is required), but
// its ticket DEFAULTS (priority/category) are only applied when `matched`
// is true — an address that matches no channel must not inherit the oldest
// channel's urgency (imagine the oldest active channel being complaint@).

export interface InboundChannel {
  id: string;
  default_priority_key: string | null;
  default_category_key: string | null;
  // true = the To: address matched this channel's address; false = this is
  // the oldest-active fallback, good for attribution only.
  matched: boolean;
}

export async function resolveInboundChannel(
  workspaceId: string,
  toEmail: string | null,
): Promise<InboundChannel | null> {
  const sql = getDb();
  const channels = await sql<(Omit<InboundChannel, 'matched'> & { address: string | null })[]>`
    select id, address, default_priority_key, default_category_key from channels
    where workspace_id = ${workspaceId} and type = 'email' and status = 'active'
      and deleted_at is null
    order by created_at asc, id asc
  `;
  if (channels.length === 0) return null;

  const matched = toEmail
    ? channels.find((c) => (c.address || '').toLowerCase() === toEmail.toLowerCase())
    : null;
  return matched ? { ...matched, matched: true } : { ...channels[0], matched: false };
}

// ─── Inbox message helper ────────────────────────────────────────────────
//
// Writes an inbox_messages row attributed to the already-resolved channel.
// Skipped silently when the workspace has no channel —
// inbox_messages.channel_id is NOT NULL so we can't write a placeholder.
// Insert errors are logged but never thrown: the inbox row is an audit
// trail, not load-bearing for the customer-facing ticket creation.
async function recordInboundInInbox(args: {
  workspaceId: string;
  payload: PostmarkInbound;
  ticketId: string;
  channelId: string | null;
  body: string;   // pickBody(payload), already computed by the caller
}): Promise<void> {
  const { workspaceId, payload, ticketId, channelId, body } = args;
  const sql = getDb();
  if (!channelId) return;

  const { email, name } = parseFrom(payload);

  try {
    await sql`
      insert into inbox_messages
        (workspace_id, channel_id, external_id, from_name, from_email, subject, body, body_html, received_at, status, converted_ticket_id)
      values
        (${workspaceId}, ${channelId}, ${extractMessageId(payload)}, ${name || null}, ${email},
         ${payload.Subject || null}, ${body}, ${payload.HtmlBody?.trim() || null}, now(), 'converted', ${ticketId})
    `;
  } catch (err) {
    // Unique violation on (channel_id, external_id) is expected on Postmark
    // retries — silent skip. Anything else, log it.
    if ((err as any)?.code !== '23505') {
      console.warn('[inbound-email] inbox_messages insert failed:', err instanceof Error ? err.message : err);
    }
  }
}

// ─── Workspace resolution ────────────────────────────────────────────────
//
// Maps an inbound email's To: domain to the destination workspace.
//
// Lookup is against workspace_email_domains (citext column — case folding
// is handled by the database). On no-match, mail falls through to the
// system "unrouted" workspace (is_unrouted_bucket = true, seeded by
// 20260522150000_workspace_branding.sql) so a customer email never
// silently drops. The platform admin reviews unrouted mail in the god UI
// and either creates the missing brand or replies via the bucket directly.

export interface WorkspaceResolution {
  workspaceId: string;
  routed: boolean;             // false → fell back to the unrouted bucket
  matchedDomain: string | null;
}

export async function resolveInboundWorkspace(args: {
  toDomain: string | null;
}): Promise<WorkspaceResolution> {
  const { toDomain } = args;
  const sql = getDb();

  if (toDomain) {
    // verified_at gate: with self-serve domain adding, an UNVERIFIED claim
    // must never route another brand's mail — a workspace admin could
    // otherwise claim a competitor's domain and receive their inbound.
    const [match] = await sql<{ workspace_id: string; domain: string }[]>`
      select workspace_id, domain from workspace_email_domains
      where domain = ${toDomain} and verified_at is not null and deleted_at is null
    `;
    if (match) {
      return { workspaceId: match.workspace_id, routed: true, matchedDomain: match.domain };
    }
  }

  const [bucket] = await sql<{ id: string }[]>`select id from workspaces where is_unrouted_bucket = true`;
  if (!bucket) throw new Error('Unrouted bucket lookup failed: not found');
  return { workspaceId: bucket.id, routed: false, matchedDomain: null };
}

// ─── Entry point ─────────────────────────────────────────────────────────

export interface InboundResult {
  ticket_id: string;
  ticket_display_id: string;
  customer_id: string;
  is_new_customer: boolean;
  auto_triage_queued: boolean;
  // true when this payload's RFC Message-ID matched an existing
  // customer message — Postmark retry, no new ticket created.
  deduped: boolean;
  // true when In-Reply-To matched a prior message and this email was
  // attached to that existing ticket instead of creating a new one.
  threaded: boolean;
}

/**
 * Convert an inbound email into a ticket. Steps:
 *   0. Dedup check: if a customer message with this RFC Message-ID already
 *      exists for the workspace, return its ticket without creating anything.
 *   1. Match the sender against customers by email; create a stub if missing.
 *   2. Create a ticket with status=open; priority/category come from the
 *      To:-matched channel's defaults (complaint@ -> urgent), else normal.
 *   3. Create the first ticket_messages row from the email body.
 *   4. Fire-and-forget auto-triage. The webhook returns immediately so Postmark
 *      doesn't retry — triage runs in the background and updates the ticket
 *      when done.
 *
 * Called by the Postmark webhook handler. Assumes the request has already
 * been authenticated (via Basic Auth in the webhook URL).
 */
export async function processInboundEmail(args: {
  workspaceId: string;
  payload: PostmarkInbound;
  deps?: InboundDeps;
}): Promise<InboundResult> {
  const { workspaceId, payload, deps } = args;
  const sql = getDb();
  const { email, name } = parseFrom(payload);
  const body = pickBody(payload);
  const subject = payload.Subject?.trim() || '(no subject)';
  const externalMessageId = extractMessageId(payload);
  const inReplyTo = extractInReplyTo(payload);

  // The thread-attach + dedup lookups below are intentionally
  // WORKSPACE-AGNOSTIC. The webhook resolves a destination workspace from the
  // To: domain, but replies routed through a shared inbound address (e.g.
  // Postmark's `…@inbound.postmarkapp.com`, used when a brand has no verified
  // sending domain) carry no brand in the recipient — domain resolution then
  // falls back to the unrouted bucket. An RFC Message-ID is globally unique,
  // so matching on it directly attaches the reply to the original ticket in
  // its OWN workspace regardless of how the recipient resolved. Both lookups
  // are backed by the ts_msg_external_id index (20260625120000).

  // 0a. Dedup — Postmark retries redeliver the same payload. If we've already
  //     stored a customer message with this incoming RFC Message-ID, return
  //     that ticket instead of creating/attaching a duplicate. Done BEFORE
  //     thread-attach so a retried reply isn't appended to its parent twice.
  //     Skipped when the sender omits Message-ID (can't be deduped).
  if (externalMessageId) {
    const [dup] = await sql<{ ticket_id: string; display_id: string; customer_id: string }[]>`
      select tm.ticket_id, t.display_id, t.customer_id
      from ticket_messages tm
      join tickets t on t.id = tm.ticket_id
      where tm.role = 'customer'
        and tm.external_message_id = ${externalMessageId} and tm.deleted_at is null
      limit 1
    `;
    if (dup) {
      return {
        ticket_id: dup.ticket_id,
        ticket_display_id: dup.display_id ?? '',
        customer_id: dup.customer_id ?? '',
        is_new_customer: false,
        auto_triage_queued: false,
        deduped: true,
        threaded: false,
      };
    }
  }

  // 0b. Thread-attach — if In-Reply-To references a Message-ID we sent (our
  //     outbound agent reply / auto-reply) or a prior customer message, attach
  //     this email onto THAT ticket — in its own workspace — instead of
  //     creating a new one. Match against any role; skip a soft-deleted parent
  //     ticket so the reply still surfaces via the normal create flow.
  if (inReplyTo) {
    const [t] = await sql<{ id: string; workspace_id: string; display_id: string; customer_id: string }[]>`
      select t.id, t.workspace_id, t.display_id, t.customer_id
      from ticket_messages tm
      join tickets t on t.id = tm.ticket_id
      where tm.external_message_id = ${inReplyTo}
        and tm.deleted_at is null and t.deleted_at is null
      order by tm.created_at desc
      limit 1
    `;
    if (t) {
      return await attachReplyToTicket({
        workspaceId: t.workspace_id, ticketId: t.id, ticketDisplayId: t.display_id,
        customerId: t.customer_id, body, name, email,
        externalMessageId, payload, deps,
      });
    }
  }

  // 1. Match-or-create the customer.
  let customerId: string;
  let isNewCustomer = false;
  // Any address the customer holds — primary or secondary — resolves to them
  // (Phase 4 contacts model; lib/customer-contacts.ts). `heal` backfills the
  // contact rows of a legacy profile that only has the scalar.
  const existingCustomer = await resolveCustomerByContact(sql, workspaceId, 'email', email, { heal: true });

  if (existingCustomer) {
    // A merged-away duplicate deliberately keeps its email address (the merge
    // never copies it to the survivor) — but NEW contact belongs on the
    // survivor, or ticket history re-fragments right after the merge that
    // consolidated it. Single hop is enough: a profile with merged children
    // can't itself be merged away (409 in the merge route).
    customerId = existingCustomer.merged_into_customer_id || existingCustomer.id;
  } else {
    // Stub customer — name parsed from From header if present, no other PII.
    // Agents can fill in mobile/brand/VIP-tier later via the UI.
    //
    // Race window: two webhook retries for the same NEW sender both miss the
    // lookup above and try to insert. The (workspace_id, email) unique
    // constraint guarantees one wins; the loser hits PG 23505. On that
    // specific error, re-query for the row the winner just created and use
    // that customer_id instead of failing the whole webhook (Postmark would
    // otherwise retry up to 10 times). Any other DB error still bubbles.
    const [firstName, ...rest] = (name ?? email.split('@')[0]).split(/\s+/);
    const lastName = rest.join(' ') || null;
    try {
      // Customer row + its primary email contact land together (the contacts
      // model's mirror invariant), so a crash can't leave a scalar-only row.
      customerId = await sql.begin(async (tx) => {
        const custDisplayId = await nextDisplayId(tx, workspaceId, 'customer');
        const [created] = await tx<{ id: string }[]>`
          insert into customers (workspace_id, display_id, first_name, last_name, email)
          values (${workspaceId}, ${custDisplayId}, ${firstName}, ${lastName}, ${email})
          returning id
        `;
        await ensurePrimaryContacts(tx, { workspaceId, customerId: created.id, email }, { strict: true });
        return created.id;
      });
      isNewCustomer = true;
    } catch (err) {
      // Unique violation → a concurrent retry won the race (the customers
      // scalar index or the contacts email index, whichever fires first).
      // Resolve the winner by contact — falling back to the scalar and healing
      // a legacy row — rather than failing the webhook.
      if ((err as any)?.code === '23505') {
        const winner = await resolveCustomerByContact(sql, workspaceId, 'email', email, { heal: true });
        if (!winner) throw new Error('Customer race recovery failed: row not visible after unique violation');
        customerId = winner.merged_into_customer_id || winner.id;
        // isNewCustomer stays false — the other request created it.
      } else {
        throw new Error(`Customer create failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 2. Create the ticket. Priority/category come from the channel's defaults
  //    ONLY when the To: address actually matched it — the oldest-active
  //    fallback attributes the inbox row but must not lend its urgency to
  //    mail sent to some unconfigured alias. These defaults stick:
  //    auto-triage only writes SUGGESTIONS (ai_summary), it never
  //    overwrites the ticket's actual priority/category.
  const to = parseTo(payload);
  const channel = await resolveInboundChannel(workspaceId, to?.email ?? null);
  const defaults = channel?.matched ? channel : null;
  const ticketDisplayId = await nextDisplayId(sql, workspaceId, 'ticket');
  const [newTicket] = await sql<{ id: string; display_id: string }[]>`
    insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, category_key, sla_state, last_inbound_email)
    values (${workspaceId}, ${ticketDisplayId}, ${subject}, ${customerId}, 'open',
            ${defaults?.default_priority_key ?? 'normal'}, ${defaults?.default_category_key ?? null}, 'ok', ${email})
    returning id, display_id
  `;
  if (!newTicket) throw new Error('Ticket create failed');

  // 3. First message from the email body. The RFC Message-ID is stored so we
  //    can thread our reply via In-Reply-To when auto-reply fires.
  const authorLabel = name?.trim() || email;
  const [newMessage] = await sql<{ id: string }[]>`
    insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
    values (${workspaceId}, ${newTicket.id}, 'customer', ${authorLabel}, ${body}, ${externalMessageId})
    returning id
  `;
  if (!newMessage) throw new Error('Message create failed');
  void scoreInboundMessage({ workspaceId, ticketId: newTicket.id, messageId: newMessage.id, body });

  // 3'. Files + formatted body. Awaited (not fire-and-forget) so the ticket the
  //     agent opens moments later already has them; failures degrade to text.
  await persistRichBody({ workspaceId, ticketId: newTicket.id, messageId: newMessage.id, body, payload, deps });

  // 3a. Attach the contact to its Maestro player (ids + username; fills blank
  //     VIP / country). Runs AFTER the ticket + message land so it never
  //     competes with them for the pool on the webhook hot path. Self-contained
  //     — resolves an outcome instead of throwing, skips already-linked
  //     contacts, no-ops for non-Maestro workspaces (lib/player-identity.ts).
  //     `email` is the address that wrote in: a casino login held as a
  //     SECONDARY address would never match on the primary mirror.
  scheduleLink({ workspaceId, customerId, email, reason: 'inbound_email' });

  // 3b. Audit row in the inbox view, attributed to the channel resolved
  //     above. Failures are logged but don't fail the webhook — the
  //     customer-facing ticket has already been created.
  await recordInboundInInbox({ workspaceId, payload, ticketId: newTicket.id, channelId: channel?.id ?? null, body });

  // 4. Fire-and-forget auto-triage. We swallow errors here — they're already
  //    logged in ai_usage_log + console — because the webhook MUST return
  //    fast or Postmark will retry. The agent can manually re-trigger
  //    triage via POST /api/v1/tickets/:id/triage if the auto attempt failed.
  let autoTriageQueued = false;
  try {
    // We deliberately don't await this. If the workspace is out of budget
    // (BudgetExceededError), we just log and move on — the ticket still
    // gets created.
    void triageTicket({
      ticketId: newTicket.id,
      workspaceId,
      userId: null,   // system-triggered, no user
    }).catch((err) => {
      if (err instanceof BudgetExceededError) {
        console.log(`[inbound-email] auto-triage skipped — workspace ${workspaceId} out of budget`);
      } else {
        console.error('[inbound-email] auto-triage failed:', err);
      }
    });
    autoTriageQueued = true;
  } catch (err) {
    console.error('[inbound-email] failed to queue auto-triage:', err);
  }

  void publishTicketChanged(workspaceId, newTicket.id);
  return {
    ticket_id: newTicket.id,
    ticket_display_id: newTicket.display_id,
    customer_id: customerId,
    is_new_customer: isNewCustomer,
    auto_triage_queued: autoTriageQueued,
    deduped: false,
    threaded: false,
  };
}

// ─── Thread-attach helper ────────────────────────────────────────────────

/**
 * Append a new customer message to an existing ticket (matched by
 * In-Reply-To). Doesn't touch the ticket's customer_id — even if the reply
 * comes from a different address (e.g. a Cc'd colleague), the ticket
 * keeps its original customer for continuity. Fires triage again so the
 * AI draft refreshes with the new context.
 */
async function attachReplyToTicket(args: {
  workspaceId: string;
  ticketId: string;
  ticketDisplayId: string;
  customerId: string;
  body: string;
  name: string | null;
  email: string;
  externalMessageId: string | null;
  payload: PostmarkInbound;
  deps?: InboundDeps;
}): Promise<InboundResult> {
  const { workspaceId, ticketId, ticketDisplayId, customerId, body, name, email, externalMessageId, payload, deps } = args;
  const sql = getDb();

  const authorLabel = name?.trim() || email;
  const [replyMessage] = await sql<{ id: string }[]>`
    insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
    values (${workspaceId}, ${ticketId}, 'customer', ${authorLabel}, ${body}, ${externalMessageId})
    returning id
  `;
  if (!replyMessage) throw new Error('Reply attach failed');
  void scoreInboundMessage({ workspaceId, ticketId, messageId: replyMessage.id, body });
  await persistRichBody({ workspaceId, ticketId, messageId: replyMessage.id, body, payload, deps });

  // Same Maestro link attempt as the new-ticket path, so a contact whose first
  // lookup failed (gateway outage) or was throttled gets retried on replies
  // too, not only when a NEW ticket arrives. Guarded: the thread's customer is
  // linked only when the SENDER's address is one of that customer's own — a
  // colleague or third party replying on the thread must never bind the
  // customer to *their* player record. Resolution failures are swallowed.
  try {
    const sender = await resolveCustomerByContact(sql, workspaceId, 'email', email);
    if (sender && (sender.merged_into_customer_id || sender.id) === customerId) {
      scheduleLink({ workspaceId, customerId, email, reason: 'inbound_email' });
    }
  } catch (err) {
    console.warn('[inbound-email] player-link sender check failed on thread-attach:', err instanceof Error ? err.message : err);
  }

  // Customer reply un-resolves the ticket so agents see it back in the open
  // queue — the same rule the portal reply path (routes/public.ts) applies,
  // which was always documented as mirroring this path. Clearing resolved_at
  // with it matters now that the column is real: a reopened ticket has no
  // resolution time (SLA breach report) and must not look purge-eligible to
  // the data-retention cron. Guarded on 'resolved' so other statuses are
  // untouched.
  // Unlike channel defaults, the reply address follows each accepted inbound
  // message from one of this customer's own addresses. Do not persist a third
  // party's address on their ticket (that party's erasure cannot reach it).
  // Outbound checks ownership again in case the address has since been removed.
  await sql`
    update tickets set
      last_inbound_email = case when exists (
        select 1 from customers c where c.id = tickets.customer_id
          and c.workspace_id = ${workspaceId} and c.erased_at is null and c.deleted_at is null
          and (
            exists (select 1 from customer_contacts cc
              where cc.customer_id = c.id and cc.workspace_id = ${workspaceId}
                and cc.kind = 'email' and cc.value = ${email} and cc.deleted_at is null)
            or (c.email = ${email} and not exists (
              select 1 from customer_contacts cc where cc.customer_id = c.id
                and cc.workspace_id = ${workspaceId} and cc.kind = 'email' and cc.deleted_at is null
            ))
          )
      ) then ${email} else null end,
      resolved_at = case when status_key = 'resolved' then null else resolved_at end,
      status_key = case when status_key = 'resolved' then 'open' else status_key end
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;

  // Audit the threaded reply in the inbox view too, so the agent can see
  // the email arrived even if they don't immediately notice the ticket
  // updated. The channel is resolved here against the TICKET's workspace
  // (thread-attach can land in a different workspace than the webhook
  // resolved, via the shared inbound address) and its defaults are NOT
  // applied — a reply to complaint@ on an existing ticket doesn't escalate
  // it. Resolution failures are swallowed: inbox auditing must never fail
  // the webhook on this path.
  const to = parseTo(payload);
  const channel = await resolveInboundChannel(workspaceId, to?.email ?? null)
    .catch((err) => {
      console.warn('[inbound-email] channel resolve failed on thread-attach:', err instanceof Error ? err.message : err);
      return null;
    });
  await recordInboundInInbox({ workspaceId, payload, ticketId, channelId: channel?.id ?? null, body });

  // Fire-and-forget retriage so the AI draft refreshes with the new turn.
  // Errors swallowed (same rationale as the create path) so Postmark gets 200.
  let autoTriageQueued = false;
  try {
    void triageTicket({ ticketId, workspaceId, userId: null }).catch((err) => {
      if (err instanceof BudgetExceededError) {
        console.log(`[inbound-email] retriage skipped — workspace ${workspaceId} out of budget`);
      } else {
        console.error('[inbound-email] retriage failed:', err);
      }
    });
    autoTriageQueued = true;
  } catch (err) {
    console.error('[inbound-email] failed to queue retriage:', err);
  }

  // Push the assigned agent if they're not currently in the app (offline-agent
  // notifications, stage 3). Awaited so the work isn't dropped on serverless
  // freeze; fully guarded so a push hiccup never fails the inbound webhook.
  try { await pushOfflineAssignee(workspaceId, ticketId); }
  catch (err) { console.warn('[push] offline-assignee notify failed:', err instanceof Error ? err.message : err); }

  void publishTicketChanged(workspaceId, ticketId);
  return {
    ticket_id: ticketId,
    ticket_display_id: ticketDisplayId,
    customer_id: customerId,
    is_new_customer: false,
    auto_triage_queued: autoTriageQueued,
    deduped: false,
    threaded: true,
  };
}

// Notify the ticket's assigned agent of a new customer reply via Web Push, but
// ONLY when they're offline (an agent in the app already gets the live toast/
// bell) and we haven't already pushed about this turn. last_reply_notified_at
// throttles a fast back-and-forth to a single push until the agent replies
// (which clears it — see POST /:id/messages). No-ops when push is unconfigured
// or the ticket is unassigned (e.g. the unrouted bucket).
async function pushOfflineAssignee(workspaceId: string, ticketId: string): Promise<void> {
  if (!isPushConfigured()) return;
  const sql = getDb();
  const [t] = await sql<{ assigned_user_id: string | null; notified: string | null; subject: string; slug: string; display_id: string }[]>`
    select t.assigned_user_id, t.last_reply_notified_at as notified, t.subject, t.display_id, w.slug
    from tickets t join workspaces w on w.id = t.workspace_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId}
  `;
  if (!t?.assigned_user_id) return;                       // unassigned — nobody to notify
  if (t.notified) return;                                 // already pushed this turn; wait for the agent to act
  if (await isUserActive(t.assigned_user_id)) return;     // in the app — the in-app toast/bell covers it

  const url = `/?ws=${encodeURIComponent(t.slug || '')}#ticket/${encodeURIComponent(t.display_id)}`;
  const res = await sendPushToUser(t.assigned_user_id, {
    title: 'New customer reply',
    body: `${t.display_id} — ${t.subject}`.slice(0, 140),
    url,
    tag: `ticket-${ticketId}`,
  });
  if (res.sent > 0) {
    await sql`update tickets set last_reply_notified_at = now() where id = ${ticketId} and workspace_id = ${workspaceId}`;
  }
}
