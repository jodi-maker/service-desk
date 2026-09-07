// Workspace data bootstrap.
//
// Called after a real-auth sign-in (or auto-resume) succeeds. Parallel-
// fetches tickets, customers, agents from the API and mutates the existing
// data.js global arrays in place to match the data.js view-model shape.
//
// Why mutate in place: ~60 modules import TICKETS / CUSTOMERS / AGENTS from
// core/data.js as live bindings, and a `const` export can't be reassigned
// anyway. Mutating preserves the array identity so callers see the new contents
// on their next render.
//
// Demo persona flow doesn't call this — it relies on data.js's seed data.
//
// Future PRs: SLA_POLICIES, TAG_LIBRARY, KB_ARTICLES,
// CHANNELS, ROLES, CANNED_RESPONSES, TICKET_TEMPLATES, CUSTOM_FIELDS,
// ASSIGN_RULES are still seeded from data.js. Each migrates per-feature.

import { AGENTS, ASSIGN_RULES, CANNED_RESPONSES, CATEGORIES, CHANNELS, CUSTOMERS, CUSTOM_FIELDS, KB_ARTICLES, ROLES, SLA_POLICIES, TAG_LIBRARY, TICKETS, TICKET_TEMPLATES } from './data.js';
import { apiGet } from './api-client.js';
import { hydrateLayouts } from '../layouts/index.js';

// Tickets pagination state. Bootstrap loads the first page; the SPA's
// "Load more" button (and any future infinite scroll) pulls the next.
// Demo persona doesn't paginate — its TICKETS array stays whatever
// data.js seeded.
//
// PAGE_SIZE is small enough that the demo workspace's 15-20 tickets
// trip the "Load more" button visibly (so the UI gets exercised). A
// real deployment would bump this to 50-100.
export const TICKETS_PAGE_SIZE = 10;
let _ticketsTotal  = 0;
let _ticketsOffset = 0;
let _ticketsPagingFor = null;  // workspace_id string — reset on workspace switch

export function ticketsTotal()       { return _ticketsTotal; }
export function ticketsLoaded()      { return TICKETS.length; }
export function ticketsHasMore()     { return _ticketsOffset < _ticketsTotal; }

export async function loadMoreTickets() {
  if (!ticketsHasMore()) return 0;
  const res = await apiGet(`/api/v1/tickets?limit=${TICKETS_PAGE_SIZE}&offset=${_ticketsOffset}`);
  const rawNew = res.tickets || [];
  // Build the joins map from the freshly-loaded customers + agents
  // (already in CUSTOMERS / AGENTS by this point — set by the initial
  // bootstrap before any "load more" can fire).
  const customerByUuid = Object.fromEntries(CUSTOMERS.map((c) => [c._uuid || c.id, c]));
  const userByUuid     = Object.fromEntries(AGENTS.map((a) => [a.userId, a]));
  const ticketByUuid   = Object.fromEntries(TICKETS.map((t) => [t._uuid, t]));
  const newMapped = rawNew.map((t) => mapTicket(t, customerByUuid, userByUuid));
  // Wire merge pointers within the loaded set + back into existing ones.
  for (const m of newMapped) {
    if (m._mergedIntoUuid) {
      const parent = ticketByUuid[m._mergedIntoUuid] || newMapped.find((x) => x._uuid === m._mergedIntoUuid);
      if (parent) {
        m.mergedInto = parent.id;
        parent.mergedFrom.push(m.id);
      }
    }
  }
  for (const m of newMapped) TICKETS.push(m);
  _ticketsOffset += newMapped.length;
  _ticketsTotal   = res.total ?? _ticketsTotal;
  return newMapped.length;
}

// Build the customer + user lookup maps once per batch so a 50-row
// sync response doesn't rebuild them 50 times. updateOrInsertTicket
// accepts the result via its optional second arg; if absent it
// rebuilds (back-compat for one-off call sites).
export function buildTicketLookups() {
  return {
    customerByUuid: Object.fromEntries(CUSTOMERS.map((c) => [c._uuid || c.id, c])),
    userByUuid:     Object.fromEntries(AGENTS.map((a)    => [a.userId, a])),
  };
}

