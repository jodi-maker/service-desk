// Email branding composition. Wraps an outbound message body with the
// workspace's default header + footer template and, when the email was
// authored by a specific agent, that agent's default signature. Produces a
// plain-text body (always) and an HTML body (when there's anything to brand)
// so sendEmail can send a multipart email whose logo renders in HTML clients
// and degrades to text everywhere else.
//
// The logo is reused from workspaces.logo_url — there is no separate email
// logo. A template only toggles whether to show it (show_logo).
//
// Authoring model: the settings UI captures plain text for the header / footer
// / signature, stored in the *_text columns; we derive safe HTML from it
// (escape → linkify → nl2br). The *_html columns are reserved for a future
// raw-HTML authoring mode; when present they win, but nothing writes them yet,
// so stored content is escaped and cannot inject markup into recipients' mail.

import { getDb } from './db.js';
import { escapeHtml, htmlToText } from './html-text.js';

// Re-exported: escapeHtml lives in html-text.ts (one escaping table for the
// whole codebase); callers of this module keep importing it from here.
export { escapeHtml };

export interface BrandTemplate {
  id: string;
  name: string;
  header_html: string | null;
  header_text: string | null;
  footer_html: string | null;
  footer_text: string | null;
  show_logo: boolean;
}

export interface EmailSignature {
  id: string;
  name: string;
  body_html: string | null;
  body_text: string | null;
}

export interface ComposeArgs {
  workspaceId: string;
  // When set, the author's default signature (if any) is appended above the
  // footer. Leave null for system/brand emails (CSAT, magic-link, auto-reply).
  authorUserId?: string | null;
  // The core message, plain text — exactly what the caller would have passed
  // as textBody before branding existed.
  bodyText: string;
  // Pre-sanitised HTML for the body (an agent's rich-text reply). When set it
  // is placed in the branded shell VERBATIM instead of escaping bodyText —
  // the caller is responsible for having run it through
  // sanitizeEmailHtml (lib/email-html.ts).
  bodyHtml?: string | null;
  // Optional call-to-action. The URL must also appear in bodyText — it stays
  // there verbatim for the plain-text part; in the HTML part its
  // auto-linkified anchor is swapped for a branded pill button labeled
  // `label`. When set, HTML is emitted even for a template-less workspace
  // (the only relaxation of the null-html gate) so the button still renders.
  cta?: { label: string; url: string } | null;
}

export interface ComposedEmail {
  text: string;
  // null when there's nothing to brand (no default template, no logo, no
  // signature) — the caller then sends plain text exactly as before.
  html: string | null;
}

// ─── Lookups ───────────────────────────────────────────────────────────────

export async function getDefaultBrandTemplate(workspaceId: string): Promise<BrandTemplate | null> {
  const sql = getDb();
  const [row] = await sql<BrandTemplate[]>`
    select id, name, header_html, header_text, footer_html, footer_text, show_logo
    from email_brand_templates
    where workspace_id = ${workspaceId} and is_default = true and deleted_at is null
    limit 1
  `;
  return row ?? null;
}

export async function getDefaultSignature(workspaceId: string, userId: string): Promise<EmailSignature | null> {
  const sql = getDb();
  const [row] = await sql<EmailSignature[]>`
    select id, name, body_html, body_text
    from email_signatures
    where workspace_id = ${workspaceId} and user_id = ${userId}
      and is_default = true and deleted_at is null
    limit 1
  `;
  return row ?? null;
}

// ─── Composition ─────────────────────────────────────────────────────────────

