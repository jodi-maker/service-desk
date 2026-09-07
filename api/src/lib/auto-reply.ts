import type { TriageOutput } from './triage.js';
import { env } from './env.js';
import { getDb } from './db.js';
import { resolveTicketRecipient } from './ticket-recipient.js';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
// postmark-outbound is external HTTP.
import {
  isPostmarkConfigured,
  PostmarkNotConfiguredError,
  PostmarkSendError,
  replySubject,
} from './postmark-outbound.js';
import { sendBrandedEmail } from './send-branded-email.js';
import { composeEmail } from './email-branding.js';

// ─── Config ──────────────────────────────────────────────────────────────

export interface WorkspaceAutoReplyConfig {
  min_confidence: number | null;     // null = auto-reply disabled
  categories: string[];              // empty = no auto-reply
  name: string;                      // workspace name, used as sign-off in the reply
}

// Category keys are labels whose casing can differ across layers (the SPA
// labelCase()-es ticket categories; workspace config keeps raw stored keys) —
// compare them case-insensitively.
const catEq = (a: unknown, b: unknown): boolean =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

// ─── Responsible-gambling safety gate ─────────────────────────────────────
//
// Duty of care: never send an automated, canned reply to a customer who is
// disclosing gambling harm, asking to be self-excluded, requesting a limit, or
// in acute distress. Those tickets must reach a human.
//
// This is a CONTENT signal, not an account-status one — Maestro has no
// confirmed RG/self-exclusion endpoint yet (see lib/player-context.ts), so we
// detect the concern from what the customer actually wrote. When the platform
// gives us an account-level RG/self-exclusion flag, add it as a second source
// that ORs into this gate.
//
// Bias is deliberately toward holding: a false positive just means a human
// handles a ticket the AI could have (cheap); a false negative means an
// automated reply to someone in crisis (unacceptable). Matching is
// case-insensitive; multi-word phrases are specific enough to keep the
// false-positive rate low for an iGaming support desk.
const RG_CONCERN_PATTERNS: RegExp[] = [
  // Self-exclusion & RG tooling / providers
  /self[\s-]?exclu/i, /\bgamstop\b/i, /\bgamban\b/i, /\bgamcare\b/i, /\bbe ?gamble ?aware\b/i,
  /cooling[\s-]?off/i, /\bexclude me\b/i, /\bclose my account\b/i,
  // Limits (an RG tool request, not a routine query)
  /deposit limit/i, /loss limit/i, /wager limit/i, /\bset (a )?limit\b/i, /lower my limit/i,
  // Harm / addiction / loss of control
  /gambling (problem|addiction|harm)/i, /problem gambling/i, /compulsive gambl/i,
  /addicted to gambl/i, /can'?t stop gambl/i, /chasing (my )?losses/i,
  /out of control/i, /responsible (gambling|gaming)/i,
  // Acute distress / safeguarding
  /suicid/i, /\bkill myself\b/i, /end my life/i, /self[\s-]?harm/i, /harm myself/i,
];

/**
 * Returns true if any of the supplied customer-authored texts (subject + the
 * customer's own messages) signal a responsible-gambling concern. Pure +
 * deterministic. Pass only customer-authored content — agent/AI replies must
 * not trip the gate.
 */
export function detectResponsibleGamblingConcern(texts: (string | null | undefined)[]): boolean {
  for (const t of texts) {
    if (!t) continue;
    if (RG_CONCERN_PATTERNS.some((re) => re.test(t))) return true;
  }
  return false;
}

// ─── Evaluation ──────────────────────────────────────────────────────────

export type AutoReplyDecision =
  | { eligible: true; reason: 'all_gates_passed' }
  | { eligible: false; reason:
      | 'workspace_disabled'
      | 'category_not_allowed'
      | 'responsible_gambling_hold'
      | 'confidence_below_threshold' };

