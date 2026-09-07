// Tests for the live ops-alert fan-out (lib/alert.ts): the env gate, the de-dup
// decision, and best-effort delivery to both channels.
//
// We mock only env.js (a benign superset, like cron.test.ts) and db.js (the
// dedup claim). We deliberately do NOT mock postmark-outbound.js — mock.module
// is process-global in Bun and would leak into that module's own test. Instead
// we stub global fetch, which BOTH the real sendEmail (→ api.postmarkapp.com)
// and the Slack webhook go through, and route by URL.

import { describe, expect, it, mock, afterAll, beforeEach } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

// Mutable env: alert.ts reads env.X at call time and the imported `env` is this
// same reference, so flipping a property mid-test flips the gate.
const realEnvMod = await import('./env.js');
const envObj = {
  ...realEnvMod.env,
  ALERT_EMAIL_TO: '',
  SLACK_ALERT_WEBHOOK_URL: '',
  POSTMARK_SERVER_TOKEN: 'postmark-token',
  POSTMARK_OUTBOUND_FROM: 'alerts@respovia.test',
};
// Spread the full module so no export is dropped; keep isLocalDev:false override.
mock.module('./env.js', () => ({ ...realEnvMod, env: envObj, isLocalDev: false }));

// DB stub — getDb() returns a tagged-template fn that yields the claim result.
let claimResult: Array<{ should_send: boolean; suppressed_since: number }> = [
  { should_send: true, suppressed_since: 0 },
];
let claimThrows = false;
mock.module('./db.js', () => ({
  getDb: () => async () => {
    if (claimThrows) throw new Error('db down');
    return claimResult;
  },
}));

// Stub global fetch and route by URL: Postmark vs Slack.
let postmarkCalls: string[] = []; // request body JSON
let slackCalls: Array<{ url: string; body: string }> = [];
let slackOk = true;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
  const u = String(url);
  if (u.includes('postmarkapp.com')) {
    postmarkCalls.push(init?.body ?? '');
    return {
      ok: true,
      json: async () => ({ MessageID: 'm', SubmittedAt: 't', To: 'x', ErrorCode: 0, Message: '' }),
    } as Response;
  }
  slackCalls.push({ url: u, body: init?.body ?? '' });
  return { ok: slackOk, status: slackOk ? 200 : 500 } as Response;
}) as typeof fetch;

const { sendOpsAlert, alertingConfigured } = await import('./alert.js');

afterAll(() => {
  mock.restore();
  globalThis.fetch = origFetch;
});

beforeEach(() => {
  postmarkCalls = [];
  slackCalls = [];
  claimResult = [{ should_send: true, suppressed_since: 0 }];
  claimThrows = false;
  slackOk = true;
  envObj.ALERT_EMAIL_TO = '';
  envObj.SLACK_ALERT_WEBHOOK_URL = '';
  envObj.POSTMARK_SERVER_TOKEN = 'postmark-token';
});

const SLACK_URL = 'https://hooks.slack.com/services/x';
const alert = { signature: 'test:sig', title: 'Something broke', detail: 'boom' };

describe('alertingConfigured', () => {
  it('is false when neither channel is set', () => {
    expect(alertingConfigured()).toBe(false);
  });
  it('is true when only Slack is set', () => {
    envObj.SLACK_ALERT_WEBHOOK_URL = SLACK_URL;
    expect(alertingConfigured()).toBe(true);
  });
  it('is true when Postmark + recipient are set', () => {
    envObj.ALERT_EMAIL_TO = 'ops@respovia.test';
    expect(alertingConfigured()).toBe(true);
  });
  it('email gate needs Postmark configured too', () => {
    envObj.ALERT_EMAIL_TO = 'ops@respovia.test';
    envObj.POSTMARK_SERVER_TOKEN = ''; // Postmark no longer configured
    expect(alertingConfigured()).toBe(false);
  });
});

describe('sendOpsAlert', () => {
  it('no-ops (no delivery) when unconfigured', async () => {
    await sendOpsAlert(alert);
    expect(postmarkCalls).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it('delivers to both channels when configured and the claim says send', async () => {
    envObj.ALERT_EMAIL_TO = 'ops@respovia.test';
    envObj.SLACK_ALERT_WEBHOOK_URL = SLACK_URL;
    await sendOpsAlert(alert);
    expect(postmarkCalls).toHaveLength(1);
    expect(postmarkCalls[0]).toContain('ops@respovia.test');
    expect(postmarkCalls[0]).toContain('Something broke');
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0].url).toBe(SLACK_URL);
  });

  it('suppresses delivery when the claim says not to send', async () => {
    envObj.ALERT_EMAIL_TO = 'ops@respovia.test';
    envObj.SLACK_ALERT_WEBHOOK_URL = SLACK_URL;
    claimResult = [{ should_send: false, suppressed_since: 0 }];
    await sendOpsAlert(alert);
    expect(postmarkCalls).toHaveLength(0);
    expect(slackCalls).toHaveLength(0);
  });

  it('fails open: delivers anyway when the dedup claim throws', async () => {
    envObj.ALERT_EMAIL_TO = 'ops@respovia.test';
    claimThrows = true;
    await sendOpsAlert(alert);
    expect(postmarkCalls).toHaveLength(1);
  });

  it('notes suppressed occurrences in the body when firing after a burst', async () => {
    envObj.ALERT_EMAIL_TO = 'ops@respovia.test';
    claimResult = [{ should_send: true, suppressed_since: 7 }];
    await sendOpsAlert(alert);
    expect(postmarkCalls[0]).toContain('7 more occurrence');
  });

  it('a single channel failing does not throw (best-effort)', async () => {
    envObj.ALERT_EMAIL_TO = 'ops@respovia.test';
    envObj.SLACK_ALERT_WEBHOOK_URL = SLACK_URL;
    slackOk = false; // Slack returns 500
    await sendOpsAlert(alert); // must resolve, not reject
    expect(postmarkCalls).toHaveLength(1);
  });
});