export async function composeEmail(args: ComposeArgs): Promise<ComposedEmail> {
  const { workspaceId, authorUserId, bodyText, cta } = args;
  const richHtml = args.bodyHtml?.trim() || null;
  const sql = getDb();

  const [[ws], template, signature] = await Promise.all([
    sql<{ name: string; logo_url: string | null }[]>`
      select name, logo_url from workspaces where id = ${workspaceId}
    `,
    getDefaultBrandTemplate(workspaceId),
    authorUserId ? getDefaultSignature(workspaceId, authorUserId) : Promise.resolve(null),
  ]);

  // No workspace row (deleted mid-send, bad id) → nothing to brand; fall back
  // to the plain-text path exactly as an unconfigured workspace would.
  if (!ws) return { text: bodyText, html: richHtml };

  const logoUrl = template?.show_logo ? (ws.logo_url ?? null) : null;
  const headerText = template?.header_text?.trim() || null;
  const footerText = template?.footer_text?.trim() || null;
  const sigText    = signature?.body_text?.trim() || null;

  // Nothing to add → keep the plain-text path identical to pre-branding sends.
  // A CTA is the one exception: the button only exists in HTML, so a
  // template-less workspace still gets the branded shell when one is set.
  // A rich-text reply is the second exception: its HTML must go out even when
  // there is nothing to brand around it.
  if (!cta && !richHtml && !logoUrl && !headerText && !footerText && !sigText
      && !template?.header_html && !template?.footer_html && !signature?.body_html) {
    return { text: bodyText, html: null };
  }

  // ── Plain-text assembly ──
  const textParts: string[] = [];
  if (headerText || (template?.header_html && !headerText)) {
    const ht = headerText ?? htmlToText(template!.header_html!);
    if (ht) textParts.push(ht);
  }
  textParts.push(bodyText);
  if (sigText || (signature?.body_html && !sigText)) {
    const st = sigText ?? htmlToText(signature!.body_html!);
    if (st) textParts.push(st);
  }
  if (footerText || (template?.footer_html && !footerText)) {
    const ft = footerText ?? htmlToText(template!.footer_html!);
    if (ft) textParts.push(ft);
  }
  const text = textParts.join('\n\n');

  // ── HTML assembly ──
  // Ditto design system (DESIGN.md), constrained to email-client reality:
  // solid dividers (#e7e5ec) instead of rgba (Outlook mangles alpha), Georgia
  // as the serif stand-in for Hedvig (no webfonts in email), and the yellow
  // CTA as an inline-styled pill anchor (Outlook renders it square — accepted).
  const headerHtml = template?.header_html?.trim() || (headerText ? textToHtml(headerText) : '');
  const footerHtml = template?.footer_html?.trim() || (footerText ? textToHtml(footerText, '#5f5c6e') : '');
  const sigHtml    = signature?.body_html?.trim()  || (sigText ? textToHtml(sigText) : '');
  // An agent's rich reply is already HTML (and already sanitised) — escaping it
  // again would show the customer their own markup as text.
  let bodyHtml     = richHtml ?? textToHtml(bodyText);

  if (cta) {
    const ctaButton =
      `<a href="${escapeAttr(cta.url)}" style="display:inline-block;background:#ffe228;color:#130e30;border-radius:999px;padding:13px 30px;font-weight:600;text-decoration:none">${escapeHtml(cta.label)}</a>`;
    // Swap the auto-linkified anchor for this exact URL with the pill button,
    // so the HTML shows one styled CTA where the caller placed the link.
    // Built by the same linkAnchor() textToHtml uses, so the two can't drift.
    const linkedAnchor = linkAnchor(escapeHtml(cta.url), BODY_LINK_COLOR);
    // Replacer FUNCTION, not string: replacement strings $-expand ($&, $'…),
    // and URLs may legally contain $ — a string here mangles the button href.
    bodyHtml = bodyHtml.includes(linkedAnchor)
      ? bodyHtml.replace(linkedAnchor, () => ctaButton)
      // Defensive: URL missing from bodyText (caller contract breach) — still
      // render the button after the body rather than dropping the CTA.
      : `${bodyHtml}<br><br>${ctaButton}`;
  }

  const logoBlock = logoUrl
    ? `<img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(ws?.name ?? '')}" style="max-height:48px;max-width:220px;height:auto;border:0;display:block" />`
    : '';

  // Header band: meadow surface with the brand header set in the serif at
  // 22px — the email counterpart of the app's serif page headings.
  const headerBlock = (logoBlock || headerHtml)
    ? `<tr><td style="padding:24px 32px;background:#eff2e5">${logoBlock}${headerHtml ? `<div style="margin-top:${logoBlock ? '12px' : '0'};font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:#130e30">${headerHtml}</div>` : ''}</td></tr>`
    : '';

  const sigBlock = sigHtml
    ? `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e7e5ec;color:#413d54">${sigHtml}</div>`
    : '';

  const footerBlock = footerHtml
    ? `<tr><td style="padding:16px 32px 24px;border-top:1px solid #e7e5ec;color:#5f5c6e;font-size:12px;line-height:1.5">${footerHtml}</td></tr>`
    : '';

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fbf2;-webkit-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fbf2;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:24px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
        ${headerBlock}
        <tr><td style="padding:${headerBlock ? '24px' : '32px'} 32px 24px;color:#130e30;font-size:15px;line-height:1.6">${bodyHtml}${sigBlock}</td></tr>
        ${footerBlock}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { text, html };
}

// ─── Text/HTML helpers ───────────────────────────────────────────────────────

// Attribute-context escape (logo URL, alt text) — quotes must die.
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// The two link colors the shell uses — body links are ink (Ditto), footer
// links take the footer's muted grey. A closed union rather than an open
// string: linkColor is interpolated into a style attribute, so arbitrary
// values have no business here.
const BODY_LINK_COLOR = '#130e30';
const FOOTER_LINK_COLOR = '#5f5c6e';
type LinkColor = typeof BODY_LINK_COLOR | typeof FOOTER_LINK_COLOR;

// Single source of truth for the anchor markup textToHtml emits — the CTA
// swap in composeEmail rebuilds the anchor with this same function, so the
// match can never drift from the linkified output. `escapedHref` must
// already be HTML-escaped (it doubles as the visible text).
function linkAnchor(escapedHref: string, linkColor: LinkColor): string {
  return `<a href="${escapedHref}" style="color:${linkColor};text-decoration:underline">${escapedHref}</a>`;
}

// Turn admin/agent-authored plain text into safe HTML: escape everything,
// linkify bare http(s) URLs (so "click this link" emails work in HTML), then
// convert newlines to <br>. Operating on already-escaped text means the
// injected <a> tags are the only markup that survives. Links are ink by
// default (Ditto); the footer passes its muted grey so links match its text.
export function textToHtml(text: string, linkColor: LinkColor = BODY_LINK_COLOR): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    // Trailing punctuation shouldn't be swallowed into the href.
    const m = url.match(/^(.*?)([.,;:!?)]*)$/);
    const href = m ? m[1] : url;
    const tail = m ? m[2] : '';
    return `${linkAnchor(href, linkColor)}${tail}`;
  });
  return linked.replace(/\r?\n/g, '<br>');
}

