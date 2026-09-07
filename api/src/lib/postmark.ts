import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from './env.js';
import { htmlToText } from './html-text.js';

// ─── Postmark inbound webhook payload ────────────────────────────────────
//
// Subset of fields we actually use. Postmark sends a much larger object
// (attachments, headers, raw email, etc.) — we accept anything via Zod's
// passthrough and only require the fields we read. See
// https://postmarkapp.com/developer/webhooks/inbound-webhook for the full
// shape if we ever need more.

export const PostmarkInbound = z
  .object({
    MessageID: z.string(),                        // Postmark's unique message id
    Date: z.string().optional(),                  // RFC 2822 timestamp string
    From: z.string().email().or(z.string()),      // "Name <addr@example.com>" or bare addr
    FromName: z.string().optional(),
    FromFull: z
      .object({
        Email: z.string(),
        Name: z.string().optional(),
      })
      .optional(),
    Subject: z.string().default(''),
    TextBody: z.string().default(''),             // plain-text body (preferred)
    HtmlBody: z.string().default(''),             // HTML fallback if TextBody is empty
    StrippedTextReply: z.string().optional(),     // text with quoted history stripped
    ToFull: z
      .array(z.object({ Email: z.string() }))
      .optional(),                                // the address it was sent to (our inbound addr)
    Headers: z
      .array(z.object({ Name: z.string(), Value: z.string() }))
      .optional(),                                // full RFC headers; we read Message-ID for threading
    Attachments: z
      .array(
        z.object({
          Name: z.string().default('file'),
          Content: z.string().default(''),        // base64
          ContentType: z.string().default('application/octet-stream'),
          ContentLength: z.number().optional(),
          ContentID: z.string().optional(),       // '' unless referenced as cid: from the HTML
        }).passthrough(),
      )
      .optional(),                                // stored via lib/message-attachments.ts
  })
  .passthrough();

export type PostmarkInbound = z.infer<typeof PostmarkInbound>;

// ─── Authentication ──────────────────────────────────────────────────────
//
// The shared secret arrives in the Authorization header only — the secret
// never rides in the URL (the old ?secret= query fallback was removed once the
// Postmark webhooks were cut over to HTTP Basic Auth):
//   1. Authorization: Bearer <secret>
//   2. Authorization: Basic base64(user:<secret>)   ← Postmark HTTP Basic Auth
//      (configured as https://postmark:<secret>@<host>/... ; the password slot
//      holds the secret)
//
// Compared in constant time. Postmark inbound carries no HMAC/timestamp
// signature, so body-signature verification and replay protection are not
// available — the secret is the credential. (Documented residual.)

function safeEqual(a: string, expected: string): boolean {
  // Compare fixed-length SHA-256 digests rather than the raw strings: the
  // digests are always 32 bytes, so there's no length pre-check to short-circuit
  // on — this avoids leaking even the secret's length via timing (and dodges
  // timingSafeEqual's unequal-length throw). A SHA-256 collision is infeasible,
  // so equal digests ⇒ equal inputs.
  const ad = createHash('sha256').update(a).digest();
  const ed = createHash('sha256').update(expected).digest();
  return timingSafeEqual(ad, ed);
}

// The secret as presented in the Authorization header (Bearer token, or the
// password slot of Basic auth). Returns null when no usable credential is
// present. The URL ?secret= query is intentionally NOT accepted.
function presentedSecret(c: Context): string | null {
  const auth = c.req.header('authorization');
  if (!auth) return null;
  const sp = auth.indexOf(' ');
  const scheme = (sp === -1 ? auth : auth.slice(0, sp)).toLowerCase();
  const value = sp === -1 ? '' : auth.slice(sp + 1).trim();
  if (!value) return null;
  if (scheme === 'bearer') return value;
  if (scheme === 'basic') {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      return colon === -1 ? decoded : decoded.slice(colon + 1); // password slot
    } catch {
      return null; // malformed base64
    }
  }
  return null;
}

