import { env } from './env.js';

// ─── Postmark Email API ──────────────────────────────────────────────────
//
// POST https://api.postmarkapp.com/email
//   X-Postmark-Server-Token: <token>
//   Body: { From, To, Subject, TextBody, MessageStream, Headers? }
//
// Returns 200 with { MessageID, SubmittedAt, To, ErrorCode, Message }.
// ErrorCode 0 = success. Non-zero codes (e.g. 405 SignatureNotConfirmed,
// 406 InactiveRecipient) come back as 200 with the failure encoded in the
// JSON body — non-2xx HTTP is reserved for malformed requests / auth.
// See https://postmarkapp.com/developer/api/email-api for the full list.

const ENDPOINT = 'https://api.postmarkapp.com/email';
const STREAM = 'outbound';   // default transactional stream

export interface SendEmailArgs {
  to: string;
  subject: string;
  textBody: string;
  // Optional HTML body. When present, Postmark sends a multipart email with
  // both parts and the recipient's client picks HTML; textBody remains the
  // fallback for plain-text clients. Used to render brand header/footer logos.
  htmlBody?: string | null;
  fromEmail: string;
  fromName: string;
  // RFC Message-ID of the email we're replying to. When present, sent as
  // In-Reply-To + References headers so the customer's mail client threads
  // our reply under the original.
  inReplyTo?: string | null;
  // Address to set as Reply-To. Used to route customer replies back through
  // the Postmark inbound webhook instead of straight to the From mailbox.
  replyTo?: string | null;
  // Extra RFC headers to append (e.g. List-Unsubscribe / List-Unsubscribe-Post).
  // Reserved headers (Reply-To) must use the dedicated field, not this.
  extraHeaders?: Array<{ Name: string; Value: string }>;
  // Files to attach. A `ContentID` of 'cid:<token>' makes Postmark send the
  // part as an INLINE image that HtmlBody references with the same token; omit
  // it for a regular attachment. Postmark caps a message at 10 MB INCLUDING
  // base64 overhead — the caller enforces that before we get here.
  attachments?: Array<{ Name: string; Content: string; ContentType: string; ContentID?: string | null }>;
}

export interface SendEmailResult {
  messageId: string;     // Postmark's MessageID (UUID) for the sent email
  rfcMessageId: string;  // Full RFC Message-Id header value we set (with brackets)
  submittedAt: string;
}

export class PostmarkSendError extends Error {
  constructor(
    message: string,
    public code: number,
    public httpStatus: number,
  ) {
    super(message);
  }
}

export class PostmarkNotConfiguredError extends Error {
  constructor() {
    super('Postmark outbound is not configured (missing POSTMARK_SERVER_TOKEN or POSTMARK_OUTBOUND_FROM)');
  }
}

export function isPostmarkConfigured(): boolean {
  return Boolean(env.POSTMARK_SERVER_TOKEN && env.POSTMARK_OUTBOUND_FROM);
}

/**
 * Send an email via Postmark — plain text always, plus an optional HTML body
 * (htmlBody) for a richer rendering with the text part as fallback. Throws
 * PostmarkNotConfiguredError if env vars are unset, PostmarkSendError if
 * Postmark refuses the send.
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  if (!isPostmarkConfigured()) {
    throw new PostmarkNotConfiguredError();
  }

  // We set our OWN RFC Message-Id header so the value matches what we
  // persist on the ticket_messages row. Without this, Postmark generates
  // a `<UUID@mtasv.net>` and we'd have to know/match Postmark's suffix
  // to identify replies. Domain comes from the From address — replies
  // referencing this ID via In-Reply-To resolve cleanly in our DB.
  const rfcMessageId = generateRfcMessageId(args.fromEmail);

  const headers: Array<{ Name: string; Value: string }> = [
    { Name: 'Message-Id', Value: rfcMessageId },
  ];
  if (args.inReplyTo) {
    // RFC 5322 Message-IDs are angle-bracket-wrapped on the wire. Some
    // inbound providers strip the brackets; re-add them defensively so
    // threading works regardless of how the original was stored.
    const msgId = args.inReplyTo.startsWith('<') ? args.inReplyTo : `<${args.inReplyTo}>`;
    headers.push({ Name: 'In-Reply-To', Value: msgId });
    headers.push({ Name: 'References', Value: msgId });
  }
  if (args.extraHeaders) {
    for (const h of args.extraHeaders) headers.push(h);
  }
  // Reply-To is a reserved header in Postmark's Email API: passing it inside
  // the Headers array is rejected with HTTP 422 "Header 'Reply-To' not
  // allowed". It must go in the dedicated top-level `ReplyTo` field instead.
  const body: {
    From: string;
    To: string;
    Subject: string;
    TextBody: string;
    HtmlBody?: string;
    MessageStream: string;
    Headers: Array<{ Name: string; Value: string }>;
    ReplyTo?: string;
    Attachments?: Array<{ Name: string; Content: string; ContentType: string; ContentID?: string }>;
  } = {
    From: formatFrom(args.fromName, args.fromEmail),
    To: args.to,
    Subject: args.subject,
    TextBody: args.textBody,
    MessageStream: STREAM,
    Headers: headers,
  };
  if (args.htmlBody) {
    body.HtmlBody = args.htmlBody;
  }
  if (args.replyTo) {
    body.ReplyTo = args.replyTo;
  }
  if (args.attachments?.length) {
    body.Attachments = args.attachments.map((a) => ({
      Name: a.Name,
      Content: a.Content,
      ContentType: a.ContentType,
      ...(a.ContentID ? { ContentID: a.ContentID } : {}),
    }));
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Non-2xx → auth / malformed / server error. Body is still JSON with a
  // human-readable Message.
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({ Message: res.statusText }))) as {
      Message?: string;
      ErrorCode?: number;
    };
    throw new PostmarkSendError(
      `Postmark refused send (HTTP ${res.status}): ${errBody.Message ?? 'unknown'}`,
      errBody.ErrorCode ?? -1,
      res.status,
    );
  }

  const data = (await res.json()) as {
    MessageID: string;
    SubmittedAt: string;
    To: string;
    ErrorCode: number;
    Message: string;
  };

  // Postmark returns 200 even for some logical failures (e.g. inactive
  // recipient, unconfirmed sender signature). ErrorCode 0 is the success
  // marker.
  if (data.ErrorCode !== 0) {
    throw new PostmarkSendError(
      `Postmark send failed: ${data.Message}`,
      data.ErrorCode,
      res.status,
    );
  }

  return {
    messageId: data.MessageID,
    rfcMessageId,
    submittedAt: data.SubmittedAt,
  };
}

/**
 * Generate an RFC 5322 Message-Id header value: `<{uuid}@{domain}>`. Domain
 * is extracted from the outbound From address so the Message-Id looks like
 * it originates from our sending domain (good for SPF/DKIM consistency).
 */
function generateRfcMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || 'maestro.local';
  return `<${crypto.randomUUID()}@${domain}>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build an RFC 5322 From header value: `"Name" <email>` if name present,
 * else just `email`. Quote-escape any double-quotes in the name.
 */
function formatFrom(name: string, email: string): string {
  const trimmed = name.trim();
  if (!trimmed) return email;
  const escaped = trimmed.replace(/"/g, '\\"');
  return `"${escaped}" <${email}>`;
}

/**
 * Prefix a subject with "Re: " if it isn't already a reply. Match standard
 * "re:", "re :", "RE:", "Re[2]:" etc. case-insensitively at the start.
 */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re\s*(\[\d+\])?\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}
