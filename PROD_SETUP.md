# Production setup — internal cutover (clean-slate)

Standing up Respovia for **internal use** (your team replaces Zoho Desk). Clean-slate: new tickets start here; old Zoho tickets stay in Zoho until they close out. No data migration.

Stack (post Supabase→Neon→self-hosted migrations): **Dokploy Postgres** (`respovia-db`, postgres:17 container on the company server — source of truth since the 2026-08 cutover; Neon is retired for prod, kept only as the rollback copy during the soak and for staging) · **Better Auth** (sign-in/sessions, owns its tables in the same database) · **Cloudflare R2** (brand-asset uploads + nightly DB dumps in a separate private bucket) · **Dokploy** (company server — SPA nginx container + the Hono API as an always-on Node container; see §3) · **Postmark** (email).

> **URLs (2026-08-11, cutover complete).** The product domain is **`respovia.com`** (registered 2026-08-10, Cloudflare Registrar; DNS at Cloudflare). Production hosts:
> | Role | Production URL |
> |---|---|
> | API (Dokploy `respovia-api`) | `https://api.respovia.com` |
> | Agent app (Dokploy `respovia-web`) | `https://app.respovia.com` |
> | Portal | `https://app.respovia.com/portal.html` |
> | Support email | `support@respovia.com` (see §5) |
>
> Notes:
> - **`app.respovia.com` is the only fully working agent-app host.** The API's CORS + Better Auth trusted-origin allowlist is `APP_BASE_URL` alone, so on any other host — the apex/www, any retired legacy alias — the SPA either renders-but-can't-sign-in (origin-blocked) or falls back to `localhost:3001` entirely. Always use `app.respovia.com`.
> - **The apex/www redirect → `app.respovia.com` is REQUIRED.** Without it, visitors on `respovia.com` get a rendered SPA whose sign-in fails with opaque CORS errors. Do not "fix" that by widening the server allowlist. (Live implementation: the nginx 308 server block in `web/nginx.conf` — apex/www ride the same tunnel ingress to the web container.)
> - **Domain wiring (as-built, 2026-08-11):** the server's WAN IP (`194.72.43.234`) fronts the office **3CX phone system** on 80/443 — do NOT point DNS A records there. Ingress is the **`respovia` Cloudflare Tunnel** instead: cloudflared runs as the Dokploy app `cloudflared`, its ingress targets the app containers directly (`respovia-web-…:80`, `respovia-api-…:3001`, bypassing Traefik so the right-most `X-Forwarded-For` stays the real client IP for `TRUST_PROXY=1`), and Cloudflare holds **proxied** CNAMEs `app`/`api`/apex/`www` → `<tunnelid>.cfargotunnel.com`. The Dokploy Traefik domains still exist for LAN debugging only (their Let's Encrypt renewals fail harmlessly behind the tunnel).
> - **Maestro manifest ordering (breaks SSO if violated):** the Maestro OAuth `redirect_uri` is derived from `BETTER_AUTH_URL` at runtime, but the platform only accepts URIs registered in the **approved** manifest. Editing `maestro.yml` in-repo is inert — any redirect-URI change must go through `maestro apps diff` → `maestro apps revise` and platform approval before the runtime env relies on it. (Post-cutover: verify the approved manifest actually carries `https://api.respovia.com/…` — see the "verify Sign in with Maestro" task.)
> - The legacy interim Vercel hosts (`maestro-desk-zjkl.vercel.app` API, `maestro-desk-jodi-1420s-projects.vercel.app` SPA) were retired from the code in the post-soak cleanup PR — CORS-blocked by the API and no longer mapped in `api-base.js`, the CSPs, or `maestro.yml`. The legacy Vercel **API** can no longer reach the prod DB at all (Dokploy-internal Postgres, no WAN exposure), so it is not a rollback path — rollback is Dokploy build history. The Vercel projects remain only for **staging/PR previews** until formally retired.

> Legend: 🤖 = Claude can do it (repo / Neon SQL via Management or psql) · 👤 = you (billing, DNS, account auth, deploy).

> **Supabase is gone.** The codebase no longer contains `@supabase/supabase-js`, any `SUPABASE_*` env var, or RLS — authorization is per-route in the Hono API, and auth is Better Auth on Neon. Any older instructions that referenced a Supabase prod project, the Custom Access Token Hook, or `SUPABASE_*` secrets are obsolete.

