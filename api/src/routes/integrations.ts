import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { getDb } from '../lib/db.js';
import { assertSafeWebhookUrl } from '../lib/ssrf.js';
import { resetContactSuppression } from '../lib/contact-suppression.js';

// Migration to Neon — Step 3. Workspace-scoped via getDb(). Listing (GET) is
// member-level (reads expose only a token suffix + non-secret config), but all
// WRITES are admin-only via requireWorkspaceAdmin: integration config is an
// admin surface, and an unguarded write lets a non-admin repoint a webhook URL
// (exfiltrating customer payloads), rotate secrets, or wipe integrations.
export const integrations = new Hono();

integrations.use('*', requireAuth);

// postgres.js upsert helper: insert the row, on (workspace_id) conflict update
// all of the row's columns except workspace_id. `table` is a literal union —
// only this table can ever be passed (no caller-supplied table names).
type IntegrationTable = 'slack_integrations';
function upsertByWorkspace(sql: ReturnType<typeof getDb>, table: IntegrationTable, row: Record<string, unknown>) {
  const updateKeys = Object.keys(row).filter((k) => k !== 'workspace_id');
  return sql`insert into ${sql(table)} ${sql(row)} on conflict (workspace_id) do update set ${sql(row, ...updateKeys)}`;
}

// ─── Slack integration (one per workspace) ──────────────────────────────
const EVENT_NAMES = ['ticket.created', 'ticket.resolved', 'ticket.escalated', 'priority.urgent'] as const;

const SlackBody = z.object({
  webhook_url:    z.string().url().refine(
    (u) => { try { const p = new URL(u); return p.protocol === 'https:' && p.host === 'hooks.slack.com'; } catch { return false; } },
    'must be a https://hooks.slack.com/ URL',
  ),
  channel:        z.string().max(80).nullable().optional(),
  active:         z.boolean().optional(),
  events:         z.array(z.enum(EVENT_NAMES)).min(1).max(EVENT_NAMES.length),
  bot_token:      z.string().regex(/^xoxb-[\w-]+$/, 'Bot token must start with xoxb-').nullable().optional(),
  signing_secret: z.string().min(16).max(200).nullable().optional(),
}).strict();

integrations.get('/slack', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const [data] = await sql`
    select webhook_url, channel, active, events, bot_token, signing_secret, created_at, updated_at
    from slack_integrations where workspace_id = ${workspaceId}
  `;
  if (!data) return c.json({ integration: null });
  const { bot_token, signing_secret, ...rest } = data;
  return c.json({
    integration: {
      ...rest,
      bot_token_suffix:   bot_token ? bot_token.slice(-6) : null,
      has_bot_token:      Boolean(bot_token),
      has_signing_secret: Boolean(signing_secret),
    },
  });
});

integrations.put('/slack', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = SlackBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  // bot_token / signing_secret: undefined = "don't touch", null = "clear".
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    webhook_url:  input.webhook_url,
    channel:      input.channel ?? null,
    active:       input.active ?? true,
    events:       input.events,
  };
  if (input.bot_token !== undefined)      row.bot_token      = input.bot_token;
  if (input.signing_secret !== undefined) row.signing_secret = input.signing_secret;
  await upsertByWorkspace(sql, 'slack_integrations', row);
  return c.json({ ok: true });
});

integrations.delete('/slack', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  await sql`delete from slack_integrations where workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

// ─── Outgoing webhooks (multiple per workspace) ─────────────────────────
const OUTGOING_EVENTS = ['ticket.created', 'ticket.resolved', 'ticket.escalated', 'priority.urgent'] as const;

const WebhookBody = z.object({
  name:   z.string().min(1).max(100),
  url:    z.string().url(),
  events: z.array(z.enum(OUTGOING_EVENTS)).min(1).max(OUTGOING_EVENTS.length),
  active: z.boolean().optional(),
}).strict();

integrations.get('/webhooks', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, name, url, events, active, last_delivery_at, last_delivery_status, last_delivery_error, created_at
    from workspace_webhooks where workspace_id = ${workspaceId}
    order by created_at desc
  `;
  return c.json({ webhooks: rows });
});

integrations.post('/webhooks', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = WebhookBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

  try {
    await assertSafeWebhookUrl(parsed.data.url);
  } catch {
    return c.json({ error: 'URL resolves to a disallowed (private/internal) address' }, 400);
  }

  const secret = generateWebhookSecret();
  const [data] = await sql`
    insert into workspace_webhooks (workspace_id, name, url, secret, events, active)
    values (${workspaceId}, ${parsed.data.name}, ${parsed.data.url}, ${secret}, ${parsed.data.events}, ${parsed.data.active ?? true})
    returning id, name, url, events, active, created_at
  `;
  // First-and-only reveal of the raw secret.
  return c.json({ webhook: data, secret }, 201);
});

const PatchWebhookBody = z.object({
  name:          z.string().min(1).max(100).optional(),
  url:           z.string().url().optional(),
  events:        z.array(z.enum(OUTGOING_EVENTS)).min(1).max(OUTGOING_EVENTS.length).optional(),
  active:        z.boolean().optional(),
  rotate_secret: z.boolean().optional(),
}).strict();

