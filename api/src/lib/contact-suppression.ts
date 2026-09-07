import { getDb } from './db.js';
import { ensurePrimaryContacts, syncPrimaryMirror } from './customer-contacts.js';

// customerId-only requests are the legacy API: reset the primary address only.
// A contactId request resets exactly that live email, never its siblings.
export async function resetContactSuppression(workspaceId: string, customerId: string, contactId?: string) {
  const sql = getDb();
  return sql.begin(async (tx) => {
    const [customer] = await tx<{ id: string; email: string | null; mobile: string | null }[]>`
      select id, email, mobile from customers
      where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
        and erased_at is null and merged_into_customer_id is null
      for update
    `;
    if (!customer) return null;
    await ensurePrimaryContacts(tx, { workspaceId, customerId, email: customer.email, mobile: customer.mobile });
    const [contact] = await tx<{ id: string; customer_id: string; is_primary: boolean }[]>`
      update customer_contacts
      set bounce_state = 'none', bounce_last_type = null, bounce_last_at = null, bounce_count = 0
      where workspace_id = ${workspaceId} and customer_id = ${customerId}
        and kind = 'email' and deleted_at is null
        and ${contactId ? tx`id = ${contactId}` : tx`is_primary`}
      returning id, customer_id, is_primary
    `;
    if (!contact) return null;
    await syncPrimaryMirror(tx, workspaceId, customerId);
    return contact;
  });
}