## Status
**Migration complete (code):** all data access, file storage (R2), and auth (Better Auth) are off Supabase and merged to `main`. The auth flip was verified end-to-end on Neon dev (API smoke + browser login).
**Not yet live:** prod env/secrets, the coordinated API+SPA deploy, and re-inviting users — the steps below.

## 1. Database — dedicated Dokploy Postgres (source of truth)
> **Cutover 2026-08:** prod data moved from Neon into the Dokploy service **`respovia-db`** (postgres:17, project `respovia`) via `pg_dump -Fc`/`pg_restore` with row-count + `audit_events_verify()` verification. The API reaches it over the internal Docker network: `DATABASE_URL=postgresql://respovia:…@<respovia-db appName>:5432/respovia?sslmode=disable` (**`sslmode=disable` is required** — the container has no TLS, and `db.ts`/`migrate.ts` only skip TLS on that exact marker; the network never leaves the host). The DB has **no public/WAN exposure**; a temporary LAN-only external port is attached in Dokploy just for migrations/maintenance and removed after.
- [ ] 🤖 Migrations apply **at API-container boot** (Dockerfile CMD runs `api/scripts/migrate.ts` under Node before the server starts; advisory-locked, transactional, tracked in `schema_migrations`, idempotent). There is no reachable-from-CI migration path anymore — `.github/workflows/migrate.yml` is legacy/manual-only.
- [ ] 🤖 Smoke a raw read against prod (`select count(*) from workspaces`) from a LAN machine, or via `GET /api/v1/health/ready`.
- [ ] 👤 Backups: nightly `pg_dump` via Dokploy's backup scheduler to the private R2 bucket — see `docs/backup-recovery.md` (RPO ≤ 24 h; run a restore drill).

## 2. Bootstrap your real workspace (clean-slate, not the demo seed)
- [ ] 🤖 Create your workspace via `select provision_brand(<name>, <slug>, …)` — seeds roles + permissions + status/priority/category lookups + business hours. Returns the new workspace id.
- [ ] 🤖 Create your platform-admin user **through Better Auth** (`POST /api/auth/sign-up/email` against the prod API, or `auth.api.signUpEmail`), then `update users set is_platform_admin = true where email = 'jodi@weezboo.com'` and add a `workspace_members` row (Admin role). The credential lives in Neon's `account` table.
- [ ] 🤖 Do **not** load the demo seed (TK-001 etc.) into prod.