/**
 * Pure function — no DB access, easy to unit test. Returns eligibility +
 * a tag describing why so callers can log it.
 *
 * `rgConcern` is the responsible-gambling safety signal from
 * detectResponsibleGamblingConcern(). It overrides confidence — a high-
 * confidence reply to a harm/self-exclusion disclosure is exactly the case we
 * must hold for a human — but is only evaluated for tickets the workspace
 * would otherwise auto-reply to (enabled + allowed category).
 */
export function evaluateAutoReply(
  triage: TriageOutput,
  config: WorkspaceAutoReplyConfig,
  rgConcern = false,
): AutoReplyDecision {
  if (config.min_confidence === null || config.categories.length === 0) {
    return { eligible: false, reason: 'workspace_disabled' };
  }
  // Case-insensitive: category keys are labels whose casing can differ across
  // layers (SPA labelCase() vs raw stored keys).
  if (!config.categories.some((c) => catEq(c, triage.category_key))) {
    return { eligible: false, reason: 'category_not_allowed' };
  }
  if (rgConcern) {
    return { eligible: false, reason: 'responsible_gambling_hold' };
  }
  if (triage.confidence < config.min_confidence) {
    return { eligible: false, reason: 'confidence_below_threshold' };
  }
  return { eligible: true, reason: 'all_gates_passed' };
}

// ─── Posting ─────────────────────────────────────────────────────────────

export interface PostAutoReplyArgs {
  workspaceId: string;
  ticketId: string;
  draftReply: string;
  confidence: number;
  model: string;
  workspaceName: string;
}

export type PostAutoReplyResult =
  | { posted: true; message_id: string; postmark_message_id: string; rfc_message_id: string }
  | { posted: false; reason:
      | 'already_auto_replied'
      | 'postmark_not_configured'
      | 'customer_email_missing'
      | 'email_suppressed'
      | 'send_failed';
      detail?: string };

/**
 * Send the AI draft to the customer via Postmark, then record it as an
 * ai-role ticket_messages row + audit event. Idempotent: if an auto_reply
 * event already exists on this ticket, returns posted=false rather than
 * sending again.
 *
 * Ordering: send first, then record. If the DB writes fail after a
 * successful send, the worst case on retry is one duplicate email (the
 * idempotency check will pass because no event row was written). The
 * alternative — record first, send second — risks a "ghost" reply in the
 * ticket thread that the customer never received, which is worse.
 *
 * Send failures (Postmark not configured, customer has no email, Postmark
 * rejects) return posted=false with a reason; the ai_draft_reply stays on
 * the ticket so a human can review and send manually.
 */