integrations.patch('/webhooks/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchWebhookBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const { rotate_secret, ...fields } = parsed.data;
  if (Object.keys(fields).length === 0 && !rotate_secret) return c.json({ error: 'No fields to update' }, 400);

  if (fields.url !== undefined) {
    try {
      await assertSafeWebhookUrl(fields.url);
    } catch {
      return c.json({ error: 'URL resolves to a disallowed (private/internal) address' }, 400);
    }
  }

  const updates: Record<string, unknown> = { ...fields };
  let revealedSecret: string | null = null;
  if (rotate_secret) {
    revealedSecret = generateWebhookSecret();
    updates.secret = revealedSecret;
  }

  const [data] = await sql`
    update workspace_webhooks set ${sql(updates)}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, name, url, events, active, last_delivery_at, last_delivery_status, last_delivery_error, created_at
  `;
  if (!data) return c.json({ error: 'Webhook not found' }, 404);
  return c.json(revealedSecret ? { webhook: data, secret: revealedSecret } : { webhook: data });
});

integrations.delete('/webhooks/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  await sql`delete from workspace_webhooks where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

integrations.get('/webhooks/:id/deliveries', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const rows = await sql`
    select id, event, attempts, state, last_status, last_error, last_attempt_at, next_attempt_at, created_at
    from webhook_deliveries
    where webhook_id = ${id} and workspace_id = ${workspaceId}
    order by created_at desc
    limit 50
  `;
  return c.json({ deliveries: rows });
});

integrations.post('/webhooks/:id/deliveries/:deliveryId/retry', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const webhookId = c.req.param('id');
  const deliveryId = c.req.param('deliveryId');

  const [existing] = await sql`
    select id, state from webhook_deliveries
    where id = ${deliveryId} and webhook_id = ${webhookId} and workspace_id = ${workspaceId}
  `;
  if (!existing) return c.json({ error: 'Delivery not found' }, 404);
  if (existing.state !== 'exhausted') {
    return c.json({ error: `Only exhausted deliveries can be re-queued; this one is ${existing.state}` }, 409);
  }

  await sql`
    update webhook_deliveries
    set state = 'pending', attempts = 0, next_attempt_at = now(), last_status = null, last_error = null
    where id = ${deliveryId}
  `;
  return c.json({ ok: true });
});

// ─── Postmark suppression list ──────────────────────────────────────────
async function suppressedEmails(workspaceId: string, primaryOnly: boolean) {
  const sql = getDb();
  return sql`
    select c.id, cc.id as contact_id, c.display_id, c.first_name, c.last_name,
           cc.value::text as email, cc.bounce_state as email_bounce_state,
           cc.bounce_last_type as email_last_bounce_type, cc.bounce_last_at as email_last_bounce_at,
           cc.bounce_count as email_bounce_count
    from customer_contacts cc
    join customers c on c.id = cc.customer_id and c.workspace_id = cc.workspace_id
    where cc.workspace_id = ${workspaceId} and cc.kind = 'email'
      and cc.bounce_state in ('hard', 'spam') and cc.deleted_at is null
      and c.deleted_at is null and c.erased_at is null and c.merged_into_customer_id is null
      and (${!primaryOnly} or cc.is_primary)
    union all
    select c.id, null::uuid as contact_id, c.display_id, c.first_name, c.last_name,
           c.email::text, c.email_bounce_state, c.email_last_bounce_type,
           c.email_last_bounce_at, c.email_bounce_count
    from customers c
    where c.workspace_id = ${workspaceId} and c.deleted_at is null and c.erased_at is null
      and c.merged_into_customer_id is null and c.email is not null
      and c.email_bounce_state in ('hard', 'spam')
      and not exists (select 1 from customer_contacts cc where cc.customer_id = c.id
        and cc.workspace_id = ${workspaceId} and cc.kind = 'email' and cc.deleted_at is null)
    order by email_last_bounce_at desc
    limit 200
  `;
}

// Cached/older clients can reset only a customer's primary address. Preserve
// that list contract; the contact-aware UI explicitly opts into the new list.
integrations.get('/postmark/suppressed', async (c) => {
  return c.json({ suppressed: await suppressedEmails(c.get('workspaceId'), true) });
});

integrations.get('/postmark/suppressed/contacts', async (c) => {
  return c.json({ suppressed: await suppressedEmails(c.get('workspaceId'), false) });
});

integrations.post('/postmark/suppressed/:customerId/reset', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('customerId');
  if (!z.string().uuid().safeParse(customerId).success) return c.json({ error: 'Invalid customer ID' }, 400);
  const contact = await resetContactSuppression(workspaceId, customerId);
  if (!contact) return c.json({ error: 'Customer email not found' }, 404);
  return c.json({ ok: true, customer: { id: customerId, email_bounce_state: 'none' }, contact });
});

integrations.post('/postmark/suppressed/:customerId/contacts/:contactId/reset', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const { customerId, contactId } = c.req.param();
  if (!z.string().uuid().safeParse(customerId).success || !z.string().uuid().safeParse(contactId).success) {
    return c.json({ error: 'Invalid customer or contact ID' }, 400);
  }
  const contact = await resetContactSuppression(c.get('workspaceId'), customerId, contactId);
  if (!contact) return c.json({ error: 'Customer email not found' }, 404);
  return c.json({ ok: true, contact });
});

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}