## 3. Hosting — API + SPA
> **Decided (2026-08-11, supersedes the Vercel decision below).** Production moves to the **company server via Dokploy** (`https://paas.weez.boo`, LAN/VPN-only panel; server public IP `194.72.43.234`). Two Dokploy applications built from this repo's `main`:
> - **`respovia-api`** — Dockerfile build, **Docker Context Path = `.` (repo root), Dockerfile = `api/Dockerfile`** (root context so `db/migrations/` ships in the image for the boot-time migration pass; the root `.dockerignore` keeps the context lean — note `api/.dockerignore` does NOT apply to root-context builds). The container runs `src/server.ts` **under Node (via tsx), NOT Bun** — Bun's fetch ignores undici dispatchers and node:https custom lookups, which would silently drop the connect-time SSRF/DNS-rebind guard on webhook deliveries (PR #412); Vercel prod is Node too, so runtime parity holds. `src/index.ts` stays the Vercel serverless export, `src/dev.ts` stays local dev (Bun). Container port 3001. Env: everything §4 lists **plus `TRUST_PROXY=1`** (rate-limit keys on the Traefik-appended right-most `X-Forwarded-For` entry, guarded by a TCP-peer-is-private check; the strict parser rejects any value other than ''/0/1 at boot). `NODE_ENV=production` is baked into the image (arms the env.ts boot guard).
> - **`respovia-web`** — Dockerfile build, **Docker Context Path = `web`**. nginx serving the static tree; the security headers from `web/vercel.json` are mirrored in `web/nginx.conf`, and CI (`scripts/header-sync-check.mjs`, guards job) fails if the two files drift.
> - **Scheduled jobs — scheduler of record is the GitHub Actions workflow `.github/workflows/cron-jobs.yml`** (daily 03:00 webhook-retry / 04:00 retention UTC), which calls the API's `CRON_SECRET`-gated HTTP endpoints `/api/v1/cron/*` on production; repo secret `PROD_CRON_SECRET` = the API's `CRON_SECRET` (rotate together). Its `Run workflow` button also runs `audit-verify` and the one-off `player-identity-backfill` (repeat until `remaining` is 0). **Why not Dokploy schedules:** they exec `node --import tsx src/cron-run.ts <job>` INSIDE the API container, and since late August 2026 every run has failed in 0 s with "Container not found for application 'respovia-api-…', make sure the service is running" — the panel cannot reach the container (a member-role account cannot see the Docker view to diagnose; likely the task runs on a node the panel's `docker ps` doesn't cover). Deploys themselves land fine. Until a Dokploy owner fixes that, leave the Dokploy schedules as documentation only (the two mechanisms are idempotent, so both firing is harmless). **Accepted risks of the HTTP path:** (a) Cloudflare cuts responses after ~100 s (HTTP 524) while the API keeps running the job — a 52x in the Actions log means "check API logs / ops alerts", not "the job failed"; the backfill endpoint is capped per call (`?limit=` contacts across all brands, default 100, max 500, plus a 60 s deadline after which it returns early with `remaining`) and single-flight via a Postgres advisory lock (409 while running, from any process) for this reason, and a retention sweep that ever outgrows the window should move to an in-process scheduler (see follow-ups). (b) GitHub disables `schedule:` triggers after 60 days without commits — one-click re-enable under Actions; a cron-freshness check is a follow-up. (c) `CRON_SECRET` is now load-bearing on prod — routes/cron.ts warns at boot when it is unset on any non-local deploy. **Follow-ups considered:** an in-process daily scheduler in `server.ts` (same shape as the webhook retry worker, advisory-locked) would remove the secret, the edge timeout and the external scheduler entirely; and the 03:00 webhook-retry call is mostly redundant on this host (the 10-min in-process retry poll already sweeps), only its two `prune_*` calls are unique. Original design note follows.
> - Dokploy schedules (currently failing, see above): exec `node --import tsx src/cron-run.ts <webhook-retry|retention>` INSIDE the API container (daily 03:00 / 04:00; no CRON_SECRET or HTTP involved, so — when they work — a long retention sweep isn't subject to any request timeout). **The schedule set is versioned in `deploy/dokploy/provision-schedules.mjs`** — edit that file and re-run it (idempotent upsert) rather than hand-editing the panel; if the application is ever recreated, re-run it too. Webhook FIRST attempts don't ride cron at all: they flush inline at dispatch, and the in-process worker polls at a slow retry-only cadence (10 min; sized for the Neon-autosuspend era, kept because it's still the right cadence). Duplicate/overlapping invocations stay safe (`FOR UPDATE SKIP LOCKED`). Job failures fire ops alerts (`alertCronFailure`); a schedule that silently stops FIRING is only caught by the provision script / panel check — accepted risk for now. **Vercel Cron on the legacy API project still fires its HTTP endpoints, but against the stale Neon copy** (it cannot reach the Dokploy-internal prod DB) — harmless but pointless churn; disable those crons / retire the project when Vercel retirement is decided.
> - `BETTER_AUTH_URL` must equal the API's **public** origin so session tokens sign/verify correctly.
>
> **Legacy (Vercel — historical; prod hosts retired in the post-soak cleanup PR):** the API ran as serverless functions (Hono Vercel adapter) with webhook first-attempts via `waitUntil` and the sweeps as Vercel Cron (`api/vercel.json`); `CRON_SECRET` gates those endpoints there too. Do **not** add new Fly config (Fly was retired earlier).

Prod secrets to set on the API host (no `SUPABASE_*`):
```sh
DATABASE_URL=postgresql://respovia:…@<respovia-db appName>:5432/respovia?sslmode=disable   # internal Docker network; sslmode=disable REQUIRED (see §1)
BETTER_AUTH_SECRET=<openssl rand -base64 32>      # REQUIRED — app won't boot without it
BETTER_AUTH_URL=https://api.respovia.com   # the API's own public origin
APP_BASE_URL=https://app.respovia.com      # SPA origin: trusted origin + reset-link base
ANTHROPIC_API_KEY=…
POSTMARK_INBOUND_SECRET=<random 16+ chars>
POSTMARK_SERVER_TOKEN=…  POSTMARK_OUTBOUND_FROM=support@respovia.com   # needs the domain verified in Postmark (see §5)
POSTMARK_ACCOUNT_TOKEN=…  POSTMARK_INBOUND_REPLY_ADDRESS=…@inbound.postmarkapp.com
PORTAL_BASE_URL=https://app.respovia.com/portal.html
CRON_SECRET=<openssl rand -base64 32>              # REQUIRED — the GitHub Actions scheduler (cron-jobs.yml) calls /api/v1/cron/* with it; unset = every call 401s and no sweeps run. Mirror it in the repo secret PROD_CRON_SECRET; rotate both together.
# Cloudflare R2 (brand-asset/logo uploads):
R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…
R2_BUCKET=brand-assets  R2_PUBLIC_BASE_URL=https://<pub-…r2.dev or custom domain>
R2_ATTACHMENTS_BUCKET=respovia-attachments   # a SECOND, PRIVATE bucket (no public URL) for ticket attachments; same API token
# Maestro Connect (app "Service Desk"). Sign-in needs the first two; the headless
# player-context worker needs the last two. Leave a pair empty to disable that half.
MAESTRO_CLIENT_ID=…  MAESTRO_CLIENT_SECRET=…
MAESTRO_API_TOKEN=mh_live_…  MAESTRO_BRAND_ID=<brand uuid from `maestro apps installations`>
# Do NOT set MAESTRO_ISSUER / MAESTRO_GATEWAY_URL. They default to
# https://auth.maestro-connect.com and https://api.maestro-connect.com in
# api/src/lib/env.ts; setting them here only pins a host that can go stale (they
# were left pointing at the retired mert.md domain through the 2026-08 migration).
```
- [ ] 👤 **Maestro host check (do this after any platform domain change):** confirm `MAESTRO_ISSUER` / `MAESTRO_GATEWAY_URL` are **absent** from the Dokploy `respovia-api` env — a value set here silently overrides the code default and no health check will catch it. Symptom of a stale host: `GET /api/v1/maestro/status` still returns `{"enabled":true}` (it only checks the client id/secret) while `/api/v1/maestro/login` fails, because the issuer's `/.well-known/openid-configuration` returns an empty body.
- [ ] 👤 **R2 asset-domain headers (audit #7, config half):** new uploads store `Content-Disposition: attachment` (set by the API at PUT time), but `X-Content-Type-Options: nosniff` can't be stored as S3 object metadata — add it at the serving layer. On a custom asset domain: Cloudflare → Rules → Transform Rules → Modify Response Header → add `X-Content-Type-Options: nosniff` for the asset hostname. (Not possible on a bare `pub-….r2.dev` URL — becomes available once the domain is registered and the bucket gets a custom domain.)
- [ ] 👤 Deploy the API; verify `GET /api/v1/health` = 200 and `GET /api/v1/health/ready` proves DB connectivity (`/ready/neon` is a legacy alias).
- [ ] 👤 **Vercel (SPA):** deploy the static frontend (the **`web/`** directory — `index.html`, `portal.html`, `js/`, `styles/`; the SPA project's **Root Directory must be `web`**, so it builds as pure static with zero functions and never picks up `api/`). The agent app serves at `https://app.respovia.com`. The SPA picks its API base by hostname (`web/js/api-base.js`) — see the URL notes at the top for which hosts are recognized; every other host falls back to `localhost:3001`. There is **no** `/api/v1/config` fetch anymore.

### Post-deploy verification & rollback
- **Automatic health-check.** Every push to `main` runs `.github/workflows/post-deploy-healthcheck.yml`, which polls the live API (`/api/v1/health` + `/api/v1/health/ready`) and SPA root and **fails the Actions run if the deployment is down or the database is unreachable**. (Limitation: the health routes carry no git-SHA, so it proves the API is up + DB-reachable after the push, not that this exact commit is live.) Watch the **Actions** tab after a deploy; a red "Post-deploy health-check" means the site is unhealthy.
- **Rollback (manual, Dokploy).** Each Dokploy application keeps its deployment history: open the app (`respovia-api` / `respovia-web`) → **Deployments** → redeploy the last-known-good build (or check out the last-good commit on a branch and point the app at it). Do this for **both** apps if both shipped the bad commit. Note: a rollback reverts **code only** — applied migrations are not undone, and that is safe by design: migrations are additive by convention, and a rolled-back image simply doesn't contain the newer migration files, so its boot-time migration pass is a no-op. A schema that needs reverting requires a new forward migration. A **bad migration** can't take the site down either: it aborts the new container's boot before the server starts, the container never turns healthy, and the previous deployment keeps serving.

## 4. Auth cutover (the flip goes live here)
This is atomic: the API verifies Better Auth sessions and the SPA signs in via Better Auth — **deploy them together**.
- [ ] 👤 Deploy the **API and SPA from the same `main` commit** in one window. A new SPA against an old API (or vice-versa) breaks login.
- [ ] 👤 **Re-invite / reset every existing user.** Supabase password hashes do **not** carry over (Better Auth stores credentials in Neon's `account` table). Per user: 🤖 `POST /api/v1/god/brands/:id/invite {email}` (creates the Better Auth user if absent + emails a set-password link via Postmark), or `POST /api/auth/request-password-reset {email}` for an existing account. The link lands at `${APP_BASE_URL}/?reset_token=…` (`https://app.respovia.com/?reset_token=…`) → the SPA's set-password panel.
- [ ] 👤 Confirm `BETTER_AUTH_SECRET` + `APP_BASE_URL` + `BETTER_AUTH_URL` are set (above) — the reset email and trusted-origin checks depend on them.

## 5. Email (Postmark) + DNS
> **Unblocked 2026-08-10** — `respovia.com` is registered (DNS at Cloudflare; keep mail records DNS-only).
- [ ] 👤 In Postmark, add your sending **Domain** (not just a signature) → it returns DKIM + Return-Path records.
- [ ] 👤 Add DNS records on `respovia.com` (Cloudflare, DNS-only):
  - **DKIM** + **Return-Path (CNAME)** — from Postmark
  - **SPF (TXT @):** `v=spf1 a mx include:spf.mtasv.net ~all`
  - **DMARC (TXT _dmarc):** `v=DMARC1; p=none; pct=100; rua=mailto:rua@dmarc.postmarkapp.com` (monitoring; tighten after ~2 weeks)
  - **MX ⚠ decision — pick one, the later steps depend on it:**
    - **(a) Apex MX → `inbound.postmarkapp.com`.** `support@respovia.com` accepts directly-addressed mail → the `workspace_email_domains` step below and the §6 "email a ticket into existence" smoke work as written. Cost: ALL `@respovia.com` mail routes to the ticketing webhook — no normal mailboxes (e.g. Google Workspace) on the apex, ever, without redoing this.
    - **(b) No apex MX.** Mailbox options stay open; *replies* to outbound ticket email still thread fine (they ride the `POSTMARK_INBOUND_REPLY_ADDRESS` Reply-To). But directly-addressed mail to `support@respovia.com` **bounces**: skip the `workspace_email_domains` step below, skip the §6 send-an-email smoke, and take email-to-ticket intake from a subdomain (e.g. MX on `support.respovia.com`) or a forwarding rule later.
- [ ] 👤 Verify the domain in Postmark (DKIM + Return-Path) — DNS can take minutes–hours.
- [ ] 👤 Configure the Postmark inbound webhook with **HTTP Basic Auth** (the secret rides in the `Authorization` header, never the URL) → `https://postmark:<POSTMARK_INBOUND_SECRET>@api.respovia.com/api/v1/webhooks/postmark/inbound`. The bounce webhook uses Postmark's HTTP Basic Auth username/password fields (username `postmark`, password = the secret). The `?secret=` query form is no longer accepted.
- [ ] 🤖 *(MX option (a) only)* Add the support domain to `workspace_email_domains` so inbound routes to your workspace (not the unrouted bucket).

## 6. Smoke + pilot
- [ ] 👤 Agent signs in at `https://app.respovia.com` with their **Better-Auth** password (set via the reset link) — confirm the workspace shell loads (not the demo persona).
- [ ] 👤 Platform admin (`jodi@…`) signs in → the god panel is reachable; create a brand + invite an owner → owner receives the set-password email.
- [ ] 👤 *(after §5; MX option (a) only — with option (b) directly-addressed mail bounces by design)* Send a test email to `support@respovia.com` → confirm a ticket appears and auto-triage populates summary/draft; agent replies → customer receives it from `support@respovia.com`. Until then, you can still create tickets manually in-app to exercise the rest of the flow.
- [ ] 👤 Upload a workspace logo in Settings → confirm it renders from the R2 public URL.
- [ ] 👤 Run a few real tickets through before flipping your public support address.
- [ ] 👤 *(after §5 / domain registered)* **Cutover:** change where `support@…` mail is delivered from Zoho to Postmark; leave Zoho read-only until open tickets there close.

## 7. Staging (pre-prod rehearsal)

A rehearsal environment so a bad or **non-additive** migration (one already shipped — `db/migrations/20260619120000_drop_inert_feature_tables.sql`) fails in staging, not prod. Flow:

```
feature branch ──▶ staging   (Vercel staging deploy + migrate-staging.yml → Neon staging-branch DB)
                     │  verify green (health on the staging API host)
                     ▼
                   main       (prod auto-deploy; prod migrations apply at API-container boot on Dokploy)
```

This is **rehearsal-only** (the chosen scope): staging gives migrations a place to bake before they reach prod, where they apply at API-container boot (strictly ordered with the deploy — the server only starts after the migration pass succeeds).

**In-repo (this PR):** `.github/workflows/migrate-staging.yml` (applies migrations to the staging DB on push to `staging`, gated by the `staging` Environment) and the staging branches in `web/index.html` / `web/portal.html` API-base routing.

**Manual setup 👤 (staging goes live only after these):**
- [ ] 👤 **Neon:** create a **branch** database off prod (copy-on-write; scales to zero). Capture its pooled connection string.
- [ ] 👤 **GitHub:** create a **`staging` Environment** (Settings → Environments); add secret `DATABASE_URL` = the Neon staging-branch URL; restrict the environment to the **`staging`** branch (mirrors how `production` gates prod in `migrate.yml`).
- [ ] 👤 **Vercel (both projects, `maestro-desk` SPA + `maestro-desk-zjkl` API):** enable deploys for the `staging` branch and set its env vars **scoped to that branch/Preview**: `DATABASE_URL` = Neon staging branch; `APP_BASE_URL` = the staging **SPA** host (so the staging SPA's authenticated calls aren't CORS-blocked — see Notes/CORS); `BETTER_AUTH_URL` = the staging **API** host; plus `PORTAL_BASE_URL`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY`, `POSTMARK_INBOUND_SECRET`, `CRON_SECRET`, and the `R2_*` group (same required set as §3).
- [ ] 👤 **Confirm the staging hostnames.** The SPA routing scaffolds `maestro-desk-git-staging-jodi-1420s-projects.vercel.app` (SPA) → `maestro-desk-zjkl-git-staging-jodi-1420s-projects.vercel.app` (API), the standard Vercel git-branch pattern. After the first staging deploy, verify the actual URLs (Project → Deployments → `staging`) and update `STAGING_API` + the preview-host regex in `web/js/api-base.js` if they differ (or if you assign a custom staging alias) — the hostname logic lives there now, not in `index.html`/`portal.html`. If wrong, the staging SPA falls back to `localhost:3001` and login fails on **staging only**.
- [ ] 👤 **Create the long-lived `staging` branch** off `main` (after this merges, so it carries `migrate-staging.yml`): `git branch staging main && git push -u origin staging`.

**Then, per change:** open a PR → merge to `staging` → staging auto-deploys + `migrate-staging.yml` runs against the Neon branch → verify `GET <staging-api>/api/v1/health/ready` is green and smoke the change → merge `staging` → `main` (prod deploys + prod migrate as today).

## Notes
- **Background workers + Vercel:** already handled — the in-process workers are local-dev-only; on Vercel the same work runs via inline `waitUntil` (first webhook attempt) + Vercel Cron (`/api/v1/cron/*`, concurrency-safe). Going live just needs `CRON_SECRET` set in the Vercel env (see §3).
- **CORS:** the API restricts browser origins on authenticated routes to `APP_BASE_URL` + `localhost:5173` (`api/src/index.ts`); the public/portal API (`/api/v1/public/*`) stays open so white-label portals on verified custom domains keep working. So `APP_BASE_URL` must be set correctly in prod (`https://app.respovia.com`) and must match the host agents actually load, or the agent SPA's own API calls get blocked by CORS.
- The emailed reset/set-password token lands at `${APP_BASE_URL}/?reset_token=…`; the SPA strips it from the URL on load.
- Migrations are plain SQL in `db/migrations/`, applied with `bun run migrate`; validate on Docker PG 17 before pushing (see `CLAUDE.md`).
- Remaining migration steps after auth: **Step 5 (Pubby realtime)** and **Step 7 (cleanup)**. **Step 6 (Vercel + retire Fly)** is done in code — Fly artefacts removed, SPA/portal repointed, and the cron-driven background work is wired; the only Step-6 leftover is the operational `CRON_SECRET` + deploy.
