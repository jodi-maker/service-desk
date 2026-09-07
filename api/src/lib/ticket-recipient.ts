import { getDb } from './db.js';
import { ensurePrimaryContacts } from './customer-contacts.js';

export interface TicketRecipient {
  email: string;
  suppressed: boolean;
}

// The thread sender is usable only while it belongs to this ticket's customer.
// A removed/foreign address falls back to the primary; a suppressed address
// does NOT fall back (that would silently send the conversation elsewhere).
// Resolve in a short transaction, using the contacts model's customer-first
// lock order. Never keep the transaction open during the external mail send.
export async function resolveTicketRecipient(workspaceId: string, ticketId: string): Promise<TicketRecipient | null> {
  const sql = getDb();
  const result = await sql.begin(async (tx) => {
    const [customer] = await tx<{ id: string; email: string | null; mobile: string | null }[]>`
      select c.id, c.email, c.mobile from tickets t
      join customers c on c.id = t.customer_id and c.workspace_id = t.workspace_id
      where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
        and c.deleted_at is null and c.erased_at is null and c.merged_into_customer_id is null
      for update of c
    `;
    if (!customer) return null;
    await ensurePrimaryContacts(tx, { workspaceId, customerId: customer.id, email: customer.email, mobile: customer.mobile });
    const [recipient] = await tx<{ email: string; bounce_state: string }[]>`
      select cc.value::text as email, cc.bounce_state
      from tickets t
      join customer_contacts cc on cc.customer_id = t.customer_id and cc.workspace_id = t.workspace_id
      where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
        and t.customer_id = ${customer.id} and cc.kind = 'email' and cc.deleted_at is null
        and (cc.value = t.last_inbound_email or cc.is_primary)
      order by (cc.value = t.last_inbound_email) desc nulls last, cc.is_primary desc
      limit 1
    `;
    return recipient ? {
      email: recipient.email,
      suppressed: recipient.bounce_state === 'hard' || recipient.bounce_state === 'spam',
    } : null;
  });
  return result;
}
