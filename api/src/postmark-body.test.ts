// Unit tests for pickBody (lib/postmark.ts). Pure — no DB, no network.
// postmark.ts imports env.ts, so pin the required env vars before importing.

import { describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'unit-test-secret-0123456789';

const { pickBody, PostmarkInbound } = await import('./lib/postmark.js');

function payload(fields: Record<string, unknown>) {
  return PostmarkInbound.parse({
    MessageID: 'pm-test-1',
    From: 'antonio@example.com',
    FromFull: { Email: 'antonio@example.com', Name: 'Antonio Flores' },
    ToFull: [{ Email: 'support@example.com' }],
    Subject: 'Retiro no acreditado',
    ...fields,
  });
}

describe('PostmarkInbound.Attachments', () => {
  it('parses the attachments array with Postmark defaults and tolerates its absence', () => {
    const p = payload({
      Attachments: [
        { Name: 'a.pdf', Content: 'QUJD', ContentType: 'application/pdf', ContentLength: 3, ContentID: '' },
        { Name: 'img.png', Content: 'QUJD', ContentType: 'image/png', ContentLength: 3, ContentID: 'img@mail' },
      ],
    });
    expect(p.Attachments).toHaveLength(2);
    expect(p.Attachments?.[1].ContentID).toBe('img@mail');
    expect(payload({}).Attachments).toBeUndefined();
    // Missing optional fields get the documented defaults.
    expect(payload({ Attachments: [{}] }).Attachments?.[0]).toMatchObject({ Name: 'file', Content: '', ContentType: 'application/octet-stream' });
  });
});

describe('pickBody', () => {
  it('prefers StrippedTextReply over TextBody over HtmlBody', () => {
    expect(pickBody(payload({ StrippedTextReply: 'stripped', TextBody: 'text', HtmlBody: '<p>html</p>' }))).toBe('stripped');
    expect(pickBody(payload({ StrippedTextReply: '  ', TextBody: 'text', HtmlBody: '<p>html</p>' }))).toBe('text');
    expect(pickBody(payload({ TextBody: '', HtmlBody: '<p>html</p>' }))).toBe('html');
  });

  it('maps a wrapper-only HTML body to the placeholder', () => {
    expect(pickBody(payload({ TextBody: '', HtmlBody: '<div dir="auto"></div>' }))).toBe('(empty body)');
    expect(pickBody(payload({}))).toBe('(empty body)');
  });

  it('converts a real HTML-only body to readable text', () => {
    const html = '<html><head><style>.a{b:c}</style></head><body><div dir="auto">Hola,<br>no llegó mi retiro de&nbsp;100&euro;.</div></body></html>';
    expect(pickBody(payload({ TextBody: '', HtmlBody: html }))).toBe('Hola,\nno llegó mi retiro de 100€.');
  });
});