// Merge a raw ticket row from the API (list shape) into the local
// TICKETS array. Three outcomes:
//
//   - row.deleted_at set + ticket exists locally → splice out, return true
//   - ticket exists locally → mutate in place (preserve _detailLoaded,
//     msgs/tags/aiTags/timeEntries/csat populated by loadTicketDetail —
//     these come from a richer endpoint than /sync returns), return true
//   - ticket new → map via mapTicket + unshift to front, return true
//
// Returns false when nothing changed (e.g., a deleted_at row for a
// ticket we don't have locally). Caller uses the return value to decide
// whether a re-render is worth firing.
export function updateOrInsertTicket(row, lookups) {
  if (!row || !row.id) return false;
  const { customerByUuid, userByUuid } = lookups || buildTicketLookups();

  const idx = TICKETS.findIndex((x) => x._uuid === row.id);

  if (row.deleted_at) {
    if (idx === -1) return false;
    TICKETS.splice(idx, 1);
    return true;
  }

  if (idx === -1) {
    TICKETS.unshift(mapTicket(row, customerByUuid, userByUuid));
    return true;
  }

  // Update in place. Only mutate fields the list endpoint actually
  // returns + that may change server-side; leave detail-loaded
  // collections (msgs/tags/aiTags/timeEntries/csat) alone — those
  // refresh through loadTicketDetail on the detail view's own path.
  const t = TICKETS[idx];
  t.subject       = row.subject;
  t.status        = row.status_key;
  t.priority      = row.priority_key;
  t.category      = labelCase(row.category_key) || 'Other';
  t.agent         = row.assigned_user_id == null ? '' : (userByUuid[row.assigned_user_id]?.name || t.agent);
  t.customerId    = customerByUuid[row.customer_id]?.id || customerByUuid[row.customer_id]?.display_id || t.customerId;
  t.updated       = fmtRelative(row.updated_at);
  t.sla           = row.sla_state || 'ok';
  t.snoozedUntil  = row.snoozed_until  || null;
  t.snoozedAt     = row.snoozed_at     || null;
  t.snoozeReason  = row.snooze_reason  || null;
  t.snoozeWokenAt = row.snooze_woken_at || null;
  t.mergedAt      = row.merged_at      || null;
  t._statusBeforeMerge = row.status_before_merge || null;
  t.sentiment     = row.latest_customer_sentiment || null;
  // Role of the latest message — drives the "new customer response" notification
  // (awaiting reply when this is 'customer'). Changes server-side as the thread
  // grows, so it must update on the delta path.
  t.lastMessageRole = row.last_message_role || null;
  // mergedInto display_id resolves from the uuid + current TICKETS state
  if (row.merged_into_id) {
    const parent = TICKETS.find((x) => x._uuid === row.merged_into_id);
    if (parent) t.mergedInto = parent.id;
  } else {
    t.mergedInto = null;
  }
  return true;
}

// Mapping helper extracted so loadMoreTickets and the initial bootstrap
// share the exact same shape.
function mapTicket(t, customerByUuid, userByUuid) {
  return {
    _uuid:           t.id,
    _detailLoaded:   false,
    id:              t.display_id,
    subject:         t.subject,
    customerId:      customerByUuid[t.customer_id]?.id || customerByUuid[t.customer_id]?.display_id || null,
    status:          t.status_key,
    priority:        t.priority_key,
    category:        labelCase(t.category_key) || 'Other',
    agent:           userByUuid[t.assigned_user_id]?.name || '',
    created:         isoDate(t.created_at),
    updated:         fmtRelative(t.updated_at),
    sla:             t.sla_state || 'ok',
    snoozedUntil:    t.snoozed_until || null,
    snoozedAt:       t.snoozed_at    || null,
    snoozeReason:    t.snooze_reason || null,
    snoozeWokenAt:   t.snooze_woken_at || null,
    _mergedIntoUuid: t.merged_into_id || null,
    mergedInto:      null,
    mergedAt:        t.merged_at || null,
    mergedFrom:      [],
    _statusBeforeMerge: t.status_before_merge || null,
    tags:            [],
    aiTags:          [],
    csat:            null,
    msgs:            [],
    timeEntries:     [],
    sentiment:       t.latest_customer_sentiment || null,
    lastMessageRole: t.last_message_role || null,
  };
}

