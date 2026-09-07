-- Preserve the most recently accepted sender for contact-aware outbound mail.
-- Existing tickets keep primary-address delivery until another email arrives.
-- Additive: the previous API image can still run against this schema.
alter table tickets add column last_inbound_email citext;
