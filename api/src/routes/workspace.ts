import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { brandAssetsStore, publicUrl } from '../lib/r2.js';
import { sniffImageMime } from '../lib/image-sniff.js';

// Migration to Neon — Step 3 (DB access on getDb(), admin gate via
// requireWorkspaceAdmin) + Step 4 (POST /branding/logo now stores the file in
// Cloudflare R2 instead of Supabase Storage). This route no longer touches
// Supabase at all.
export const workspace = new Hono();

workspace.use('*', requireAuth);

const SETTINGS_COLS = `id, name, slug, logo_url, primary_color,
  portal_tagline, portal_intro, portal_footer,
  portal_custom_domain, portal_custom_domain_token, portal_custom_domain_verified,
  ai_player_enrichment, retention_days`;

// ─── GET /settings ──────────────────────────────────────────────────────
workspace.get('/settings', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const [row] = await sql`select ${sql.unsafe(SETTINGS_COLS)} from workspaces where id = ${workspaceId}`;
  if (!row) return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ workspace: row });
});

const SettingsBody = z.object({
  logo_url:      z.string().url().nullable().optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, 'primary_color must be a hex like #8b5cf6').nullable().optional(),
  portal_tagline: z.string().max(100).nullable().optional(),
  portal_intro:   z.string().max(1000).nullable().optional(),
  portal_footer:  z.string().max(500).nullable().optional(),
  portal_custom_domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'Invalid hostname').max(253).nullable().optional(),
  // Opt-in to sending live player account data (balance/VIP/country) to the
  // LLM during triage. Default is false (data-minimising). AML is always excluded.
  ai_player_enrichment: z.boolean().optional(),
  // Data-retention window in days: resolved tickets older than this are purged.
  // Min 30 (foot-gun guard), max 100y; null disables automatic purge (legal hold).
  retention_days: z.number().int().min(30).max(36500).nullable().optional(),
}).strict();

// ─── POST /branding/logo — admin; Cloudflare R2 upload (Step 4) ───────────
// SVG is intentionally NOT allowed: it's active content (can carry <script>),
// and logos are served inline from the public R2 origin, so an SVG logo would
// be a stored-XSS vector. We also verify the file's MAGIC BYTES rather than the
// client-declared MIME, so a mislabeled payload can't be smuggled in (#6/#7).
const extByMime: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_BYTES = 2 * 1024 * 1024;

workspace.post('/branding/logo', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  // Coarse pre-filter: reject clearly-oversized uploads by Content-Length before
  // parseBody buffers the whole body into memory (advisory #11). This is the
  // multipart ENVELOPE (file bytes + boundary/part-headers), so it slightly
  // over-counts — a generous slack avoids false-rejecting a logo near the limit;
  // the post-parse file.size check below is the authoritative gate. Absent /
  // chunked (no header) falls through to that gate.
  const declaredLen = Number(c.req.header('content-length') || 0);
  if (declaredLen > MAX_BYTES + 8192) return c.json({ error: `File too large; max ${MAX_BYTES} bytes` }, 400);

  const form = await c.req.parseBody({ all: false }).catch(() => null);
  const file = form?.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'Missing file part' }, 400);
  if (file.size === 0) return c.json({ error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: `File too large; max ${MAX_BYTES} bytes` }, 400);

  // Trust the bytes, not file.type. Reject anything that isn't a real PNG/JPEG/WebP.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImageMime(bytes);
  if (!mime) return c.json({ error: 'Unsupported or mismatched image type (PNG, JPEG, or WebP only)' }, 400);

  // Random segment in the key so logo URLs aren't guessable/enumerable and two
  // uploads in the same millisecond can't collide (#19).
  const key = `${workspaceId}/logo-${Date.now()}-${crypto.randomUUID()}.${extByMime[mime]}`;
  try {
    await brandAssetsStore().putObject(key, bytes, { contentType: mime, contentDisposition: 'attachment' });
  } catch (err) {
    // Log the detail server-side (it can include the R2/S3 error body, which
    // may echo signing internals); return a generic message to the client.
    console.error('[workspace-branding] R2 upload failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Upload failed' }, 500);
  }

  // Best-effort cleanup of older files under this workspace's prefix.
  try {
    const store = brandAssetsStore();
    const stale = (await store.listKeys(`${workspaceId}/`)).filter((k) => k !== key);
    await store.deleteKeys(stale);
  } catch (err) {
    console.warn('[workspace-branding] cleanup failed:', err instanceof Error ? err.message : err);
  }

  const logoUrl = publicUrl(key);
  await sql`update workspaces set logo_url = ${logoUrl} where id = ${workspaceId}`;
  return c.json({ logo_url: logoUrl }, 201);
});

// ─── PATCH /settings — admin ────────────────────────────────────────────
workspace.patch('/settings', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = SettingsBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  // Changing portal_custom_domain rotates the verification state.
  const updates: Record<string, unknown> = { ...parsed.data };
  if ('portal_custom_domain' in parsed.data) {
    const incoming = parsed.data.portal_custom_domain ? parsed.data.portal_custom_domain.trim().toLowerCase() : null;
    updates.portal_custom_domain = incoming;
    updates.portal_custom_domain_token    = incoming === null ? null : generateDomainToken();
    updates.portal_custom_domain_verified = false;
  }

  try {
    const [row] = await sql`
      update workspaces set ${sql(updates)}
      where id = ${workspaceId}
      returning ${sql.unsafe(SETTINGS_COLS)}
    `;
    if (!row) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ workspace: row });
  } catch (err) {
    if ((err as any)?.code === '23505') {
      return c.json({ error: 'That hostname is already claimed by another workspace' }, 409);
    }
    throw err;
  }
});

