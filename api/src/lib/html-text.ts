// Best-effort HTML → plain text.
//
// Two callers, both "make this readable, never render it":
//   - inbound email (lib/postmark.ts pickBody): mail clients such as Gmail
//     mobile send an empty TextBody and an HTML body that is often just a
//     wrapper (`<div dir="auto"></div>`). Real Outlook mail carries a
//     <head><style> block whose CSS must not leak into the ticket body.
//   - outbound branding (lib/email-branding.ts): text fallback for the small
//     header/footer/signature HTML snippets an admin authored.
//
// Deliberately regex-based and never interprets the markup — the input is
// untrusted, and the output is always escaped again by whoever displays it.
// This runs synchronously inside the Postmark webhook, so every pass must stay
// linear: tag patterns use `[^<>]` (never `[^>]`), nothing matches from an
// opener to a closer in one pattern, and the input is capped.
// Returns '' for wrapper-only input so callers can apply their own placeholder.

// Postmark accepts inbound messages up to 35 MB; no legitimate ticket body
// is anywhere near this. Anything longer is truncated before conversion.
export const MAX_HTML_CHARS = 1_000_000;

// HTML 4 Latin-1 names, in code-point order from U+00A0 to U+00FF.
const LATIN1_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', bull: '•',
};
LATIN1_NAMES.split(' ').forEach((name, i) => { NAMED_ENTITIES[name] = String.fromCodePoint(0xa0 + i); });

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ent: string) => {
    if (ent[0] === '#') {
      const hex = ent[1]?.toLowerCase() === 'x';
      const cp = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // Reject anything fromCodePoint would throw on (or that is a lone
      // surrogate) — keep the literal text rather than crash the webhook.
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
      return String.fromCodePoint(cp);
    }
    // Entity names are case-sensitive (&Eacute; ≠ &eacute;); fall back to the
    // lower-case form for sloppy upper-cased ampersand entities like &AMP;.
    if (Object.hasOwn(NAMED_ENTITIES, ent)) return NAMED_ENTITIES[ent];
    const lower = ent.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : match;
  });
}

const BLOCK_OPENERS = 'div|p|h[1-6]|blockquote|pre|table|ul|ol|tr|li';

// Private markers for the two-pass link handling (see below): U+0001..U+0003,
// never legitimate in mail text; any that arrive in the input are stripped
// first. Built with fromCharCode so the source holds no control bytes.
const LINK_OPEN = String.fromCharCode(1);
const LINK_HREF_END = String.fromCharCode(2);
const LINK_CLOSE = String.fromCharCode(3);
const NOT_MARKER = `[^${LINK_OPEN}-${LINK_CLOSE}]*`;
const MARKERS_RE = new RegExp(`[${LINK_OPEN}-${LINK_CLOSE}]`, 'g');
const LINK_RE = new RegExp(`${LINK_OPEN}(${NOT_MARKER})${LINK_HREF_END}(${NOT_MARKER})${LINK_CLOSE}`, 'g');
const UNCLOSED_LINK_RE = new RegExp(`${LINK_OPEN}(${NOT_MARKER})${LINK_HREF_END}`, 'g');
// U+00A0 (from &nbsp;, &#160; or raw) — built without an escape so an editor
// cannot silently normalise it to an ordinary space.
const NBSP_RE = new RegExp(String.fromCharCode(0xa0), 'g');

export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  s = s.replace(/\r\n?/g, '\n');

  // Plain text (no tags) keeps the author's own line breaks; only markup
  // goes through the structural pass below.
  if (/<[a-z!/]/i.test(s)) {
    // Non-content blocks go away WITH their contents. An unclosed block (broken
    // or truncated mail) is dropped to the end rather than leaking CSS/JS text.
    s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    s = s.replace(/<(head|style|script|title)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

    // Source formatting (Outlook/Word wrap at ~72 cols) is not content —
    // line breaks come from <br> and block tags only.
    s = s.replace(/\s+/g, ' ');

    // Links: keep the destination, which the tag strip would otherwise lose.
    // Two linear passes with private markers instead of one opener→closer
    // regex — matching `<a …>…</a>` in a single pattern rescans to the end of
    // the body for every unclosed opener (quadratic; minutes on a 500 KB
    // hostile mail). Pass 1 swaps each http(s) opener for OPEN href HREF_END
    // and each </a> for CLOSE; pass 2 (after the tag strip) rebuilds
    // `label (href)`.
    s = s.replace(MARKERS_RE, '');
    s = s.replace(
      /<a\b[^<>]*?\bhref\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')[^<>]*>/gi,
      (whole, dq: string | undefined, sq: string | undefined) => {
        const href = (dq ?? sq ?? '').trim();
        return /^https?:\/\//i.test(href) ? `${LINK_OPEN}${href}${LINK_HREF_END}` : whole;
      },
    );
    s = s.replace(/<\/a\s*>/gi, LINK_CLOSE);

    // Block boundaries → line breaks. Text directly followed by an opening
    // block (Gmail web: `<div>First<div>Second</div></div>`) breaks before it;
    // Gmail wraps each line in a <div>, so a closing div is one newline and
    // paragraph-level closers get a blank line.
    s = s.replace(new RegExp(`([^\\s>])[ \\t]*<(${BLOCK_OPENERS})\\b`, 'gi'), '$1\n<$2');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, '\n\n');
    s = s.replace(/<\/(div|tr|li)\s*>/gi, '\n');
    s = s.replace(/<\/t[dh]\s*>/gi, ' ');

    // Everything else is markup we don't want.
    s = s.replace(/<[^<>]+>/g, '');

    // Pass 2 of the link handling: `label (href)` unless the label already IS
    // the URL; an empty label shows the URL; an unclosed anchor keeps its URL.
    s = s.replace(LINK_RE, (_m, href: string, inner: string) => {
      const label = inner.trim();
      if (!label) return href;
      const same = (a: string) => a.replace(/\/+$/, '').toLowerCase();
      return same(label) === same(href) ? inner : `${inner} (${href})`;
    });
    s = s.replace(UNCLOSED_LINK_RE, '$1 ').replace(MARKERS_RE, '');
  }

  // Numeric &#160;, &nbsp; and raw non-breaking spaces become ordinary spaces.
  s = decodeEntities(s).replace(NBSP_RE, ' ');

  // Whitespace: tidy each line, cap blank-line runs at one.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}

// Escape text for interpolation into HTML (also safe in a double- or
// single-quoted attribute). Lives here rather than in email-branding.ts so the
// pure text/HTML helpers have one home and one escaping table — email-branding
// re-exports it for its existing callers.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
