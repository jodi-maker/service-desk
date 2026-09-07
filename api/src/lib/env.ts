import { z } from 'zod';

const Env = z.object({
  // Neon Postgres connection string — the source of truth now that the
  // Supabase→Neon migration is complete. Required: every route + Better Auth
  // read through it.
  // Format: postgresql://user:pass@<host>.neon.tech/<db>?sslmode=require
  DATABASE_URL: z.string().url(),
  // Better Auth (migration to Neon — Step 2). Owns sessions/users sign-in.
  // SECRET signs sessions/tokens — generate with `openssl rand -base64 32`.
  // URL is the API's own base URL (where Better Auth's /api/auth/* is served).
  // Both optional for now so the app still boots mid-migration; Better Auth
  // warns + uses a dev fallback when the secret is unset.
  // Min 32 chars — Better Auth's own recommended length (`openssl rand -base64
  // 32`). REQUIRED as of the Step 3 auth cutover: Better Auth is now the live
  // auth system, so the app must not boot without a real secret.
  BETTER_AUTH_SECRET: z.string().min(32),
  // Trailing slashes are stripped here once so every consumer can concatenate
  // `${env.X}/path` safely — do NOT re-strip at the call sites.
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3001')
    .transform((v) => v.replace(/\/+$/, '')),
  // Public origin of the agent SPA (where index.html is served). Used as a
  // Better Auth trusted origin and to build the password-reset link emailed to
  // invited/reset users (`${APP_BASE_URL}/?reset_token=...`). Dev default is
  // the local static server; set to https://app.respovia.com in prod.
  APP_BASE_URL: z.string().url().default('http://localhost:5173')
    .transform((v) => v.replace(/\/+$/, '')),
  ANTHROPIC_API_KEY: z.string().min(20),
  // Shared secret for the Postmark inbound + bounce webhooks, sent via HTTP
  // Basic Auth (the password slot) — configure the webhook URL as
  // https://postmark:<value>@<host>/api/v1/webhooks/postmark/inbound. The
  // secret rides in the Authorization header, never the URL query; the old
  // ?secret= form is no longer accepted (see lib/postmark.ts).
  POSTMARK_INBOUND_SECRET: z.string().min(16),
  // Outbound — Server API Token from Postmark (Settings → API Tokens).
  // Verified sender address (Sender Signatures or domain-verified).
  // Auto-reply is skipped at runtime if either is empty.
  POSTMARK_SERVER_TOKEN: z.string().default(''),
  POSTMARK_OUTBOUND_FROM: z.string().default(''),
  // Account-level token (Postmark UI → Account → API Tokens). REQUIRED for
  // the Postmark Domains API (provisioning per-brand sender domains).
  // Distinct from POSTMARK_SERVER_TOKEN above — that one's per-server (for
  // sending mail), this one's per-account (for managing senders + domains).
  // When empty, the domain-add API still creates the local workspace_email_
  // domains row but skips Postmark provisioning; the brand can re-trigger
  // via POST /api/v1/god/brands/:id/domains/:domainId/verify once configured.
  POSTMARK_ACCOUNT_TOKEN: z.string().default(''),
  // Postmark inbound stream address — set as Reply-To on outbound so
  // customer replies route back through the webhook (closing the loop).
  // Find under Postmark → Servers → <server> → Default Inbound Stream →
  // Settings — the "@inbound.postmarkapp.com" address at the top.
  // Empty means replies fall back to the From address.
  POSTMARK_INBOUND_REPLY_ADDRESS: z.string().default(''),
  // Public-facing base URL of the customer portal. Used to build links
  // we embed in outbound emails (CSAT surveys, magic-link sign-in
  // fallback). Should include the protocol and path to
  // portal.html — e.g. https://help.acme.com/portal.html. Empty in
  // dev: csat code falls back to http://localhost:5173/portal.html,
  // and the magic-link path derives a URL from the request origin.
  PORTAL_BASE_URL: z.string().default(''),
  // Cloudflare R2 (migration to Neon — Step 4). Replaces Supabase Storage
  // for brand-asset uploads (workspace logos). R2 is S3-compatible; we sign
  // requests with aws4fetch (region "auto") rather than an AWS SDK so the
  // same code runs on Bun locally and Node on Vercel.
  //   ACCOUNT_ID    → the S3 endpoint host: <id>.r2.cloudflarestorage.com
  //   ACCESS_KEY_ID / SECRET_ACCESS_KEY → an R2 API token (S3 credentials)
  //   BUCKET        → bucket name, e.g. "brand-assets"
  //   PUBLIC_BASE_URL → the bucket's public read base (r2.dev URL or a
  //                     custom domain), used to build the stored logo_url.
  // All optional mid-migration: lib/r2.ts throws a clear error if used while
  // unset, so the API still boots (and routes that don't upload still work)
  // until R2 is provisioned. Becomes required once logo upload is live.
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default('brand-assets'),
  R2_PUBLIC_BASE_URL: z.string().default(''),
  // PRIVATE bucket for ticket attachments (customer files, inline email images).
  // Separate from R2_BUCKET on purpose: that one is public-read for logos and
  // must never hold customer data. Empty = attachment features report "not
  // configured"; everything else keeps working.
  R2_ATTACHMENTS_BUCKET: z.string().default(''),
  // Pubby realtime (migration — Step 5). Pusher-compatible push for live
  // ticket/message updates. All optional: when unset, lib/pubby.ts no-ops and
  // the SPA falls back to polling, so realtime is purely additive.
  //   APP_ID/KEY/SECRET → server PubbyServer (KEY is the public app key; the
  //     SPA also receives it). SECRET signs trigger + channel-auth.
  //   WS_HOST → the client's WebSocket host (e.g. wss://ws.pubby.dev), served
  //     to the SPA via GET /api/v1/pubby/config.
  //   API_HOST → optional override of the server HTTP API (default
  //     https://api.pubby.dev, where triggers POST).
  PUBBY_APP_ID: z.string().default(''),
  PUBBY_KEY: z.string().default(''),
  PUBBY_SECRET: z.string().default(''),
  PUBBY_WS_HOST: z.string().default(''),
  PUBBY_API_HOST: z.string().default(''),
  // Web Push (VAPID) for offline-agent notifications. All optional: when the
  // keypair is unset, lib/push.ts no-ops and the SPA hides the opt-in (same
  // gating style as Pubby/Sentry). Generate with `npx web-push generate-vapid-keys`.
  // VAPID_PUBLIC_KEY is exposed to the client via GET /push/config; the private
  // key is server-only. VAPID_SUBJECT is a mailto: or https: contact URL.
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:ops@respovia.com'),
  // Vercel Cron auth (Step 6). Vercel sends `Authorization: Bearer
  // ${CRON_SECRET}` when invoking the /api/v1/cron/* endpoints; they reject
  // anything else. Required on Vercel (generate with `openssl rand -base64
  // 32`); optional locally, where the in-process worker (src/dev.ts) does the
  // sweeping and the cron endpoints stay closed.
  CRON_SECRET: z.string().default(''),
  // Maestro Connect — the iGaming platform's identity + data gateway.
  // Two capabilities, one registered app ("Service Desk",
  // app id 6c3f3c30-8beb-4763-adfd-e1ccea2aa976 in the developer portal):
  //   1. "Sign in with Maestro" — agents authenticate with their Maestro
  //      account via Better Auth's genericOAuth plugin (PKCE). CLIENT_ID +
  //      CLIENT_SECRET come from `maestro apps create` / the developer portal.
  //      Both empty → the provider isn't mounted and the SPA hides the button.
  //   2. Headless worker (email pipeline / AI drafting) — API_TOKEN is an
  //      mh_live_* token minted post-approval (portal → Apps → Tokens) and
  //      BRAND_ID the default X-Brand-Id (from `maestro apps installations`).
  //      Both empty → player-context enrichment is skipped.
  MAESTRO_CLIENT_ID: z.string().default(''),
  MAESTRO_CLIENT_SECRET: z.string().default(''),
  // Discovery itself is at the CANONICAL path
  // (`${MAESTRO_ISSUER}/.well-known/openid-configuration`, fetched in
  // lib/auth.ts); `iss` is the issuer ORIGIN — scheme included, no path prefix
  // (`https://auth.maestro-connect.com`), which is what the live document
  // returns. It is the endpoints *inside* that document which sit on a
  // non-standard prefix — authorize/token/userinfo are all under /api/auth/ —
  // but Better Auth reads those from the doc, so nothing here encodes them.
  // Both are concatenated by their consumers (auth.ts discoveryUrl,
  // maestro.ts request builder), so they strip trailing slashes like the other
  // URL vars above — a pasted 'https://api.maestro-connect.com/' would
  // otherwise produce a '//api/v1/...' path that the gateway 404s.
  MAESTRO_ISSUER: z.string().url().default('https://auth.maestro-connect.com')
    .transform((v) => v.replace(/\/+$/, '')),
  MAESTRO_GATEWAY_URL: z.string().url().default('https://api.maestro-connect.com')
    .transform((v) => v.replace(/\/+$/, '')),
  MAESTRO_API_TOKEN: z.string().default(''),
  MAESTRO_BRAND_ID: z.string().default(''),
  // Sentry error tracking (observability). Both optional: when SENTRY_DSN is
  // empty, lib/instrument.ts does NOT call Sentry.init, so the SDK no-ops
  // (captureException/flush become no-ops) and the app runs exactly as before.
  // Set the DSN in the Vercel Production env to turn it on — no code change.
  // SENTRY_ENVIRONMENT tags events (e.g. 'production' / 'preview'); defaults to
  // VERCEL_ENV or 'development' in instrument.ts when unset.
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default(''),
  // Live ops alerts (lib/alert.ts) — pushed on audit-chain tamper, unhandled API
  // errors, and failed crons. Two independent channels, both optional:
  //   ALERT_EMAIL_TO        → recipient for Postmark email alerts (also needs
  //                           POSTMARK_SERVER_TOKEN + POSTMARK_OUTBOUND_FROM).
  //   SLACK_ALERT_WEBHOOK_URL → a Slack Incoming Webhook (hooks.slack.com/...).
  // With neither set, alerting no-ops; alerts always also go to the logs.
  ALERT_EMAIL_TO: z.string().default(''),
  SLACK_ALERT_WEBHOOK_URL: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3001),
  // Self-hosted deploys only (Dokploy/Traefik): set to '1' when the API sits
  // behind OUR OWN reverse proxy, which appends the real TCP peer address as
  // the RIGHT-most X-Forwarded-For entry. lib/rate-limit.ts then keys per-IP
  // limits on that entry instead of the left-most (client-supplied, spoofable)
  // one. Leave unset on Vercel (ipAddress() covers it) and in local dev.
  // Strict enum on purpose: TRUST_PROXY=true/yes/on must fail the boot rather
  // than silently parse as "off" and quietly revert to the spoofable path.
  TRUST_PROXY: z.enum(['', '0', '1']).default('').transform((v) => v === '1'),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;

// PRODUCTION boot guard: the localhost defaults on the public-URL vars exist
// only for local dev. On a production deploy an unset var would otherwise
// fail silently and late (CORS-blocked SPA, dead reset links, broken OAuth
// callback) — refuse to boot instead. Covers Vercel production AND
// self-hosted production (NODE_ENV). Vercel PREVIEW deploys are exempt on
// purpose: PR-preview API builds don't carry these vars and must still boot
// (staging sets its own branch-scoped values per PROD_SETUP.md §7).
const isProductionDeploy =
  process.env.VERCEL_ENV === 'production' ||
  (!process.env.VERCEL && process.env.NODE_ENV === 'production');
if (isProductionDeploy) {
  const localhostVars = (['BETTER_AUTH_URL', 'APP_BASE_URL'] as const)
    .filter((k) => env[k].startsWith('http://localhost'));
  if (localhostVars.length > 0) {
    throw new Error(
      `Production deploy with localhost default(s) for: ${localhostVars.join(', ')} — ` +
      'set the real public URLs in the Vercel Production env (see PROD_SETUP.md §3).'
    );
  }
}

// Maestro Connect moved from mert.md to maestro-connect.com in 2026-08. The
// retired hosts still answer — with an EMPTY 200 on every path — so a stale
// value fails silently and confusingly: OIDC discovery returns nothing, sign-in
// dies with a generic "temporarily unavailable", and /api/v1/maestro/status
// still reports enabled:true because it only inspects the client id/secret.
// Changing the defaults above cannot help a deploy that sets these explicitly,
// and no health check covers them, so name the cause at boot.
// Deliberately a warning, NOT a throw: refusing to boot would turn a broken
// sign-in button into a total API outage, which is strictly worse.
const retiredMaestroHosts = (['MAESTRO_ISSUER', 'MAESTRO_GATEWAY_URL'] as const)
  .filter((k) => /(^|\.)mert\.md(\/|$)/.test(env[k]));
if (retiredMaestroHosts.length > 0) {
  console.error(
    `[env] ${retiredMaestroHosts.join(' and ')} still point at the RETIRED mert.md domain. ` +
    'Maestro sign-in and player lookups will fail (the old hosts return empty 200s). ' +
    'Unset them to pick up the maestro-connect.com defaults — see PROD_SETUP.md §3.'
  );
}

// Runtime environment flag (distinct from the validated config above —
// these are ambient signals injected by the platform, not app config).
// `VERCEL` is set on every Vercel deployment; `NODE_ENV` is the standard
// production marker. We consider the app "local dev" ONLY when neither
// signals a deployed/production environment — so anything production-like
// fails safe. Use this to gate behaviour that's acceptable locally but not
// in production (e.g. logging sensitive auth links). Prefer this over a bare
// `process.env.VERCEL` check so the prod/dev decision lives in one place.
export const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== 'production';

// True only on Vercel PREVIEW deployments (branch deploys incl. staging; never
// production — Vercel sets VERCEL_ENV='production' there; on the Node runtime
// VERCEL_ENV is always present, no "expose system env vars" opt-in needed).
// Gates the loosened CORS/trusted-origins that let PR-preview SPAs talk to the
// staging API.
export const isVercelPreview = process.env.VERCEL_ENV === 'preview';

// The team's Vercel PR-preview SPA origins — git-BRANCH deploys only, e.g.
// https://maestro-desk-git-<branch>-jodi-1420s-projects.vercel.app (staging's
// own `git-staging` host matches too, which is intended). The `git-` marker is
// REQUIRED and `git-main-` is excluded so PRODUCTION deployment URLs never
// match: Vercel also assigns prod a `maestro-desk-<hash>-…` deployment URL and
// a `git-main` alias, and matching those would let this loosening touch prod.
// Single source of truth: index.ts CORS and auth.ts trustedOrigins both import
// this, so the two layers can't drift apart. Residual (accepted): the trailing
// team slug can be spoofed by anyone who registers a Vercel project literally
// named to end in `-jodi-1420s-projects`; tolerated because this only ever
// widens CORS/trust on PREVIEW deploys (never prod), against the staging DB,
// and auth is bearer-token in sessionStorage (no ambient cookies to replay).
export const PREVIEW_SPA_ORIGIN_RE =
  /^https:\/\/maestro-desk-git-(?!main-)[a-z0-9-]+-jodi-1420s-projects\.vercel\.app$/;
