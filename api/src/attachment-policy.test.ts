// Attachment acceptance policy (lib/attachment-policy.ts). Pure.

import { describe, expect, it } from 'bun:test';
import { classifyAttachment, fileExtension, formatSkipNote, sanitizeFilename } from './lib/attachment-policy.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const GIF = new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([0, 0]));
const TEXT = new Uint8Array([...'%PDF-1.7 hello'].map((c) => c.charCodeAt(0)));
const HTML = new Uint8Array([...'<!doctype html><script>1</script>'].map((c) => c.charCodeAt(0)));
const MAX = 1024 * 1024;

describe('sanitizeFilename', () => {
  it('strips paths, control chars and reserved characters', () => {
    expect(sanitizeFilename('..\\..\\etc\\passwd')).toBe('passwd');
    expect(sanitizeFilename('/tmp/x/report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('a\x00b\r\nc:d*e?.txt')).toBe('a b c_d_e_.txt');
  });
  it('never returns empty, trims leading dots, caps length by code point', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
    expect(sanitizeFilename('...hidden')).toBe('hidden');
    expect(Array.from(sanitizeFilename('😀'.repeat(400) + '.png')).length).toBe(150);
  });

  it('KEEPS the extension when truncating — the deny-list keys on it', () => {
    const long = 'a'.repeat(400) + '.exe';
    const safe = sanitizeFilename(long);
    expect(safe.endsWith('.exe')).toBe(true);
    expect(Array.from(safe).length).toBe(150);
    // …so an over-long executable name is still rejected rather than sailing
    // through as an extension-less unknown.
    expect(classifyAttachment(safe, 'application/octet-stream', TEXT, MAX)).toEqual({ ok: false, reason: 'blocked type' });
    expect(sanitizeFilename('😀'.repeat(400) + '.svg').endsWith('.svg')).toBe(true);
  });
});

describe('fileExtension', () => {
  it('lower-cases and tolerates missing extensions', () => {
    expect(fileExtension('A.PDF')).toBe('pdf');
    expect(fileExtension('noext')).toBe('');
    expect(fileExtension('trailing.dot.')).toBe('');
  });
});

describe('classifyAttachment', () => {
  it('trusts raster images by magic bytes → inline, ignoring the declared type', () => {
    expect(classifyAttachment('x.dat', 'application/octet-stream', PNG, MAX)).toEqual({ ok: true, mime: 'image/png', disposition: 'inline', size: PNG.length });
    expect(classifyAttachment('anim.gif', 'image/gif', GIF, MAX)).toMatchObject({ ok: true, mime: 'image/gif', disposition: 'inline' });
  });
  it('rejects blocked extensions regardless of content', () => {
    for (const name of ['run.exe', 'page.html', 'icon.svg', 'x.js', 'setup.msi', 'a.HTM', 'script.ps1', 'x.mhtml']) {
      expect(classifyAttachment(name, 'application/octet-stream', TEXT, MAX)).toEqual({ ok: false, reason: 'blocked type' });
    }
  });
  it('rejects empty and oversize files', () => {
    expect(classifyAttachment('a.pdf', 'application/pdf', new Uint8Array(0), MAX)).toEqual({ ok: false, reason: 'empty' });
    expect(classifyAttachment('a.pdf', 'application/pdf', new Uint8Array(MAX + 1), MAX)).toEqual({ ok: false, reason: 'too large' });
  });
  it('keeps allow-listed document types as downloads', () => {
    expect(classifyAttachment('a.pdf', 'application/pdf; charset=binary', TEXT, MAX)).toMatchObject({ ok: true, mime: 'application/pdf', disposition: 'attachment' });
    expect(classifyAttachment('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', TEXT, MAX)).toMatchObject({ ok: true, disposition: 'attachment' });
  });
  it('downgrades unknown or lying declared types to octet-stream downloads', () => {
    // Declared image but not a raster we can verify → never served as an image.
    expect(classifyAttachment('a.bmp', 'image/bmp', TEXT, MAX)).toMatchObject({ ok: true, mime: 'application/octet-stream', disposition: 'attachment' });
    // HTML bytes with a harmless name/type still can't be rendered by anyone.
    expect(classifyAttachment('notes.txt', 'text/html', HTML, MAX)).toMatchObject({ ok: true, mime: 'application/octet-stream', disposition: 'attachment' });
    expect(classifyAttachment('thing.xyz', 'application/x-whatever', TEXT, MAX)).toMatchObject({ ok: true, mime: 'application/octet-stream', disposition: 'attachment' });
  });
});

describe('formatSkipNote', () => {
  it('names the file, the reason and (when given) the size', () => {
    expect(formatSkipNote('big.mov', 'too large', 31 * 1024 * 1024)).toBe('[Attachment not stored: big.mov (31.0 MB) — too large]');
    expect(formatSkipNote('evil.exe', 'blocked type')).toBe('[Attachment not stored: evil.exe — blocked type]');
  });
});
