# Respovia naming migration

Updated 2026-09-07. Local cleanup is on `fix/respovia-name-cleanup`; external services have not been renamed or deployed.

## Updated locally

The Maestro Connect manifest now declares the display name Respovia. The immutable `service-desk` slug and app/client IDs are preserved. Test email addresses, example database naming, remaining current-code product comments, and the README layout label use Respovia.

## Remaining identifiers requiring coordinated changes

| Reference | Why it remains | Safe completion path |
| --- | --- | --- |
| GitHub `Art-of-Technology/maestro-desk` | Existing repository identity used by services and runbooks | Inventory deployment/webhook/CI consumers; rename in GitHub, update remotes and consumers, then verify builds and deployments. |
| Local `C:/Users/Jodi/maestro-desk` | Active checkout referenced by Codex and local tooling | Close processes using the directory; move to `respovia`, update project registrations, global/project instructions and local tools together. |
| Vercel `maestro-desk-*` staging hosts | Actual routing destinations and CORS/CSP allowlists | Provision and verify replacement staging hosts first; update `web/js/api-base.js`, `api/src/lib/env.ts`, both CSP copies and CORS tests together. Retain old hosts during the transition, then remove after verification. Do not replace them with assumed addresses. |
| Maestro Connect display name | Local manifest changed; registered app has not been revised | Use the authenticated Maestro CLI to diff and submit the display-name revision; verify approval and login. Keep the app ID, client ID, `service-desk` slug, scopes and Maestro Connect platform names. |
| Database workspace branding | Real tenant data was not queried or changed | Identify the internal workspace by ID, verify its current name, and update only its display name. Do not rename customers' workspaces or authentication identities by string matching. |
| Old SQL migrations and demo emails | Applied schema history and old-value predicates used by migrations | Never rewrite applied migrations. Existing `20260720120000_rename_demo_channels_respovia.sql` already updates demo channel branding. Any further data change needs a new guarded migration and database validation. |
| Historic runbooks and rename notes | Record actual former names/hosts needed to understand or recover older environments | Retain historical labels. Update current operational instructions when the corresponding service changes. |

The deprecated `MAESTRO_API_BASE` browser override remains supported so existing embedded/self-hosted pages keep working. Maestro Connect is a separate platform, not another spelling of Respovia.

## Validation

20 targeted API tests pass, including legacy preview-origin acceptance/rejection and alert delivery. All 24 frontend routes and 7 demo ticket details render. Frontend bundle, bridge collision, import-completeness and header-sync checks pass. The smoke harness reports mocked HTTP warnings for saved searches and email signatures; no render failures occurred. Production service behavior was not tested or deployed by this cleanup.

API TypeScript typecheck and syntax checks for both edited PowerShell scripts also pass.
