# GDPR PII Inventory — Respovia

> Wave 2 of the compliance build-out (`IMPLEMENTATION-PLAN.md` Phase 4). This is the
> **shared spec** for erasure, data-subject export, and retention — enumerate every
> column that holds personal data of a *player/customer* (the data subject) once, so
> each of those features covers the same surfaces and none is missed.
> Grounded in `db/migrations/` as of 2026-06-22; last updated 2026-09-02 (Maestro player
> ids on `customers`). Update when a new PII column lands.

A "data subject" here is a **customer** (player). Agent/operator accounts are users and
out of scope for customer erasure. The design intent (`20260520121300_gdpr.sql`): keep the
customer row + ticket rows so the audit trail and aggregate analytics survive, but **null /
redact the personal data** and stamp `customers.erased_at`.

## Surfaces

| Table | PII column(s) | Handling on erasure | Notes |
|---|---|---|---|
| `customers` | `first_name`, `last_name`, `username`, `email`, `mobile`, `backoffice_url`, `kyc_status`, `jurisdiction`, `maestro_user_id`, `maestro_member_id` | **null**; set `erased_at = now()` (also nulls `player_lookup_at`, the linker's throttle stamp, so nothing re-links an erased profile) | Row kept (FKs from tickets). `display_id`, `brand`, `vip_tier`, `since`, `consent` retained as non-identifying / preference. `maestro_user_id` / `maestro_member_id` (20260903100000) are the player's Maestro account identifiers, written by `lib/player-identity.ts` — direct identifiers, so erased and exported like `username`. `kyc_status` is no longer surfaced anywhere in the product (removed in Phase 4) but the column still exists and still holds values, so it stays on the erasure list until the drop migration lands — erasure is idempotent, so a subject erased while it was omitted would keep that value permanently. |
| `customer_contacts` | `value` (every email / mobile the customer holds, incl. secondaries) | **delete rows** for the customer | Phase 4 contacts model. Hard-deleted (not soft) so no address survives as PII; `customers.email`/`mobile` are a mirror of the primary row and are nulled above. A merged-away source is un-merged first (erase route), so its rows are back on it when this runs. Profile soft-delete (`DELETE /customers/:id`) soft-deletes these rows instead, freeing the address for reuse. |
| `customer_notes` | `text` (NOT NULL) | **delete rows** for the customer | Internal agent notes *about* the data subject — removed entirely. |
| `tickets` | `subject` (NOT NULL), `csat_comment`, `snooze_reason`, `last_inbound_email` | `subject → '[erased]'`; other listed fields → null | Row kept; status/category/timestamps retained for analytics. The last inbound sender is included in the data-subject export and cleared on erasure. |
| `ticket_messages` | `body` (NOT NULL), `author_label` | `body → '[erased]'`; `author_label → '[erased]'` only where `role = 'customer'` | Row kept (thread structure / audit). Agent/AI author labels are staff, not the data subject. |
| `inbox_messages` | `from_name`, `from_email`, `subject`, `body`, `body_html`, `raw` | **null** all | Matched by `converted_ticket_id ∈ customer's tickets` OR `from_email = customer.email`. |
| `gdpr_erasures` | — | **insert** the erasure record | `requested_by_user_id`, `completed_at`, `fields_erased[]`, `reason`. |

## Intentionally retained (by design)

- **`tickets` / `ticket_messages` rows** — kept (redacted) so the support history and the
  audit trail referencing the now-anonymous customer survive.
- **`events` / `audit_events`** — the activity/audit log; it references the anonymized
  customer, not their content. Player-data **reads** are now logged here too (a
  `player.viewed` audit event on every successful live player lookup — `routes/maestro.ts`
  + `lib/player-audit.ts`, categories not values), as is every automatic or agent-driven
  contact ↔ player link or repair of missing account details (`customer.player_linked`
  / `customer.player_refreshed` — `lib/player-identity.ts`; the brand id
  and data categories persisted, never the values or the player ids themselves). Profile
  edits from the details card (`customer.updated` — `PATCH /customers/:id`) follow the same
  rule: before/after values only for the non-identifying columns (`brand`, `vip_tier`, `since`,
  `consent`); the PII columns that changed are listed by field name alone. Still
  pending: append-only / tamper-evident hardening of `audit_events` (a follow-up).

## Attachments — `ticket_attachments` + the R2 objects

Inbound attachments are currently discarded (`lib/postmark.ts`) and uploads aren't wired,
so no attachment PII is stored today. The handling is nonetheless implemented so it's
correct the day upload ships:

- **Erasure** — `gdpr-erasure.ts` deletes the `ticket_attachments` rows for the customer's
  tickets (in-transaction), writes their `storage_key`s to the `pending_object_deletions`
  OUTBOX in that same transaction, and deletes the R2 objects after commit — clearing each
  key as it succeeds. A crash or R2 outage therefore always leaves a durable pointer, and
  `retryPendingObjectDeletions()` (run from the retention cron) finishes the job, so the
  outage self-heals. Erasures written before the outbox existed still carry their keys on
  `gdpr_erasures.pending_object_keys`; the same sweep drains that column too.
  ✅ implemented.
- **Retention** — the purge (`lib/retention.ts`) does exactly the same: `storage_key`s of
  every expiring ticket go to the outbox inside the delete transaction, objects are deleted
  after commit, and the cron retries whatever is left. ✅ implemented.
- **Stuck keys are visible** — each outbox row counts `attempts` and records `last_error`;
  the retention cron raises a critical ops alert when a key keeps failing, so a file that
  can never be deleted (bad token, wrong bucket) is not silently retained forever.
- **Storage** — attachments live in a separate PRIVATE bucket (`R2_ATTACHMENTS_BUCKET`)
  and are served only via short-lived presigned URLs minted inside authenticated ticket
  responses. Never the public brand-assets bucket.
- **DSAR export** — `gdpr-export.ts` does **not** yet include attachments. ⚠️ follow-up:
  add the attachment list/contents so Art.15/20 export matches what erasure removes.

The DSAR follow-up is gated on attachment upload actually shipping (no data exists until
then), but are tracked here so they aren't missed.

## Consumers of this inventory

- `feat/gdpr-erasure` — implemented in `api/src/lib/gdpr-erasure.ts` (this table is the contract).
- `feat/data-export` — DSAR export must surface every column above for the data subject.
- `feat/data-retention` — the purge job operates on the same tables (full delete past the
  retention window, vs. redaction here).
