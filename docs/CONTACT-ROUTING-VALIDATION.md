# Contact email routing — validation and rollout

## Behaviour

Agent replies, AI replies and CSAT surveys share a recipient resolver. The last
inbound sender wins only while it is a live email contact of the ticket's current
customer in the same workspace. Otherwise the primary email is used. A selected
hard-bounced/spam address suppresses delivery; it does not trigger a fallback.

The additive migration leaves existing tickets on primary-address delivery until
another inbound email arrives. Accepted threaded replies update the stored address;
deduplicated redeliveries do not. Export includes the stored address and erasure
clears it. Phone numbers and existing compatibility columns are retained.

## Evidence — 7 September 2026

- Fresh PostgreSQL 17 database: all 84 migrations applied through Node/tsx;
  rerunning with Bun was a no-op.
- Backend typecheck and all 542 tests passed. New coverage includes agent/AI/CSAT
  recipients, per-address suppression, removed/reassigned addresses, merge/unmerge,
  export/erasure, cross-workspace denial, concurrent bounce counts, stale events,
  inbound address refresh and retry deduplication.
- Frontend build, import audit, bridge check, header sync, 24 route renders and
  7 ticket-detail renders passed.
- Native-module browser check with mocked API responses: switching workspaces
  clears the suppression list; a late response from the previous workspace is
  ignored; resetting a secondary address removes only its row and badge, preserving
  the primary's suppression badge.

## Review

Manual code/security review scoped to this change checked workspace predicates,
admin-only resets, parameterised SQL, escaping, address ownership, lock order,
compatibility and erasure/export coverage. Findings corrected before PR creation:

- Keep the old primary-only suppression list for cached clients. The updated UI
  opts into a separate contact-aware list and reset endpoint.
- Scope suppression UI state and asynchronous responses to login/workspace.
- Serialize bounce/reset writes with contact edits; increment from current rows
  and prevent delayed soft events from downgrading suppression.
- Ignore bounce timestamps predating the contact's ownership of an address.

No new dependencies or credentials. Gitleaks and Semgrep are unavailable in this
environment; this is a focused manual review and regression test pass, not a
repository-wide scanner audit. Octopus review is a separate pre-merge gate.

## Rollout and outstanding acceptance

Deploy the API first (boot applies the additive migration), then the frontend.
Older frontend clients retain primary-only suppression controls. An API rollback
can keep the added nullable column; do not drop it as part of rollback.

Real mailbox delivery and attachment download have not been verified by these
mocked tests. Use an explicitly designated test mailbox to exercise incoming
formatted email + file, thread matching, an outgoing reply + file, and a survey.
Do not mark the complete email walkthrough done until recipient-side evidence is
recorded. Cloudflare browser-cache configuration remains a separate pending item.
