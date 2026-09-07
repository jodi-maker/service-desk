// Data-subject access / portability export for a customer (GDPR Art. 15 / 20).
//
// The inverse of erasure: gather every piece of the customer's personal data
// across the surfaces enumerated in `docs/gdpr-pii-inventory.md` into one
// structured, machine-readable bundle. Returns null if the customer doesn't
// exist in the workspace (caller → 404).
//
// Scoped by workspace_id throughout — no DB-level tenant guard, so every query
// carries the predicate.

import { getDb } from './db.js';
import { inboxFromThisCustomer } from './customer-contacts.js';

export interface CustomerExport {
  exported_at: string;
  // Provenance for the data subject: which brand/workspace held the data. The
  // internal workspace uuid is deliberately not exposed (cf. the stripped
  // customer.id).
  workspace: { name: string; slug: string };
  // erased_at is surfaced so the caller can distinguish a live record from one
  // whose PII has already been erased (mostly-null bundle).
  erased: boolean;
  customer: Record<string, unknown>;
  notes: Array<{ text: string; created_at: string }>;
  // Every address the subject holds (Phase 4 contacts model), primary flagged.
  contacts: Array<{ kind: string; value: string; is_primary: boolean; created_at: string }>;
  tickets: Array<Record<string, unknown> & { messages: Array<Record<string, unknown>>; attachments: Array<Record<string, unknown>> }>;
  inbox_messages: Array<Record<string, unknown>>;
}

export async function exportCustomer(args: {
  workspaceId: string;
  customerId: string;
}): Promise<CustomerExport | null> {
  const { workspaceId, customerId } = args;
  const sql = getDb();

  const [customer] = await sql<Record<string, unknown>[]>`
    select id, display_id, first_name, last_name, username, email, mobile, brand,
           vip_tier, jurisdiction, consent, kyc_status, since, backoffice_url,
           maestro_user_id, maestro_member_id,
           created_at, updated_at, erased_at
    from customers
    where id = ${customerId} and workspace_id = ${workspaceId}
  `;
  if (!customer) return null;

  const [ws] = await sql<{ name: string; slug: string }[]>`
    select name, slug from workspaces where id = ${workspaceId}
  `;

  const notes = await sql<{ text: string; created_at: string }[]>`
    select text, created_at from customer_notes
    where workspace_id = ${workspaceId} and customer_id = ${customerId}
    order by created_at asc
  `;

  // Contact rows — including any a merge re-homed onto a survivor (stamped
  // merged_from_customer_id = this customer): still this person's data, with
  // the primary flag they held before the merge.
  const contacts = await sql<{ kind: string; value: string; is_primary: boolean; created_at: string }[]>`
    select kind, value::text as value,
           case when merged_from_customer_id = ${customerId} then primary_before_merge else is_primary end as is_primary,
           created_at
    from customer_contacts
    where workspace_id = ${workspaceId}
      and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
      and (deleted_at is null or merged_from_customer_id = ${customerId})
    order by kind, created_at asc
  `;

  const tickets = await sql<Record<string, unknown>[]>`
    select id, display_id, subject, status_key, priority_key, category_key,
           csat_score, csat_comment, snooze_reason, last_inbound_email, created_at, updated_at, resolved_at
    from tickets
    where workspace_id = ${workspaceId} and customer_id = ${customerId}
    order by created_at asc
  `;
  const ticketIds = tickets.map((t) => t.id as string);

  // All messages for the customer's tickets in one query, grouped in JS.
  const messages = ticketIds.length
    ? await sql<Record<string, unknown>[]>`
        select ticket_id, role, author_label, body, body_html, created_at
        from ticket_messages
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
          and deleted_at is null
        order by created_at asc
      `
    : [];
  const byTicket = new Map<string, Array<Record<string, unknown>>>();
  for (const m of messages) {
    const key = m.ticket_id as string;
    if (!byTicket.has(key)) byTicket.set(key, []);
    // Drop the join key from the emitted message.
    const { ticket_id: _drop, ...rest } = m;
    byTicket.get(key)!.push(rest);
  }
  // Attachment METADATA (Art. 15 "categories of data"), not the files: the
  // export is a JSON document, and the bytes stay behind the private bucket's
  // presigned URLs. Erasure deletes both, so the two stay in step.
  const attachments = ticketIds.length
    ? await sql<Record<string, unknown>[]>`
        select ticket_id, filename, size_bytes, mime_type, is_inline, created_at
        from ticket_attachments
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
        order by created_at asc
      `
    : [];
  const attByTicket = new Map<string, Array<Record<string, unknown>>>();
  for (const a of attachments) {
    const key = a.ticket_id as string;
    if (!attByTicket.has(key)) attByTicket.set(key, []);
    const { ticket_id: _dropAtt, ...rest } = a;
    attByTicket.get(key)!.push(rest);
  }

  const ticketsWithMessages = tickets.map((t) => {
    const { id: _id, ...rest } = t;
    return {
      ...rest,
      messages: byTicket.get(t.id as string) ?? [],
      attachments: attByTicket.get(t.id as string) ?? [],
    };
  });

  // Inbound mail tied to this customer: converted into one of their tickets, or
  // sent from ANY email address they held at the time (still in the inbox) —
  // the contacts model accepts inbound from secondaries, a merged-away source's
  // scalar is null while its addresses live on the survivor, and an address
  // released here and adopted elsewhere must not leak the new holder's mail
  // into this bundle (inboxFromThisCustomer).
  const inbox = await sql<Record<string, unknown>[]>`
    select from_name, from_email, subject, body, body_html, received_at, status
    from inbox_messages
    where workspace_id = ${workspaceId}
      and (
        (${ticketIds.length ? sql`converted_ticket_id in ${sql(ticketIds)}` : sql`false`})
        or ${inboxFromThisCustomer(sql, workspaceId, customerId, customer.email as string | null)}
      )
    order by received_at asc
  `;

  // Strip the DB uuid from the emitted customer record (display_id is the
  // stable, non-internal identifier).
  const { id: _custId, ...customerOut } = customer;

  return {
    exported_at: new Date().toISOString(),
    workspace: { name: ws?.name ?? '', slug: ws?.slug ?? '' },
    erased: Boolean(customer.erased_at),
    customer: customerOut,
    notes,
    contacts,
    tickets: ticketsWithMessages,
    inbox_messages: inbox,
  };
}
