# Respovia delivery plan — 7 September 2026

Approved by Jodi in the current Codex conversation. This supersedes the remaining
work sequence in Claude's August update plan and the older IMPLEMENTATION-PLAN.md.
Completed work is not reopened. Each change uses a feature branch, validation,
code review and the repository's Octopus 4+/5 gate before merge.

## 1. Reliability first

- [ ] Make Cloudflare respect the origin's browser cache headers for the app.
  Verify the public JavaScript and CSS responses; already-cached browsers may
  still need a hard refresh. Do not change unrelated zone settings.
- [x] Return PostgreSQL DATE values as YYYY-MM-DD strings, preserving timestamp
  behaviour. Cover out-of-office assignment boundaries, agent API responses,
  customer dates and holiday arrays with database-backed regression tests.
  PR #472 merged; deployment reported complete by Jodi on 7 September 2026.

## 2. Finish the email journey and profile contact routing

- [ ] Reply to the customer's address used by the thread, falling back to their
  primary address only when appropriate. Track bounces per contact address.
  Recheck removed addresses, merges/unmerges and workspace isolation.
  Implemented in PR #473; review and deployment pending. Acceptance evidence:
  [CONTACT-ROUTING-VALIDATION.md](CONTACT-ROUTING-VALIDATION.md).
- [ ] Verify an incoming formatted email and attachment through customer/thread
  matching, agent reply and recipient download. Include multiple addresses and
  a bounced address. Use a designated test account/recipient for real emails.
- [ ] Give saved response templates the existing rich-text editor, with supported
  formatting, images and variable insertion. Verify sanitisation, plain-text
  fallback and existing templates; the email composer alone does not finish this.

## 3. URL navigation

- [ ] Add ticket/profile deep links, refresh restoration and Back/Forward.
  Preserve the destination through login; resolve workspace context and enforce
  access on every load. Handle missing/deleted records without exposing data.

## 4. Profile follow-ups and safe database cleanup

- [ ] Resolve the sticky profile card observer cleanup before player lookup.
- [ ] Inventory all uses of obsolete customer columns before removing reads.
  Preserve phone numbers in customer_contacts and explicitly retire any scalar
  mirrors only after their dependencies are gone.
- [ ] Ship read removal before destructive migrations; verify compatibility and
  the rollback window before dropping columns. Keep erasure/export coverage
  until stored personal data is actually removed.

## 5. Agent acceptance walkthrough

- [ ] Create a ticket; save/resume a draft; send a formatted reply and attachment.
- [ ] Edit a profile and contact addresses; merge and unmerge customers.
- [ ] Switch brands; open shared links; refresh and use Back/Forward.
- [ ] Check out-of-office assignment and visibility of a deployed update.

The expanded risk display stays deferred until Maestro supplies the necessary
data. Shared drag handling and test-helper extraction are optional maintenance,
not prerequisites for completing the agent workflows.

## Adversarial plan review

The sequence prioritises existing reliability defects. A database DATE parser
also affects holiday arrays and customer dates, so test those while keeping
timestamp parsing unchanged. Cloudflare configuration requires verified access;
origin headers already request revalidation. Removing a mirror column is not
equivalent to removing the underlying customer information. An email feature is
not accepted solely because its component tests pass: the full delivery and
attachment flow needs evidence. No production deployment is claimed by a merge.
