-- Rich email bodies + real attachments (foundation).
--
-- ticket_messages.body_html: the SANITISED HTML of an email (inbound or an
-- agent's rich reply). Nullable — plain-text messages, notes and legacy rows
-- keep it null and the UI falls back to `body`. The raw inbound HTML still
-- lives on inbox_messages.body_html for re-sanitising later.
--
-- ticket_attachments gains what inline (cid:) images need:
--   content_id   the Content-ID the HTML references (we store OUR attachment
--                uuid there and rewrite the email's cid: to it on ingest)
--   is_inline    true when the file is referenced from body_html as an image
--   disposition  'inline' (magic-byte-verified raster image, may render in a
--                tab) or 'attachment' (everything else — always downloads)
-- Nothing writes these columns yet: the inbound/upload paths that populate
-- them and the orphan sweep for unclaimed uploads (message_id null, backed by
-- the partial index below) land in the follow-up PRs.
--
-- pending_object_deletions is the OUTBOX for R2 object deletes: the retention
-- purge and GDPR erasure insert the keys of the files they are removing INSIDE
-- the same transaction that drops the rows, then delete the objects after
-- commit and clear the outbox rows that succeeded. A crash or storage outage
-- between commit and delete therefore always leaves a durable pointer for the
-- retention cron to retry; attempts/last_error make a stuck key visible.

alter table ticket_messages add column if not exists body_html text;

alter table ticket_attachments
  add column if not exists content_id  text,
  add column if not exists is_inline   boolean not null default false,
  add column if not exists disposition text not null default 'attachment'
    check (disposition in ('inline', 'attachment'));

create index if not exists ticket_attachments_message_idx on ticket_attachments (message_id);
create index if not exists ticket_attachments_unclaimed_idx
  on ticket_attachments (created_at) where message_id is null;

create table if not exists pending_object_deletions (
  storage_key text primary key,
  reason      text not null,
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now()
);
