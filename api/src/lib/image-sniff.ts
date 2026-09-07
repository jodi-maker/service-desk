// Magic-byte image type detection for the logo upload. We validate the actual
// bytes rather than trusting the client-declared MIME (which can lie) and we
// only recognise the raster formats we allow — SVG/HTML and anything else
// return null and are rejected by the caller. This is the source-level defence
// against content-type confusion + SVG stored-XSS (advisory #6/#7).
//
// Hand-rolled (no `file-type` dependency) — three fixed signatures is trivial
// and avoids pulling in an ESM-only package.

export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

export function sniffImageMime(bytes: Uint8Array): SniffedImageMime | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // WebP: "RIFF" <4-byte size> "WEBP" — require BOTH markers so a bare RIFF
  // container (e.g. WAV/AVI) isn't accepted as an image.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  // GIF: "GIF87a" / "GIF89a" (email attachments; not accepted for logos, see
  // routes/workspace.ts which keeps its own PNG/JPEG/WebP allow-list).
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  return null;
}
