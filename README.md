# Respovia

An AI-native, multi-brand helpdesk for the iGaming space — a Zoho Desk rival built for
the Maestro Connect platform. Agents triage and resolve player tickets across channels
(email, web portal, Slack), assisted by AI for triage, drafting, summarisation,
translation, and sentiment.

The product is white-label and multi-tenant: a **God** operator manages brands, each
**Brand Owner** administers their own workspace, and **Agents** work the queue.

## Stack

| Layer | Tool |
|---|---|
| Frontend | Vanilla JS ES modules — **no framework, no bundler in production** |
| API | [Hono](https://hono.dev) on [Bun](https://bun.sh), TypeScript |
| Database | [Neon](https://neon.tech) serverless Postgres (raw SQL migrations, no ORM) |
| Auth | [Better Auth](https://better-auth.com) (owns its own tables in Neon) |
| File storage | Cloudflare R2 (S3-compatible, via `aws4fetch`) |
| Realtime | [Pubby](https://app.pubby.dev) (`@getpubby/sdk`, Pusher-compatible) |
| AI | Anthropic Claude (`@anthropic-ai/sdk`) |
| Hosting | Vercel — frontend and API are **two separate projects** |
| Scheduled jobs | Vercel Cron (Postgres queue table, no external queue) |

> **Migration note:** the project is mid-migration from Supabase to the Neon-based stack
> above. The `supabase/` directory contains legacy artefacts being phased out — new work
> targets Neon. See `migration/` for the step-by-step plan.

## Repo layout

```
respovia/
├── web/                  # Frontend SPA (Vercel Root Directory = "web")
│   ├── index.html        #   single module entry → js/app.js
│   ├── portal.html       #   customer-facing portal
│   ├── js/
│   │   ├── app.js        #   bootstrap only (login, layout, startup, window bridge)
│   │   ├── core/         #   router, state, data, api-client, realtime, modal, …
│   │   └── <feature>/    #   per-feature ES modules (tickets, customers, dashboard, ai, …)
│   └── styles/
├── api/                  # Backend (Vercel Root Directory = "api")
│   └── src/
│       ├── index.ts      #   Hono app (Vercel adapter entry)
│       ├── dev.ts        #   local Bun dev server (:3001)
│       ├── routes/       #   one file per resource (tickets, inbox, kb, god, …)
│       ├── lib/          #   db, auth, env, AI, integrations (Postmark, Slack, R2, …)
│       └── middleware/   #   auth + platform-admin authorization
├── db/migrations/        # Raw SQL migrations applied to Neon (timestamped)
├── scripts/              # CI smokes (bundle + render guards)
├── maestro.yml           # Maestro Connect integration manifest
└── .github/workflows/    # CI gates
```

The frontend and backend deploy as independent Vercel projects with non-overlapping Root
Directories, so neither builds the other. `web/` is served as the SPA root
(`web/js/app.js` → `/js/app.js`).

## Architecture notes

- **Single module entry.** `index.html` loads only `web/js/app.js` via
  `<script type="module">`. There are no classic `<script src>` tags for app code.
- **Routing** lives in `web/js/core/router.js` (`nav`, `renderPage`, the page registry);
  callers import it directly. `app.js` is bootstrap-only.
- **Shared state is import-based.** `web/js/core/state.js` (UI state) and
  `web/js/core/data.js` (seed/live data) export every binding; importers read them live.
  Mutable scalars are written through per-name `setX()` setters; const collections are
  mutated in place.
- **Events use `data-action` delegation** through `web/js/core/event-delegation.js` —
  no inline `on*=` handlers. Cross-module calls are direct ES imports.
- **Authorization lives in API middleware** (`api/src/middleware/`), not in the database.

## Local development

Prerequisites: [Bun](https://bun.sh) (CI pins **1.3.13**) and a Neon connection string.

```bash
# 1. Backend API — must be running first
cd api
bun install
cp .env.example .env          # fill in DATABASE_URL, auth, R2, Pubby, Anthropic keys
bun run migrate               # apply db/migrations to Neon
bun run dev                   # Hono dev server on http://localhost:3001

# 2. Frontend — static, no build step. Serve web/ with any static server, e.g.:
cd ../web
bunx serve .                  # (or any static file server)
```

> A "failed to fetch" error on the login page almost always means the API backend
> (`:3001`) isn't running — start it first.

## Testing & CI

`.github/workflows/ci.yml` runs the render guards on every PR. The frontend smokes
bundle the SPA with `bun build` (used **only** for CI — never to ship an artefact) and
exercise every route and ticket-detail render:

```bash
# Frontend guards
bun build web/js/app.js > scripts/app.bundled.js
bun scripts/bridge-collision-check.mjs                    # no duplicate bridge exports
# route smoke — every route renders; detail smoke — openTicket every demo ticket
# (see CLAUDE.md for the full smoke pipeline)

# Backend tests
cd api && bun test && bun run typecheck
```

> The smokes bundle into a single scope, so a *missing cross-module import* still
> resolves there but throws in production (native ESM). After import-migration work,
> verify import-completeness with a static audit. See `CLAUDE.md`.

## Deployment

Both projects deploy to Vercel:

- **Frontend** — static files from `web/`.
- **API** — Hono app wrapped with the Vercel adapter, served as a serverless function
  (Fluid Compute enabled for longer timeouts). Scheduled jobs run via Vercel Cron.

Neon is the production database; R2, Pubby, and Anthropic are reached via env-configured
credentials. See `PROD_SETUP.md` for the full production cutover runbook and `setup.md`
for environment setup.

## Maestro Connect integration

Respovia registers with Maestro Connect via `maestro.yml` (manifest v1), which
declares the integration's routes, data sources, and scopes. The identity model maps
Maestro **organizations** → tenants, **brands** → workspaces (a Desk workspace *is* a
Maestro brand), and **users** → the token-derived signed-in agent. Sign-in with Maestro
runs through Better Auth's `genericOAuth` (PKCE); see `api/src/lib/maestro.ts` and
`api/src/lib/maestro-workspace.ts`.

## Further reading

- `docs/getting-started.md` — using the product (agents, Brand Owners, platform operators).
- `docs/backup-recovery.md` — data durability, backup posture, and the restore runbook.
- `CLAUDE.md` — architecture deep-dive, CI gates, and conventions for contributors.
- `PROD_SETUP.md` — production setup and cutover runbook.
- `setup.md` — environment and local setup guide.
- `migration/` — Supabase → Neon migration plan and progress.