export async function postAutoReply(args: PostAutoReplyArgs): Promise<PostAutoReplyResult> {
  const { workspaceId, ticketId, draftReply, confidence, model, workspaceName } = args;
  const sql = getDb();

  // 1. Idempotency check — has this ticket already been auto-replied?
  const [existing] = await sql`
    select id from events
    where workspace_id = ${workspaceId} and entity_type = 'ticket'
      and entity_id = ${ticketId} and kind = 'auto_reply'
    limit 1
  `;
  if (existing) {
    return { posted: false, reason: 'already_auto_replied' };
  }

  // 2. Bail early if outbound isn't configured. The draft is still on the
  //    ticket; an agent can copy/paste it manually until env is wired up.
  if (!isPostmarkConfigured()) {
    return { posted: false, reason: 'postmark_not_configured' };
  }

  // 3. Load what we need to send: customer email + subject + last customer
  //    message's external_message_id (for In-Reply-To threading).
  const sendContext = await loadSendContext(ticketId, workspaceId);
  if (!sendContext.customerEmail) {
    return { posted: false, reason: 'customer_email_missing' };
  }
  if (sendContext.suppressed) return { posted: false, reason: 'email_suppressed' };

  // 4. Send via Postmark. From identity: brand-owned verified domain with
  //    platform fallback + rejection safety net (send-branded-email.ts). On
  //    failure, leave the draft and return — don't create the event row, so
  //    a manual re-triage from the UI can retry.
  // Brand the AI reply with the workspace's default header/footer. No author
  // signature — the auto-reply is sent as the brand, not a named agent.
  const composed = await composeEmail({ workspaceId, bodyText: draftReply });

  let postmarkMessageId: string;
  let rfcMessageId: string;
  try {
    const result = await sendBrandedEmail({
      workspaceId,
      fallbackFromName: workspaceName,
      to: sendContext.customerEmail,
      subject: replySubject(sendContext.subject),
      textBody: composed.text,
      htmlBody: composed.html,
      inReplyTo: sendContext.lastCustomerMessageId,
      // Route customer replies back through the inbound webhook so they
      // attach to this ticket rather than landing in the From mailbox.
      // Empty string means use From as Reply-To (Postmark default).
      replyTo: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
    });
    postmarkMessageId = result.messageId;
    rfcMessageId = result.rfcMessageId;
  } catch (err) {
    if (err instanceof PostmarkNotConfiguredError) {
      return { posted: false, reason: 'postmark_not_configured' };
    }
    const detail = err instanceof PostmarkSendError
      ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.error(`[auto-reply] Postmark send failed for ticket ${ticketId}: ${detail}`);
    return { posted: false, reason: 'send_failed', detail };
  }

  // 5. Post the AI message. author_label is the workspace name so the customer
  //    sees a brand-consistent sender (matches the prompt's sign-off rule).
  //    Store the FULL RFC Message-Id (with brackets + domain) — same format
  //    as customer inbound messages — so In-Reply-To matching on a reply
  //    finds this row exactly.
  const [msg] = await sql<{ id: string }[]>`
    insert into ticket_messages (workspace_id, ticket_id, role, author_user_id, author_label, body, external_message_id)
    values (${workspaceId}, ${ticketId}, 'ai', null, ${workspaceName}, ${draftReply}, ${rfcMessageId})
    returning id
  `;
  if (!msg) throw new Error('Auto-reply message insert failed');

  // 6. Audit event — confidence + model + Postmark ID for delivery correlation.
  try {
    await sql`
      insert into events (workspace_id, entity_type, entity_id, kind, author_label, details)
      values (${workspaceId}, 'ticket', ${ticketId}, 'auto_reply', ${workspaceName},
        ${`Auto-reply sent (confidence ${confidence}, model ${model}, postmark_id ${postmarkMessageId})`})
    `;
  } catch (err) {
    console.error('[auto-reply] event log failed:', err instanceof Error ? err.message : err);
    // Don't fail the whole post — the email already went out + message row exists.
  }

  return {
    posted: true,
    message_id: msg.id,
    postmark_message_id: postmarkMessageId,
    rfc_message_id: rfcMessageId,
  };
}

// ─── Send context loader ─────────────────────────────────────────────────

interface SendContext {
  customerEmail: string | null;
  suppressed: boolean;
  subject: string;
  lastCustomerMessageId: string | null;   // RFC Message-ID for threading
}

async function loadSendContext(
  ticketId: string,
  workspaceId: string,
): Promise<SendContext> {
  const sql = getDb();
  const [ticket] = await sql<{ subject: string }[]>`
    select subject from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) throw new Error('Ticket lookup for send failed: not found');

  // Most recent customer message with a Message-ID → our In-Reply-To (if any).
  const [lastMsg] = await sql<{ external_message_id: string }[]>`
    select external_message_id from ticket_messages
    where ticket_id = ${ticketId} and workspace_id = ${workspaceId} and role = 'customer'
      and deleted_at is null and external_message_id is not null
    order by created_at desc
    limit 1
  `;

  const recipient = await resolveTicketRecipient(workspaceId, ticketId);
  return {
    customerEmail: recipient?.email ?? null,
    suppressed: recipient?.suppressed ?? false,
    subject: ticket.subject,
    lastCustomerMessageId: lastMsg?.external_message_id ?? null,
  };
}