export function assertPostmarkAuth(c: Context): void {
  const presented = presentedSecret(c);
  if (presented && safeEqual(presented, env.POSTMARK_INBOUND_SECRET)) return;
  throw new HTTPException(401, { message: 'Bad or missing webhook credentials' });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Pull a clean (email, name) tuple out of Postmark's variable From shapes.
 * Prefers FromFull (structured) over FromName + From (string parsing).
 */
export function parseFrom(payload: PostmarkInbound): { email: string; name: string | null } {
  if (payload.FromFull?.Email) {
    return { email: payload.FromFull.Email.toLowerCase(), name: payload.FromFull.Name ?? null };
  }
  // From is often "Name <addr@example.com>" — pull out the bracketed part.
  const match = payload.From.match(/<([^>]+)>/);
  if (match) {
    const name = payload.From.slice(0, match.index).trim().replace(/^"|"$/g, '') || null;
    return { email: match[1].toLowerCase(), name: payload.FromName ?? name };
  }
  return { email: payload.From.trim().toLowerCase(), name: payload.FromName ?? null };
}

/**
 * Pull the recipient email + domain out of Postmark's ToFull array. Used
 * by inbound webhook routing to map mail to the right workspace.
 *
 * Postmark's ToFull is always present and ordered; for multi-recipient mail
 * we route by the first entry only. A real customer mailing two of our
 * brands' support addresses at once is rare enough that "first wins" is
 * acceptable for v1; the second brand can manually re-create the ticket if
 * needed. Returns null if ToFull is missing/empty (defensive — shouldn't
 * happen with a real Postmark payload).
 */
export function parseTo(payload: PostmarkInbound): { email: string; domain: string } | null {
  const to = payload.ToFull?.[0]?.Email;
  if (!to) return null;
  const email = to.toLowerCase();
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const domain = email.slice(at + 1);
  if (!domain) return null;
  return { email, domain };
}

/**
 * Best body for the ticket message: stripped reply if present (Postmark
 * removes quoted history), else TextBody, else the HTML body converted to
 * plain text. Mail clients such as Gmail mobile send an empty TextBody and
 * a wrapper-only HTML body (`<div dir="auto"></div>`) for a blank email —
 * the conversion turns that into '' so the placeholder applies instead of
 * the raw tag showing in the thread. Known limit: Postmark only strips
 * quoted history from the text part, so an HTML-only reply may still carry
 * the quoted thread below the new text.
 */
export function pickBody(payload: PostmarkInbound): string {
  return (
    payload.StrippedTextReply?.trim() ||
    payload.TextBody?.trim() ||
    htmlToText(payload.HtmlBody ?? '') ||
    '(empty body)'
  );
}

/**
 * Pull the RFC 5322 Message-ID header out of Postmark's headers array.
 * Used as In-Reply-To when we send our reply back so the customer's mail
 * client threads it under the original. Returns null if the header is
 * missing (some senders omit it; we just lose threading for that message).
 */
export function extractMessageId(payload: PostmarkInbound): string | null {
  const h = payload.Headers?.find((h) => h.Name.toLowerCase() === 'message-id');
  return h?.Value?.trim() || null;
}

/**
 * Pull the RFC 5322 In-Reply-To header out. When present, this is the
 * Message-Id of the message being replied to — we use it to attach the
 * inbound to an existing ticket instead of creating a new one. If the
 * header contains multiple IDs (rare), only the first is returned;
 * thread-matching by the first reference is the standard behaviour.
 */
export function extractInReplyTo(payload: PostmarkInbound): string | null {
  const h = payload.Headers?.find((h) => h.Name.toLowerCase() === 'in-reply-to');
  const raw = h?.Value?.trim();
  if (!raw) return null;
  const firstId = raw.match(/<[^>]+>/);
  return firstId ? firstId[0] : raw;
}
