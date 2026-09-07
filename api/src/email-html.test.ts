// Email HTML sanitiser (lib/email-html.ts). Pure — no DB, no network. This is
// the write-time XSS layer for rendering customer email in the agent UI, so
// the vectors here are the ones that matter: script, event handlers, dangerous
// URL schemes, foreign/embedded content, breakout via raw-text elements, and
// the cid: mapping contract.

import { describe, expect, it } from 'bun:test';
import { rewriteCidsToUrls, sanitizeEmailHtml } from './lib/email-html.js';

const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const clean = (html: string, opts?: Parameters<typeof sanitizeEmailHtml>[1]) => sanitizeEmailHtml(html, opts).html;

describe('sanitizeEmailHtml — removes executable content', () => {
  it('drops <script> with its contents', () => {
    expect(clean('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });
  it('drops on* event handlers', () => {
    const out = clean('<img src="https://x.test/a.png" onerror="alert(1)"><div onclick="x()">t</div>');
    expect(out).not.toMatch(/on\w+=/i);
    expect(out).toContain('src="https://x.test/a.png"');
  });
  it('drops javascript: and data: hrefs but keeps https/mailto/tel', () => {
    const out = clean(
      '<a href="javascript:alert(1)">j</a><a href="data:text/html,x">d</a><a href="https://ok.test">o</a><a href="mailto:a@b.c">m</a><a href="tel:+1">t</a>',
    );
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:');
    expect(out).toContain('href="https://ok.test"');
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).toContain('href="tel:+1"');
  });
  it('blocks protocol-relative URLs', () => {
    expect(clean('<a href="//evil.test/x">a</a>')).not.toContain('evil.test');
  });
  it('drops svg, iframe, object, embed, form/input/button, meta, base, link, style, title, head contents', () => {
    const out = clean(
      '<html><head><title>SECRET TITLE</title><style>body{color:red}</style><base href="https://evil/"><link rel=stylesheet href=x></head>' +
        '<body><svg onload="alert(1)"><script>1</script></svg><iframe src="https://evil"></iframe><object data="x"></object><embed src="x">' +
        '<form action="https://evil"><input name=a><button>go</button></form><meta http-equiv="refresh" content="0;url=https://evil">' +
        '<p>keep me</p></body></html>',
    );
    expect(out).toBe('<p>keep me</p>');
  });
  it('is not fooled by a </style> breakout inside a dropped block', () => {
    const out = clean('<style>x</style><style>a{}</style><img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/onerror/);
  });
  it('drops srcset / background / ping and other URL-bearing attributes', () => {
    const out = clean('<img src="https://x/a.png" srcset="https://evil 1x"><td background="https://evil">c</td><a href="https://ok" ping="https://evil">a</a>');
    expect(out).not.toContain('evil');
  });
  it('ignores content after </html>', () => {
    expect(clean('<html><body><p>a</p></body></html><img src=x onerror=alert(1)>')).toBe('<p>a</p>');
  });
  it('truncates absurd input instead of hanging', () => {
    const big = '<p>' + 'a'.repeat(2_000_000) + '</p>';
    const out = clean(big);
    expect(out.length).toBeLessThanOrEqual(1_000_100);
  });
});

describe('sanitizeEmailHtml — keeps presentational email markup', () => {
  it('keeps tables, inline styles, font/center and images', () => {
    const src =
      '<table width="600" cellpadding="0" style="border-collapse:collapse"><tr><td align="center" bgcolor="#eee" style="padding:8px">' +
      '<font face="Arial" color="#333">Hi <b>there</b></font><center><img src="https://cdn.test/logo.png" width="100" alt="logo"></center></td></tr></table>';
    const out = clean(src);
    expect(out).toContain('<table width="600" cellpadding="0" style="border-collapse:collapse">');
    expect(out).toContain('<td align="center" bgcolor="#eee" style="padding:8px">');
    expect(out).toContain('<font face="Arial" color="#333">');
    expect(out).toContain('<img src="https://cdn.test/logo.png" width="100" alt="logo" />');
  });
  it('forces links to open in a new tab without opener/referrer', () => {
    expect(clean('<a href="https://ok.test" target="_top">x</a>')).toBe(
      '<a href="https://ok.test" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });
  it('returns empty for wrapper-only bodies (Gmail blank mail), in every NBSP spelling', () => {
    expect(clean('<div dir="auto"></div>')).toBe('');
    expect(clean('<html><head></head><body>&nbsp;</body></html>')).toBe('');
    expect(clean('<div>&#160;</div>')).toBe('');
    expect(clean('<div>&#xA0;</div>')).toBe('');
    expect(clean('<div> </div>')).toBe('');
    expect(clean('')).toBe('');
  });
  it('keeps an image-only body', () => {
    expect(clean('<img src="https://x.test/a.png">')).toContain('<img');
  });
});

describe('sanitizeEmailHtml — cid: contract', () => {
  it('maps known Content-IDs to cid:<our uuid> and reports them as used', () => {
    const cidMap = new Map([['img1@mail', ID_A]]);
    const res = sanitizeEmailHtml('<p>a</p><img src="cid:img1@mail"><img src="CID:<img1@mail>">', { cidMap });
    expect(res.html).toBe(`<p>a</p><img src="cid:${ID_A}" /><img src="cid:${ID_A}" />`);
    expect([...res.usedCids]).toEqual([ID_A]);
  });
  it('drops images whose cid is unknown (and the now-sourceless img)', () => {
    const res = sanitizeEmailHtml('<img src="cid:nope@mail" alt="x"><p>t</p>', { cidMap: new Map() });
    expect(res.html).toBe('<p>t</p>');
    expect(res.usedCids.size).toBe(0);
  });
  it('never emits a cid: value that is not one of our uuids', () => {
    const res = sanitizeEmailHtml('<img src="cid:x">', { cidMap: new Map([['x', 'not-a-uuid"><script>']]) });
    expect(res.html).not.toContain('script');
    expect(res.html).not.toContain('cid:');
  });
});

describe('sanitizeEmailHtml — data: images', () => {
  it('drops data: images from inbound mail by default', () => {
    expect(clean('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe('');
  });
  it('allows only raster data: images when asked (agent editor paste)', () => {
    const png = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    const svg = '<img src="data:image/svg+xml;base64,PHN2Zz4=">';
    const html = '<img src="data:text/html;base64,PHNjcmlwdD4=">';
    expect(clean(png, { allowDataImages: true })).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(clean(svg, { allowDataImages: true })).toBe('');
    expect(clean(html, { allowDataImages: true })).toBe('');
  });
});

describe('normaliseCid', () => {
  it('is the one canonical form both sides of the cid map use', async () => {
    const { normaliseCid } = await import('./lib/email-html.js');
    for (const raw of ['logo@mail', '<logo@mail>', ' < logo@mail > ', 'cid:logo@mail', 'CID:<logo@mail>']) {
      expect(normaliseCid(raw)).toBe('logo@mail');
    }
    // A cidMap keyed by the canonical form resolves an <img> written any way.
    const cidMap = new Map([[normaliseCid('< logo@mail >'), ID_A]]);
    expect(sanitizeEmailHtml('<img src="cid: logo@mail ">', { cidMap }).html).toBe(`<img src="cid:${ID_A}" />`);
  });
});

describe('rewriteCidsToUrls', () => {
  it('swaps cid tokens for attribute-escaped URLs and leaves unknown ones', () => {
    const html = `<img src="cid:${ID_A}" /><img src="cid:${ID_B}" />`;
    const out = rewriteCidsToUrls(html, new Map([[ID_A, 'https://r2.test/a?X-Amz-Signature=1&x="y"']]));
    expect(out).toBe(`<img src="https://r2.test/a?X-Amz-Signature=1&amp;x=&quot;y&quot;" /><img src="cid:${ID_B}" />`);
  });
  it('does not touch cid: text outside a src attribute or non-uuid tokens', () => {
    const html = `<p>see cid:${ID_A}</p><img src="cid:notauuid" />`;
    expect(rewriteCidsToUrls(html, new Map([[ID_A, 'https://x']]))).toBe(html);
  });
  it('is a no-op with an empty map', () => {
    const html = `<img src="cid:${ID_A}" />`;
    expect(rewriteCidsToUrls(html, new Map())).toBe(html);
  });
});