// ─── POST /domain/verify — admin; resolve TXT record + flip verified ──────
workspace.post('/domain/verify', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const [ws] = await sql`
    select portal_custom_domain, portal_custom_domain_token from workspaces where id = ${workspaceId}
  `;
  if (!ws?.portal_custom_domain || !ws?.portal_custom_domain_token) {
    return c.json({ error: 'No custom domain configured' }, 400);
  }

  const recordName = `_maestro-verify.${ws.portal_custom_domain}`;
  let txtValues: string[][];
  try {
    const dns = await import('node:dns/promises');
    txtValues = await dns.resolveTxt(recordName);
  } catch (err: any) {
    const code = err?.code || 'UNKNOWN';
    return c.json({
      verified: false,
      reason: code === 'ENOTFOUND' || code === 'ENODATA' ? 'no_txt_record' : `dns_error:${code}`,
      record_name: recordName,
      expected_value: ws.portal_custom_domain_token,
    });
  }
  const flat = txtValues.flat();
  if (!flat.includes(ws.portal_custom_domain_token)) {
    return c.json({
      verified: false, reason: 'mismatch', record_name: recordName,
      expected_value: ws.portal_custom_domain_token, found_values: flat,
    });
  }

  await sql`update workspaces set portal_custom_domain_verified = true where id = ${workspaceId}`;
  return c.json({ verified: true });
});

// ─── Layouts (Phase 4, PR 3) ────────────────────────────────────────────
//
// Persists the admin Layouts screen (field visibility/required + order).
// This comment block is THE scope ↔ client-entity mapping — the client's
// SCOPE_FOR_ENTITY in web/js/layouts/index.js mirrors it:
//   ticket_form     ↔ FIELD_LAYOUTS.ticket   (new-ticket form fields)
//   customer_fields ↔ FIELD_LAYOUTS.customer (customer profile card fields)
//   customer_areas  ↔ profile page AREAS     (reserved for the area-reorder PR)
//
// Rows are DENSE per scope: PUT replaces the scope's full desired set (same
// reasoning as the Maestro manifest families — partial arrays are where
// hand-rolled diffing goes wrong). An empty `elements` array clears the scope
// back to code defaults. sort_order is the array index, so order is exactly
// what the client sent. Element keys are NOT validated against the client's
// code list — the server doesn't know it, and unknown keys reading as visible
// is the client's documented fallback for fields added later.
const LAYOUT_SCOPES = ['ticket_form', 'customer_fields', 'customer_areas'] as const;
type LayoutScope = (typeof LAYOUT_SCOPES)[number];

const LayoutElement = z.object({
  element_key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'element_key must be alphanumeric/_/-'),
  visible:     z.boolean(),
  required:    z.boolean(),
}).strict()
  // The Layouts screen's invariant pair ("hiding clears required, requiring
  // forces visible") collapses server-side to one rule: a hidden element can
  // never be required. Held here so it's true regardless of client.
  .refine((e) => e.visible || !e.required, { message: 'A hidden element cannot be required' });

const LayoutsBody = z.object({
  elements: z.array(LayoutElement).max(200),
}).strict().superRefine((body, ctx) => {
  const seen = new Set<string>();
  for (const e of body.elements) {
    if (seen.has(e.element_key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate element_key: ${e.element_key}` });
    }
    seen.add(e.element_key);
  }
});

// Any authenticated member — agents need the layout to render forms.
workspace.get('/layouts', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const layouts = await sql`
    select scope, element_key, visible, required, sort_order
    from workspace_layouts
    where workspace_id = ${workspaceId}
    order by scope, sort_order
  `;
  return c.json({ layouts });
});

workspace.put('/layouts/:scope', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const scopeParam = c.req.param('scope');
  if (!(LAYOUT_SCOPES as readonly string[]).includes(scopeParam)) {
    return c.json({ error: 'Unknown layout scope' }, 404);
  }
  const scope = scopeParam as LayoutScope;   // earned: membership checked above

  const reqBody = await c.req.json().catch(() => null);
  const parsed = LayoutsBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  // Mirrors the table's check constraint — page areas have no input to fill,
  // so 'required' is meaningless for them.
  if (scope === 'customer_areas' && parsed.data.elements.some((e) => e.required)) {
    return c.json({ error: "'required' is not valid for customer_areas elements" }, 400);
  }

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = parsed.data.elements.map((e, i) => ({
    workspace_id: workspaceId,
    scope,
    element_key:  e.element_key,
    visible:      e.visible,
    required:     e.required,
    sort_order:   i,
  }));

  try {
    await sql.begin(async (tx) => {
      // Serialize concurrent writers per (workspace, scope): under READ
      // COMMITTED, a delete+insert interleave can miss the other txn's fresh
      // rows and collide on the unique index instead of replacing them.
      await tx`select pg_advisory_xact_lock(hashtext(${`${workspaceId}:${scope}`}))`;
      await tx`delete from workspace_layouts where workspace_id = ${workspaceId} and scope = ${scope}`;
      if (rows.length) {
        await tx`insert into workspace_layouts ${tx(rows, 'workspace_id', 'scope', 'element_key', 'visible', 'required', 'sort_order')}`;
      }
    });
  } catch (err) {
    if ((err as any)?.code === '23505') {
      return c.json({ error: 'The layout was changed by another request — retry' }, 409);
    }
    throw err;
  }

  return c.json({ ok: true, count: rows.length });
});

function generateDomainToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'maestro-verify-' + Buffer.from(bytes).toString('base64url');
}
