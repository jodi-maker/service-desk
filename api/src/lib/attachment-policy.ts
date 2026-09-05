// What files we accept as ticket attachments, and how they are stored/served.
//
// Shared by inbound email (Postmark `Attachments`) and agent uploads so the
// two paths can never drift. The rules:
//   • a deny-list of executable / script / markup extensions (Postmark's own
//     outbound block list plus the web-renderable formats a browser could
//     execute: html, svg, xml, js, …);
//   • raster images are trusted ONLY by magic bytes (lib/image-sniff.ts) and
//     are the only thing stored with Content-Disposition: inline — everything
//     else always downloads, whatever it claims to be;
//   • a non-image keeps its declared MIME only when it is on a small allow-list
//     of document types; anything else is served as application/octet-stream.
//
// Size caps: inbound files are skipped (with a note in the message) rather
// than refused — Postmark retries a non-2xx for hours then drops the mail.

import { sniffImageMime } from './image-sniff.js';

export const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
// Raw aggregate per outgoing reply: Postmark caps a message at 10 MB INCLUDING
// base64 overhead (≈ ×1.37), so 7 MB raw ≈ 9.6 MB on the wire.
export const MAX_REPLY_ATTACHMENT_BYTES = 7 * 1024 * 1024;
export const MAX_FILENAME_CHARS = 150;
// Files kept from ONE inbound email. Postmark's own 35 MB cap bounds the bytes;
// this bounds the fan-out (uploads + rows) a single message can cost us.
export const MAX_INBOUND_FILE_COUNT = 25;

// Postmark's blocked-attachment list (it would reject these on send) + formats
// a browser or shell could execute if ever opened from a download.
export const DENY_EXT = new Set([
  'vbs', 'exe', 'bin', 'bat', 'chm', 'com', 'cpl', 'crt', 'hlp', 'hta', 'inf', 'ins', 'isp', 'jse', 'lnk',
  'mdb', 'pcd', 'pif', 'reg', 'scr', 'sct', 'shs', 'vbe', 'vba', 'wsf', 'wsh', 'wsl', 'msc', 'msi', 'msp', 'mst',
  'html', 'htm', 'xhtml', 'xht', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs', 'jar', 'ps1', 'psm1',
  'sh', 'bash', 'cmd', 'dll', 'apk', 'app', 'deb', 'rpm', 'dmg', 'iso', 'url', 'desktop', 'mht', 'mhtml', 'swf',
]);

// Declared MIME types we pass through for non-image files. Everything else is
// served as application/octet-stream (still downloadable, just not "typed").
const ALLOWED_DOC_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-7z-compressed',
  'application/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'text/calendar',
  'message/rfc822',
]);

export type Disposition = 'inline' | 'attachment';

export type Classified =
  | { ok: true; mime: string; disposition: Disposition; size: number }
  | { ok: false; reason: 'blocked type' | 'too large' | 'empty' };

// Strip any path, control characters and runs of whitespace from an untrusted
// filename; keep it short; never return ''. The result is used in the storage
// key, the Content-Disposition header and the UI.
export function sanitizeFilename(name: string | null | undefined): string {
  const base = (name ?? '')
    .split(/[\\/]/).pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const chars = Array.from(base);
  if (chars.length <= MAX_FILENAME_CHARS) return base || 'file';
  // Truncating a long name must NOT drop its extension: the deny-list keys on
  // the extension, so `<200 chars>.exe` shortened to `<150 chars>` would sail
  // straight through as an unknown type. Keep the extension, shorten the stem.
  const ext = fileExtension(base);
  const suffix = ext ? `.${ext}` : '';
  const stem = chars.slice(0, Math.max(1, MAX_FILENAME_CHARS - Array.from(suffix).length)).join('');
  return (stem + suffix) || 'file';
}

export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * Decide whether to keep a file and how to store it. `filename` must already
 * have been through sanitizeFilename() — callers need the clean name anyway
 * (storage key, Content-Disposition, UI), so it is sanitised exactly once per
 * file. `bytes` is authoritative for size and (for images) type; `declaredMime`
 * is only consulted for the document allow-list.
 */
export function classifyAttachment(
  filename: string,
  declaredMime: string | null | undefined,
  bytes: Uint8Array,
  maxBytes: number,
): Classified {
  if (DENY_EXT.has(fileExtension(filename))) return { ok: false, reason: 'blocked type' };
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > maxBytes) return { ok: false, reason: 'too large' };

  const sniffed = sniffImageMime(bytes);
  if (sniffed) return { ok: true, mime: sniffed, disposition: 'inline', size: bytes.length };

  const declared = (declaredMime ?? '').split(';')[0].trim().toLowerCase();
  // A file that CLAIMS to be an image but isn't one we can verify is not
  // served as an image — it stays a plain download.
  const mime = ALLOWED_DOC_MIMES.has(declared) ? declared : 'application/octet-stream';
  return { ok: true, mime, disposition: 'attachment', size: bytes.length };
}

// `filename` is expected pre-sanitised (see classifyAttachment).
export function formatSkipNote(filename: string, reason: string, size?: number): string {
  const s = size != null ? ` (${(size / (1024 * 1024)).toFixed(1)} MB)` : '';
  return `[Attachment not stored: ${filename}${s} — ${reason}]`;
}
