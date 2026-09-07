// Email an agent's public reply to the customer. Called from
// POST /tickets/:id/messages when an agent posts a `role:'agent'` reply (not
// an internal note). Turns the portal-only reply into a real two-way email
// conversation: the reply is branded (header/footer + the sending agent's
// signature), sent via Postmark, and its RFC Message-Id is stamped onto the
// ticket_messages row so the customer's reply threads straight back to this
// ticket (lib/inbound-email matches In-Reply-To against external_message_id).
//
// The message row is inserted by the caller BEFORE this runs and persists
// regardless of the email outcome — a send failure never loses the reply, it
// just reports back so the UI can show "saved, not emailed".

import { env } from './env.js';
import {
  isPostmarkConfigured,
  PostmarkSendError,
  replySubject,
} from './postmark-outbound.js';
import { sendBrandedEmail } from './send-branded-email.js';
import { composeEmail } from './email-branding.js';
import { getDb } from './db.js';
import type { OutboundFile } from './message-attachments.js';

export type AgentReplyDelivery =
  | { emailed: true; reason: 'sent'; postmark_message_id: string }
  | { emailed: false; reason:
      | 'postmark_not_configured'   // outbound not wired for this deployment
      | 'no_customer_email'         // portal-only customer / no address on file
      | 'email_suppressed'          // address hard-bounced or was marked spam
      | 'no_from'                   // no sender identity could be resolved
      | 'send_failed';              // Postmark refused the send
      detail?: string };

export async function sendAgentReplyEmail(args: {
  workspaceId:  string;
  ticketId:     string;
  messageId:    string;   // the just-inserted agent ticket_messages row
  authorUserId: string;
  body:         string;
  // Sanitised HTML body of a rich-text reply (lib/email-html.ts), with inline
  // images referenced as cid:<attachment id>.
  bodyHtml?:    string | null;
  // Attachments already bound to this message (lib/message-attachments.ts).
  // Inline ones carry a ContentID matching the cid: tokens in bodyHtml.
  attachments?: OutboundFile[];
}): Promise<AgentReplyDelivery> {
  const { workspaceId, ticketId, messageId, authorUserId, body } = args;
  if (!isPostmarkConfigured()) return { emailed: false, reason: 'postmark_not_configured' };
  const sql = getDb();

  const [ctx] = await sql<{
    subject: string;
    email: string | null;
    email_bounce_state: string | null;
    ws_name: string;
  }[]>`
    select t.subject, c.email, c.email_bounce_state, w.name as ws_name
    from tickets t
    left join customers c on c.id = t.customer_id
    join workspaces w on w.id = t.workspace_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
  `;
  if (!ctx || !ctx.email) return { emailed: false, reason: 'no_customer_email' };
  // Don't email addresses that hard-bounced or were marked as spam — sending
  // again hurts sender reputation. (Soft bounces are transient → allowed.)
  if (ctx.email_bounce_state === 'hard' || ctx.email_bounce_state === 'spam') {
    return { emailed: false, reason: 'email_suppressed' };
  }

  // Most recent customer message with a Message-Id → our In-Reply-To, so the
  // customer's mail client threads our reply under their original.
  const [lastMsg] = await sql<{ external_message_id: string }[]>`
    select external_message_id from ticket_messages
    where ticket_id = ${ticketId} and workspace_id = ${workspaceId} and role = 'customer'
      and deleted_at is null and external_message_id is not null
    order by created_at desc
    limit 1
  `;

  // Header/footer + the sending agent's signature (authorUserId).
  const composed = await composeEmail({ workspaceId, authorUserId, bodyText: body, bodyHtml: args.bodyHtml ?? null });

  try {
    // Branded From (verified domain) with platform fallback + rejection
    // safety net — see send-branded-email.ts.
    const result = await sendBrandedEmail({
      workspaceId,
      fallbackFromName: ctx.ws_name || 'Support',
      to: ctx.email,
      subject: replySubject(ctx.subject),
      textBody: composed.text,
      htmlBody: composed.html,
      inReplyTo: lastMsg?.external_message_id ?? null,
      // Route the customer's reply back through the inbound webhook so it
      // attaches to this ticket rather than landing in the From mailbox.
      replyTo: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
      attachments: (args.attachments ?? []).map((f) => ({
        Name: f.filename,
        Content: f.base64,
        ContentType: f.mime,
        ContentID: f.contentId,
      })),
    });
    // Stamp the RFC Message-Id (with brackets + domain) onto this reply so a
    // customer reply's In-Reply-To resolves to exactly this row.
    await sql`
      update ticket_messages set external_message_id = ${result.rfcMessageId}
      where id = ${messageId} and workspace_id = ${workspaceId}
    `;
    return { emailed: true, reason: 'sent', postmark_message_id: result.messageId };
  } catch (err) {
    const detail = err instanceof PostmarkSendError
      ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.warn(`[agent-reply] Postmark send failed for ticket ${ticketId}: ${detail}`);
    return { emailed: false, reason: 'send_failed', detail };
  }
}