// Server customer_note row → the {id, author, ts, text} shape the customers
// module renders. Exported so the note-create path can map its 201 response
// exactly like bootstrap's initial load.
// The server customer row (GET /customers shape — PATCH /customers/:id returns
// the same columns) → the SPA's camelCase view model, written onto `target`.
// Bootstrap builds every row through this, and the details card applies a
// PATCH response through it, so there is exactly one mapping. Only for FULL
// rows: a contact-endpoint response is partial and goes through
// customers/contacts.js applyContacts instead.
export function applyCustomerRow(target, c) {
  target.first        = c.first_name || '';
  target.last         = c.last_name || '';
  target.username     = c.username || '';
  target.maestroUserId = c.maestro_user_id || '';   // Maestro global player id (auto-linked, read-only)
  target.memberId      = c.maestro_member_id || ''; // per-brand member number
  target.email        = c.email || '';   // primary mirror (server-derived for merged-away rows)
  target.mobile       = c.mobile || '';
  target.emails       = Array.isArray(c.emails)  ? c.emails  : [];   // Phase 4 contacts model
  target.mobiles      = Array.isArray(c.mobiles) ? c.mobiles : [];
  target.brand        = c.brand || '';
  target.vip          = c.vip_tier || '';
  target.jurisdiction = c.jurisdiction || '';
  target.consent      = Boolean(c.consent);
  target.since        = isoDate(c.since);   // `date` column → YYYY-MM-DD whatever the wire form
  target.bo           = c.backoffice_url || '';
  target.erased       = Boolean(c.erased_at);
  target.emailBounceState = c.email_bounce_state || 'none';
  target.emailBounceCount = c.email_bounce_count || 0;
  target.emailLastBounce  = c.email_last_bounce_at || null;
  return target;
}

