// Bun test preload (see bunfig.toml) — runs once before any test file loads.
//
// env.ts validates the environment at module load (`Env.parse(process.env)`)
// and THROWS on missing required vars, which leaves its `env` export
// uninitialized. Several test files import code that transitively loads env.ts,
// so whichever file bun happens to evaluate first must already have these set
// — otherwise the first load throws and every later access fails with
// "Cannot access 'env' before initialization". File order differs by OS
// (local vs CI), so setting them here, before anything loads, makes the suite
// deterministic regardless of order.
//
// All placeholders: the DB connection is lazy (no socket opened) and no test
// hits the network. `||=` so a real value from the environment still wins.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
// postmark-outbound.test.ts needs Postmark to read as "configured" at env-parse
// time (it stubs fetch, so nothing is actually sent). env is parsed once, so
// these must be present before the first load — same reason as above.
process.env.POSTMARK_SERVER_TOKEN ||= 'test-server-token';
process.env.POSTMARK_OUTBOUND_FROM ||= 'support@maestro.test';
// push.test.ts needs Web Push to read as "configured" at env-parse time. A
// real generated keypair so setVapidDetails() accepts it (the test stubs
// webpush.sendNotification, so nothing leaves the process). Same parse-once
// reason as the Postmark vars above.
import webpush from 'web-push';
const _vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY  ||= _vapid.publicKey;
process.env.VAPID_PRIVATE_KEY ||= _vapid.privateKey;
process.env.VAPID_SUBJECT     ||= 'mailto:test@maestro.test';
// customer-from-player-tenant.test.ts needs workerMaestroConfigured() to read
// true so the handler reaches the brand/tenant checks it asserts (both paths
// short-circuit before any real gateway call). It used to set this at its own
// top level, but env.ts parses process.env once at first load, so the value
// only won if that file happened to evaluate before anything loading env.ts —
// an order that changed under CI when new test files landed. Same parse-once
// reason as everything above.
process.env.MAESTRO_API_TOKEN ||= 'mh_live_test_token_placeholder';
// Alerting must read as UNconfigured in tests: send-branded-email.test.ts
// exercises paths that call sendOpsAlert, and a dev machine with real
// ALERT_EMAIL_TO / SLACK_ALERT_WEBHOOK_URL exported would race alert emails
// into the tests' Postmark fetch stubs (flaking call-count assertions) or
// POST to a real Slack webhook from a unit test. Hard assignment, not ||= —
// real values must NOT win here.
process.env.ALERT_EMAIL_TO = '';
process.env.SLACK_ALERT_WEBHOOK_URL = '';
// cors.test.ts pins APP_BASE_URL to a prod-like origin to tell allow from deny.
// It mock.module's env.js to do so, but mock.module is global and index.js gets
// module-cached, so whether that mock "wins" depends on which file loads
// index.js first. Setting it in the real env here makes the CORS origin
// deterministic regardless of file order. Keep in sync with cors.test's
// APP_ORIGIN constant.
process.env.APP_BASE_URL ||= 'https://app.respovia.com';
// Storage must read as UNconfigured in tests: r2-presign.test.ts asserts the
// "attachments bucket not configured" contract, and a dev api/.env with real
// R2 credentials + R2_ATTACHMENTS_BUCKET would otherwise turn that unit test
// into a real signed PUT against the private bucket. Hard assignment, not ||=.
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_ATTACHMENTS_BUCKET = '';
process.env.R2_PUBLIC_BASE_URL = '';
