// Unit tests for the logo-upload magic-byte sniffer (lib/image-sniff.ts).
// Pure — no DB, no R2. This is the security-relevant logic for advisory #6/#7:
// only real PNG/JPEG/WebP bytes are accepted; SVG/HTML/anything else → null.

import { describe, expect, it } from 'bun:test';
import { sniffImageMime } from './lib/image-sniff.js';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new Uint8Array([...s].map((ch) => ch.charCodeAt(0)));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
// "RIFF" + 4-byte size + "WEBP" + data
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const RIFF_NOT_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]); // "WAVE"

describe('sniffImageMime', () => {
  it('detects PNG by signature', () => expect(sniffImageMime(PNG)).toBe('image/png'));
  it('detects JPEG by signature', () => expect(sniffImageMime(JPEG)).toBe('image/jpeg'));
  it('detects WebP (RIFF + WEBP)', () => expect(sniffImageMime(WEBP)).toBe('image/webp'));
  it('detects GIF87a / GIF89a and rejects a GIF-like prefix', () => {
    expect(sniffImageMime(ascii('GIF89a\x01\x00'))).toBe('image/gif');
    expect(sniffImageMime(ascii('GIF87a\x01\x00'))).toBe('image/gif');
    expect(sniffImageMime(ascii('GIF88a\x01\x00'))).toBeNull();
    expect(sniffImageMime(ascii('GIF89'))).toBeNull();
  });

  it('rejects an SVG document', () => expect(sniffImageMime(ascii('<?xml version="1.0"?><svg xmlns="..."><script>alert(1)</script></svg>'))).toBeNull());
  it('rejects a bare <svg> body', () => expect(sniffImageMime(ascii('<svg onload="alert(1)"></svg>'))).toBeNull());
  it('rejects HTML', () => expect(sniffImageMime(ascii('<!doctype html><script>alert(1)</script>'))).toBeNull());
  it('rejects an empty buffer', () => expect(sniffImageMime(new Uint8Array(0))).toBeNull());
  it('rejects a too-short buffer', () => expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull());
  it('rejects a RIFF container that is not WEBP (e.g. WAVE)', () => expect(sniffImageMime(RIFF_NOT_WEBP)).toBeNull());

  it('detects real PNG bytes regardless of any (would-be) declared type', () => {
    // The whole point of #6: a file a client might label image/svg+xml but whose
    // bytes are PNG is still correctly identified by content.
    expect(sniffImageMime(PNG)).toBe('image/png');
  });
});