export function mapCustomerNote(n) {
  return {
    id:     n.id,
    author: n.author_name || 'Unknown',
    ts:     new Date(n.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    text:   n.text,
  };
}

export async function loadWorkspaceData() {
  const [ticketsRes, customersRes, agentsRes, channelsRes, slaRes, tagsRes, kbRes, cannedRes, ttRes, cfRes, arRes, rolesRes, cvRes, catsRes, custNotesRes, layoutsRes] = await Promise.all([
    // First page only. Subsequent pages load via loadMoreTickets() when
    // the user clicks "Load more" on the tickets list. Total comes back
    // in ticketsRes.total so the UI can show "showing N of M".
    apiGet(`/api/v1/tickets?limit=${TICKETS_PAGE_SIZE}&offset=0`),
    apiGet('/api/v1/customers'),
    apiGet('/api/v1/agents'),
    apiGet('/api/v1/channels'),
    apiGet('/api/v1/sla-policies'),
    apiGet('/api/v1/tags'),
    apiGet('/api/v1/kb-articles'),
    apiGet('/api/v1/canned-responses'),
    apiGet('/api/v1/ticket-templates'),
    apiGet('/api/v1/custom-fields'),
    apiGet('/api/v1/assign-rules'),
    apiGet('/api/v1/roles'),
    apiGet('/api/v1/custom-values?entity_type=customer'),
    apiGet('/api/v1/categories'),
    // Notes are a nice-to-have sidebar payload — never let them take the
    // whole all-or-nothing bootstrap down (e.g. web deployed ahead of api,
    // where the old API 404s this endpoint and every login would fail).
    apiGet('/api/v1/customers/notes').catch((err) => {
      console.warn('[bootstrap] customer notes load failed:', err?.message || err);
      return { notes: [] };
    }),
    // Web-ahead-of-api tolerance is a 404 ONLY — there the endpoint doesn't
    // exist yet and "no rows" is the truth. Any OTHER failure (500, network)
    // means the workspace's real layout is UNKNOWN: signal that with null so
    // the layouts module blocks persistence — a later admin toggle would
    // otherwise PUT code defaults over the workspace's saved layout.
    apiGet('/api/v1/workspace/layouts').catch((err) => {
      if (err?.status === 404) return { layouts: [] };
      console.warn('[bootstrap] layouts load failed:', err?.message || err);
      return { layouts: null };
    }),
  ]);

  const customersRaw = customersRes.customers || [];
  const agentsRaw    = agentsRes.agents       || [];
  const ticketsRaw   = ticketsRes.tickets     || [];
  const channelsRaw  = channelsRes.channels   || [];
  const slaRaw       = slaRes.sla_policies    || [];
  const tagsRaw      = tagsRes.tags           || [];
  const kbRaw        = kbRes.articles         || [];
  const cannedRaw    = cannedRes.canned_responses || [];
  const ttRaw        = ttRes.ticket_templates || [];
  const cfRaw        = cfRes.custom_fields    || [];
  const arRaw        = arRes.assign_rules     || [];
  const rolesRaw     = rolesRes.roles         || [];
  const cvRaw        = cvRes.custom_values    || [];
  const custNotesRaw = custNotesRes.notes     || [];

  // Build UUID → display_id and UUID → user-name maps for the ticket join.
  const customerByUuid = Object.fromEntries(customersRaw.map((c) => [c.id, c]));
  const userByUuid     = Object.fromEntries(agentsRaw.map((a) => [a.user_id, a.users]));

  // ─── CUSTOMERS ──────────────────────────────────────────────────────────
  // Group custom values by entity_id so we can attach each customer's
  // {field_key: value} map in one pass below.
  const customByEntity = {};
  for (const v of cvRaw) {
    if (!customByEntity[v.entity_id]) customByEntity[v.entity_id] = {};
    customByEntity[v.entity_id][v.field_key] = v.value;
  }
  // Group persisted internal notes by customer (newest-first from the API).
  // The customers module renders {id, author, ts, text} note objects.
  const notesByCustomer = {};
  for (const n of custNotesRaw) {
    (notesByCustomer[n.customer_id] ||= []).push(mapCustomerNote(n));
  }
  const mappedCustomers = customersRaw.map((c) => applyCustomerRow({
    _uuid:        c.id,           // DB UUID — used by PUT /custom-values/customers/:uuid
    id:           c.display_id,
    custom:       customByEntity[c.id] || {},
    notes:        notesByCustomer[c.id] || [],
    _mergedIntoUuid: c.merged_into_customer_id || null,
    mergedInto:   null,          // display id, resolved in the pass below
    mergedAt:     c.merged_at ? isoDate(c.merged_at) : null,
    mergedFrom:   [],
  }, c));
  // Resolve customer-merge pointers to display ids (same pass the tickets
  // merge graph gets below) so the existing mergedInto/mergedFrom badges and
  // banners light up from server truth.
  const custByUuid = Object.fromEntries(mappedCustomers.map((c) => [c._uuid, c]));
  for (const c of mappedCustomers) {
    if (!c._mergedIntoUuid) continue;
    const survivor = custByUuid[c._mergedIntoUuid];
    if (survivor) {
      c.mergedInto = survivor.id;
      survivor.mergedFrom.push(c.id);
    }
  }
  replaceInPlace(CUSTOMERS, mappedCustomers);

  // ─── AGENTS ─────────────────────────────────────────────────────────────
  replaceInPlace(AGENTS, agentsRaw.map(mapAgentRow));

  // ─── TICKETS ────────────────────────────────────────────────────────────
  const mappedTickets = ticketsRaw.map((t) => ({
    _uuid:           t.id,          // DB UUID — used by detail fetch
    _detailLoaded:   false,         // flips true after loadTicketDetail
    id:              t.display_id,
    subject:         t.subject,
    customerId:      customerByUuid[t.customer_id]?.display_id || null,
    status:          t.status_key,
    priority:        t.priority_key,
    category:        labelCase(t.category_key) || 'Other',
    agent:           userByUuid[t.assigned_user_id]?.name || '',
    created:         isoDate(t.created_at),
    updated:         fmtRelative(t.updated_at),
    sla:             t.sla_state || 'ok',
    snoozedUntil:    t.snoozed_until || null,
    snoozedAt:       t.snoozed_at    || null,
    snoozeReason:    t.snooze_reason || null,
    snoozeWokenAt:   t.snooze_woken_at || null,
    _mergedIntoUuid: t.merged_into_id || null,
    mergedInto:      null,            // back-filled below from ticketByUuid
    mergedAt:        t.merged_at || null,
    mergedFrom:      [],              // back-filled below
    _statusBeforeMerge: t.status_before_merge || null,
    tags:            [],   // populated by loadTicketDetail on open
    aiTags:          [],
    csat:            null,
    msgs:            [],
    timeEntries:     [],
    sentiment:       t.latest_customer_sentiment || null,
    lastMessageRole: t.last_message_role || null,
  }));
  // Resolve merge pointers display_id ↔ display_id across the loaded set.
  // Children outside the current page won't appear in mergedFrom — paginate-
  // aware merge graphs are a future PR.
  const ticketByUuid = Object.fromEntries(mappedTickets.map((m) => [m._uuid, m]));
  for (const m of mappedTickets) {
    if (m._mergedIntoUuid) {
      const parent = ticketByUuid[m._mergedIntoUuid];
      if (parent) {
        m.mergedInto = parent.id;
        parent.mergedFrom.push(m.id);
      }
    }
  }
  replaceInPlace(TICKETS, mappedTickets);
  // Seed the tickets pagination cursor + total. loadMoreTickets uses
  // these to fetch subsequent pages on demand.
  _ticketsOffset = mappedTickets.length;
  _ticketsTotal  = ticketsRes.total ?? mappedTickets.length;

  // ─── CHANNELS ───────────────────────────────────────────────────────────
  // Map UUIDs to display_ids so the rest of the UI (which expects "CH-001"
  // style ids) keeps matching. Stash the UUID in `_uuid` for future writes.
  const mappedChannels = channelsRaw.map((c) => ({
    _uuid:           c.id,
    id:              c.display_id,
    name:            c.name,
    type:            c.type,
    address:         c.address || '',
    status:          c.status,
    defaultCategory: c.default_category_key || 'all',
    defaultPriority: c.default_priority_key || '',
    defaultAgent:    c.default_agent_name || '',
    signature:       c.signature || '',
    volume30d:       c.volume_30d || 0,
  }));
  replaceInPlace(CHANNELS, mappedChannels);

  // ─── SLA_POLICIES ───────────────────────────────────────────────────────
  // category_key is null on the server for "any category"; the SPA models
  // that as the literal string 'all'. priority_key matches on both sides.
  const mappedSla = slaRaw.map((p) => ({
    _uuid:            p.id,
    id:               p.display_id,
    name:             p.name,
    priority:         p.priority_key,
    category:         p.category_key || 'all',
    firstResponseMin: p.first_response_min,
    resolutionMin:    p.resolution_min,
    status:           p.status,
  }));
  replaceInPlace(SLA_POLICIES, mappedSla);

  // ─── TAG_LIBRARY ────────────────────────────────────────────────────────
  // type/conf are the data.js field names; kind/ai_confidence on the server.
  // Count comes pre-computed from the API (manual or AI count depending on
  // the row's kind).
  const mappedTags = tagsRaw.map((t) => ({
    tag:   t.tag,
    type:  t.kind,
    conf:  t.ai_confidence,
    count: t.count || 0,
  }));
  replaceInPlace(TAG_LIBRARY, mappedTags);

  // ─── KB_ARTICLES ────────────────────────────────────────────────────────
  // updated_at is timestamptz; data.js used 'YYYY-MM-DD'. Keep that shape
  // for the existing sort + display code that does localeCompare on it.
  const mappedKb = kbRaw.map((a) => ({
    _uuid:           a.id,
    id:              a.display_id,
    title:           a.title,
    category:        a.category || '',
    body:            a.body || '',
    author:          a.author_name || 'Unknown',
    updated:         isoDate(a.updated_at),
    viewCount:       a.view_count || 0,
    helpfulCount:    a.helpful_count || 0,
    unhelpfulCount:  a.unhelpful_count || 0,
    myVote:          a.my_vote || 0,  // 1 = up, -1 = down, 0 = none
  }));
  replaceInPlace(KB_ARTICLES, mappedKb);

  // ─── CANNED_RESPONSES ──────────────────────────────────────────────────
  // The server stores the template body in `body`; data.js uses `text` for
  // the same field. Translate on the way in.
  const mappedCanned = cannedRaw.map((r) => ({
    _uuid:    r.id,
    id:       r.display_id,
    name:     r.name,
    category: r.category || '',
    text:     r.body || '',
  }));
  replaceInPlace(CANNED_RESPONSES, mappedCanned);

  // ─── TICKET_TEMPLATES ──────────────────────────────────────────────────
  // data.js uses `priority`; the server stores `priority_key`. Subject + body
  // are nullable on the server (a template can be name-only) but the UI
  // shows '' for them — normalise.
  const mappedTt = ttRaw.map((t) => ({
    _uuid:    t.id,
    id:       t.display_id,
    name:     t.name,
    category: t.category || '',
    priority: t.priority_key || 'normal',
    subject:  t.subject || '',
    body:     t.body || '',
  }));
  replaceInPlace(TICKET_TEMPLATES, mappedTt);

  // ─── CUSTOM_FIELDS ─────────────────────────────────────────────────────
  // data.js uses short ids ('cf1', 'cf2'); the server uses meaningful
  // snake_case `key`s ('account_manager'). Expose `key` as `id` so the
  // existing find-by-id pattern (CUSTOM_FIELDS.find(x => x.id === id))
  // keeps working — the IDs become semantic, which is a UX win.
  const mappedCf = cfRaw.map((f) => ({
    _uuid:        f.id,
    id:           f.key,
    label:        f.label,
    type:         f.field_type,
    entity:       f.entity_type,
    required:     Boolean(f.required),
    defaultValue: f.default_value || '',
    options:      f.options || undefined,
    sortOrder:    f.sort_order || 0,
  }));
  replaceInPlace(CUSTOM_FIELDS, mappedCf);

  // ─── ROLES ─────────────────────────────────────────────────────────────
  // ROLES is the set of role names. Core authorization is the binary is_admin
  // flag (server-enforced); the finer capabilities (can_manage_custom_fields,
  // can_delete) ride alongside it in ONE module-scope record map keyed by
  // role name (_rolesByName below) so the roles module can address/mutate rows.
  _rolesByName = {};
  for (const r of rolesRaw) {
    _rolesByName[r.name] = {
      id:          r.id,
      isAdmin:     Boolean(r.is_admin),
      // Capabilities are shaped with the implicit-admin OR (like whoami) so
      // the Roles page renders effective rights, not raw column values.
      canManageCF: Boolean(r.is_admin) || Boolean(r.can_manage_custom_fields),
      canDelete:   Boolean(r.is_admin) || Boolean(r.can_delete),
    };
  }
  replaceInPlace(ROLES, rolesRaw.map((r) => r.name));

  // ─── ASSIGN_RULES ──────────────────────────────────────────────────────
  // The DB stores assignee references as user UUIDs (agent_user_id or
  // team_user_ids[]). data.js uses agent names. Translate via userByUuid
  // (already built above for ticket assignee resolution).
  const mappedAr = arRaw.map((r) => ({
    _uuid:        r.id,
    id:           r.display_id,
    name:         r.name,
    priority:     r.priority,
    status:       r.status,
    conditions:   r.conditions || { priority: 'all', category: 'all', vip: 'all' },
    assignment:   assignmentServerToClient(r.assignment, userByUuid),
    matchCount:   r.match_count || 0,
    lastMatchAt:  r.last_match_at ? isoDate(r.last_match_at) : null,
  }));
  replaceInPlace(ASSIGN_RULES, mappedAr);

  // ─── CATEGORIES ─────────────────────────────────────────────────────────
  // {key, label, is_active} straight from the API. Includes inactive rows so
  // the admin Categories settings tab can show + re-enable them; the
  // New-Ticket dropdown filters to is_active.
  replaceInPlace(CATEGORIES, (catsRes.categories || []));

  // ─── LAYOUTS ────────────────────────────────────────────────────────────
  // Overlay persisted field-layout rows onto the code defaults (resets to
  // defaults first, so a workspace with no rows can't inherit the previous
  // workspace's layout). Empty array = every scope falls back to code order;
  // null (load failed above) = defaults too, but with persistence blocked.
  hydrateLayouts(layoutsRes.layouts);
}

// Role-name → {id, isAdmin, canManageCF, canDelete} lookup populated by
// loadWorkspaceData; consumed by roles/index.js for PATCH/DELETE against
// /api/v1/roles and for rendering/toggling capabilities without a refetch.
// ONE record per role (matching the userByUuid/customerByUuid idiom) so
// clear/rename can't leave a capability strand behind. The exported
// accessors below are the module's public surface — callers never touch
// the map directly.
let _rolesByName = {};
function roleEntry(name) { return (_rolesByName[name] ||= { id: null, isAdmin: false, canManageCF: false, canDelete: false }); }
export function getRoleUuid(name) { return _rolesByName[name]?.id || null; }
export function setRoleUuid(name, uuid) { roleEntry(name).id = uuid; }
export function clearRoleUuid(name) { delete _rolesByName[name]; }
export function renameRoleUuid(oldName, newName) {
  if (_rolesByName[oldName]) {
    _rolesByName[newName] = _rolesByName[oldName];
    delete _rolesByName[oldName];
  }
}
export function getRoleIsAdmin(name) { return Boolean(_rolesByName[name]?.isAdmin); }
export function getRoleCanManageCF(name) { return Boolean(_rolesByName[name]?.canManageCF); }
export function setRoleCanManageCF(name, val) { roleEntry(name).canManageCF = Boolean(val); }
export function getRoleCanDelete(name) { return Boolean(_rolesByName[name]?.canDelete); }
export function setRoleCanDelete(name, val) { roleEntry(name).canDelete = Boolean(val); }

// Server → client: turn agent_user_id / team_user_ids back into names.
function assignmentServerToClient(srv, userByUuid) {
  if (!srv) return { mode: 'round-robin', team: [] };
  if (srv.mode === 'specific-agent') {
    return {
      mode:  'specific-agent',
      agent: userByUuid[srv.agent_user_id]?.name || '',
    };
  }
  return {
    mode: srv.mode,
    team: (srv.team_user_ids || []).map((uid) => userByUuid[uid]?.name).filter(Boolean),
    ...(srv.rr_index !== undefined ? { rrIndex: srv.rr_index } : {}),
  };
}

// Fetches the full detail (messages, tags, ai_tags, time_entries) for a
// single ticket and merges into the existing TICKETS entry in place.
// Idempotent: second call is a cheap no-op via the _detailLoaded flag.
//
// Pass {force:true} to bypass the flag and re-fetch from scratch — used
// by the presence-driven live-sync path when another agent has just
// mutated the ticket on the server.
//
// When force-refetching, top-level fields (status/priority/category/
// agent/subject/updated/sla) are also re-applied since they're the
// most-likely-to-have-changed fields when an agent on another machine
// touched the ticket. Initial loads skip the top-level reapply because
// the bootstrap list endpoint already populated them and re-mapping
// would just churn the same data.
// Returns the ticket after merge (or null if not found / not loadable).
export async function loadTicketDetail(displayId, { force = false } = {}) {
  const t = TICKETS.find((x) => x.id === displayId);
  if (!t) return null;
  if (!t._uuid) return t;          // demo persona ticket — nothing to load
  if (t._detailLoaded && !force) return t;

  const res = await apiGet(`/api/v1/tickets/${t._uuid}`);
  const d = res.ticket;
  if (!d) return t;

  // Refresh top-level fields on a force-reload so live-sync reflects
  // status/assignment/category changes another agent made.
  if (force) {
    const customerByUuid = Object.fromEntries(CUSTOMERS.map((c) => [c._uuid || c.id, c]));
    const userByUuid     = Object.fromEntries(AGENTS.map((a) => [a.userId, a]));
    t.subject    = d.subject;
    t.customerId = customerByUuid[d.customer_id]?.id || customerByUuid[d.customer_id]?.display_id || t.customerId;
    t.status     = d.status_key;
    t.priority   = d.priority_key;
    t.category   = labelCase(d.category_key) || 'Other';
    t.agent      = userByUuid[d.assigned_user_id]?.name || '';
    t.updated    = fmtRelative(d.updated_at);
    t.sla        = d.sla_state || 'ok';
    t._updatedAt = d.updated_at;     // raw ISO for live-sync diffing
  } else {
    t._updatedAt = d.updated_at;     // stamp on first load too so sync has a baseline
  }

  // Build a UUID → display_id lookup for messages that came from a
  // merged source ticket, so the per-message mergedFrom tag matches the
  // existing data.js shape (display_id string, not UUID).
  const ticketByUuid = Object.fromEntries(TICKETS.map((x) => [x._uuid, x.id]));

  // Map messages to data.js shape ({from, r, t, ts, mentions, mergedFrom?}).
  t.msgs = (d.messages || []).map((m) => ({
    from:       m.author_label,
    r:          m.role,
    t:          m.body,
    // Sanitised HTML body + its files (rich email). Null/[] for plain-text
    // messages and notes, which keep rendering as escaped text.
    html:       m.body_html || null,
    attachments: m.attachments || [],
    ts:         fmtTime(m.created_at),
    mentions:   m.mentions || [],
    sentiment:  m.sentiment || null,
    mergedFrom: m.merged_from_id ? (ticketByUuid[m.merged_from_id] || null) : undefined,
  }));
  t.tags        = d.tags || [];
  t.aiTags      = (d.ai_tags || []).map((x) => ({ tag: x.tag, conf: x.confidence, accepted: x.accepted }));
  t.timeEntries = (d.time_entries || []).map((te) => ({
    id:       te.id,
    agent:    te.user_name || '',
    minutes:  te.minutes,
    note:     te.note || '',
    billable: te.billable,
    ts:       fmtTimestampLong(te.created_at),
  }));

  // Sidebar metadata
  t.csat            = d.csat_score ?? null;
  t.csatStars       = d.csat_stars ?? null;
  t.csatComment     = d.csat_comment || '';
  t.csatRequestedAt    = d.csat_requested_at ? isoDate(d.csat_requested_at) : null;
  t.csatSubmittedAt    = d.csat_submitted_at ? isoDate(d.csat_submitted_at) : null;
  t.snoozedUntil    = d.snoozed_until || null;
  t.snoozedAt       = d.snoozed_at || null;
  t.snoozeReason    = d.snooze_reason || '';
  t.resolvedAt      = d.resolved_at || null;

  // Merge state — the detail endpoint joins the primary's display_id and
  // the children's display_ids so the SPA's merge banner + merged-duplicates
  // sidebar block don't need cross-ticket lookups.
  t.mergedInto         = d.merged_into_display_id || null;
  t.mergedAt           = d.merged_at ? isoDate(d.merged_at) : null;
  t.mergedFrom         = d.merged_from_display_ids || [];
  t._statusBeforeMerge = d.status_before_merge || null;

  t._detailLoaded = true;
  return t;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function replaceInPlace(target, source) {
  target.length = 0;
  for (const item of source) target.push(item);
}

// Map one API /agents row to the data.js AGENTS view-model. Shared by the
// initial bootstrap and reloadAgents() (e.g. after inviting a new agent).
function mapAgentRow(a) {
  return {
    userId:   a.user_id,    // DB UUID — used by PATCH /tickets when assigning
    name:     a.users?.name || a.users?.email || 'Unknown',
    initials: a.users?.initials || initialsFromName(a.users?.name || a.users?.email || ''),
    role:     a.roles?.name || 'Member',
    active:   Boolean(a.active),
    oooFrom:  a.ooo_from || undefined,
    oooTo:    a.ooo_to   || undefined,
    oooNote:  a.ooo_note || undefined,
  };
}

// Re-fetch the workspace roster and replace AGENTS in place — used after a
// membership change (e.g. inviting an agent) so the UI reflects the new row
// without a full workspace reload.
export async function reloadAgents() {
  const res = await apiGet('/api/v1/agents');
  // Only replace when we actually got a roster array — a malformed 2xx must
  // never blank the agents list out from under the UI.
  if (Array.isArray(res?.agents)) replaceInPlace(AGENTS, res.agents.map(mapAgentRow));
}

function initialsFromName(s) {
  if (!s) return '??';
  const parts = s.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || s.slice(0, 2).toUpperCase();
}

function isoDate(iso) {
  return iso ? String(iso).slice(0, 10) : '';
}

// Crude relative formatter for the tickets-list "updated" column. Matches
// data.js's shape ("2 min ago" / "1h ago" / "2d ago"). Not localised — fix
// when the UI gets a real i18n layer.
function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60)         return Math.floor(diffSec) + 's ago';
  if (diffSec < 3600)       return Math.floor(diffSec / 60) + ' min ago';
  if (diffSec < 86400)      return Math.floor(diffSec / 3600) + 'h ago';
  if (diffSec < 86400 * 30) return Math.floor(diffSec / 86400) + 'd ago';
  return isoDate(iso);
}

// Capitalise the first letter of a lookup key ('billing' → 'Billing') so
// the UI's case-sensitive comparisons (filter chips, etc.) keep matching
// the data.js conventions. A category-labels lookup table is the cleaner
// long-term fix.
function labelCase(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "HH:MM" — matches data.js's `ts: '09:12'` shape for messages.
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toTimeString().slice(0, 5);
}

// "YYYY-MM-DD HH:MM" — matches data.js's time-entry ts shape.
function fmtTimestampLong(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const date = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  return `${date} ${time}`;
}
