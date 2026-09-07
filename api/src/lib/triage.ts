import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, computeCostMicro } from './anthropic.js';
import { getDb } from './db.js';
import { assertHasBudget, BudgetExceededError, deductBudget } from './budget.js';
import {
  detectResponsibleGamblingConcern,
  evaluateAutoReply,
  postAutoReply,
  type AutoReplyDecision,
  type WorkspaceAutoReplyConfig,
} from './auto-reply.js';
import { buildPlayerContext } from './player-context.js';

const MODEL = 'claude-sonnet-4-6';

// ─── Tool schema ───────────────────────────────────────────────────────────
// Single tool the model is forced to call. Captures everything we need from
// one round-trip: classification, summary, draft reply, AI tags.

const RECORD_TRIAGE_TOOL: Anthropic.Tool = {
  name: 'record_triage',
  description:
    'Record the AI triage for this ticket. You MUST call this tool exactly once with the complete result.',
  input_schema: {
    type: 'object',
    properties: {
      category_key: {
        type: 'string',
        description:
          'The category key (not label) that best matches this ticket. Must be from the AVAILABLE CATEGORIES list.',
      },
      priority_key: {
        type: 'string',
        description:
          'The priority key (not label) that best matches the urgency. Must be from the AVAILABLE PRIORITIES list.',
      },
      sentiment: {
        type: 'string',
        enum: ['positive', 'neutral', 'frustrated', 'angry'],
        description: "The customer's emotional state, judged from their language.",
      },
      summary: {
        type: 'string',
        description:
          'One short paragraph (max 3 sentences) describing the issue, written for an agent picking up the ticket cold. Lead with the symptom, then what we know, then what is blocking resolution.',
      },
      draft_reply: {
        type: 'string',
        description:
          'A suggested first-response reply to the customer. Empathetic, specific to their issue, no fake timelines, no fake commitments. Sign off as the workspace name (no fake agent names). Plain text, no greeting line if the thread already has agent replies.',
      },
      tags: {
        type: 'array',
        description:
          '3-6 short topical tags (lowercase, hyphenated, no spaces). Examples: "checkout-error", "billing-dispute", "password-reset".',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string' },
            confidence: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: 'How confident you are this tag applies, 0-100.',
            },
          },
          required: ['tag', 'confidence'],
        },
      },
      confidence: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          'Overall triage confidence 0-100. Above 85 means high enough to consider auto-reply for trivial categories. Below 60 means the ticket is ambiguous and needs human triage.',
      },
    },
    required: [
      'category_key',
      'priority_key',
      'sentiment',
      'summary',
      'draft_reply',
      'tags',
      'confidence',
    ],
  },
};

// Runtime validation of the tool input — defence-in-depth against model drift.
const TriageOutput = z.object({
  category_key: z.string().min(1),
  priority_key: z.string().min(1),
  sentiment: z.enum(['positive', 'neutral', 'frustrated', 'angry']),
  summary: z.string().min(1),
  draft_reply: z.string().min(1),
  tags: z
    .array(z.object({ tag: z.string().min(1), confidence: z.number().int().min(0).max(100) }))
    .min(0)
    .max(10),
  confidence: z.number().int().min(0).max(100),
});

export type TriageOutput = z.infer<typeof TriageOutput>;

// ─── Prompt assembly ───────────────────────────────────────────────────────

const SYSTEM_INTRO = `You are the triage AI for Respovia, a customer-support help desk. Your job is to read an incoming support ticket and call the record_triage tool exactly once with a complete, accurate result.

Rules:
- Pick the SINGLE BEST category and priority from the lists provided. Use the exact keys, not the labels.
- Priority guidance: "urgent" = revenue-blocking, security, GDPR statutory deadline. "high" = customer-blocked but workaround exists. "normal" = standard issue. "low" = feature request, informational.
- Sentiment: judge from word choice, exclamation marks, all-caps. Default to "neutral" if unsure.
- Summary: lead with the symptom in concrete terms. Avoid filler like "the customer is asking about". An agent should be able to pick up the ticket after reading just the summary.
- Draft reply: write what an experienced support agent would write. Acknowledge the issue, state what you'll do or what you already see, and ask for specifics if needed. NO fake timelines ("within 24 hours"). NO fake commitments. NO promises to "look into it" without saying what.
- Tags: 3-6 short kebab-case tags. Prefer existing taxonomy ("billing", "checkout", "mobile-bug") over inventing new ones.
- Confidence: be honest. If the ticket is ambiguous or you couldn't find a good category, lower the confidence so a human reviews it.
`;

interface WorkspaceLookups {
  categories: { key: string; label: string }[];
  priorities: { key: string; label: string }[];
  statuses: { key: string; label: string }[];
  workspaceName: string;
  autoReply: WorkspaceAutoReplyConfig;
  aiPlayerEnrichment: boolean;
  // The Maestro brand this workspace projects (null for non-Maestro tenants).
  // Scopes the player lookup to the right brand instead of the single global
  // MAESTRO_BRAND_ID fallback, which is wrong for multi-brand installs.
  maestroBrandId: string | null;
}

function buildWorkspaceContext(lookups: WorkspaceLookups): string {
  const cats = lookups.categories.map((c) => `  - ${c.key} (${c.label})`).join('\n');
  const prios = lookups.priorities.map((p) => `  - ${p.key} (${p.label})`).join('\n');
  const stats = lookups.statuses.map((s) => `  - ${s.key} (${s.label})`).join('\n');
  return `AVAILABLE CATEGORIES (use one of these keys):
${cats}

AVAILABLE PRIORITIES (use one of these keys):
${prios}

AVAILABLE STATUSES (for context only — you do not set status):
${stats}`;
}

interface TicketSnapshot {
  display_id: string;
  subject: string;
  current_category_key: string | null;
  current_priority_key: string | null;
  current_status_key: string;
  customer_label: string;
  customer_email: string | null;
  customer_username: string | null;
  customer_vip_tier: string | null;
  customer_brand: string | null;
  customer_jurisdiction: string | null;
  messages: { role: string; author_label: string; body: string; created_at: string }[];
}

// The CUSTOMER line for the triage prompt. When player-account enrichment is
// OFF (the default, data-minimising posture) every customer-record attribute
// (VIP tier, brand, jurisdiction) is dropped — only the name remains, which the
// AI needs to address the reply. Brand is gated too: it's a per-customer column
// of ambiguous provenance, and the AI already has the brand/workspace identity
// from its system context for sign-off, so it adds nothing here. Exported for
// testing.
export function customerContextLine(
  t: Pick<TicketSnapshot, 'customer_label' | 'customer_vip_tier' | 'customer_brand' | 'customer_jurisdiction'>,
  includePlayerAttrs: boolean,
): string {
  const parts = [t.customer_label];
  if (includePlayerAttrs && t.customer_vip_tier) parts.push(`VIP ${t.customer_vip_tier}`);
  if (includePlayerAttrs && t.customer_brand) parts.push(t.customer_brand);
  if (includePlayerAttrs && t.customer_jurisdiction) parts.push(t.customer_jurisdiction);
  return parts.join(' · ');
}

// `playerContext` is the optional live Maestro player block (see
// lib/player-context.ts) — null when Maestro isn't configured, the player
// couldn't be resolved, OR the workspace hasn't opted in to player-account
// enrichment (the default). `includePlayerAttrs` mirrors that opt-in.
function buildUserMessage(t: TicketSnapshot, playerContext: string | null, includePlayerAttrs: boolean): string {
  const thread = t.messages
    .map((m) => `[${m.created_at} · ${m.role.toUpperCase()} · ${m.author_label}]\n${m.body}`)
    .join('\n\n---\n\n');
  return `Triage ticket ${t.display_id}.

CUSTOMER: ${customerContextLine(t, includePlayerAttrs)}
CURRENT STATUS: ${t.current_status_key}
CURRENT CATEGORY: ${t.current_category_key ?? '(none)'}
CURRENT PRIORITY: ${t.current_priority_key ?? '(none)'}
SUBJECT: ${t.subject}
${playerContext ? `\n${playerContext}\n` : ''}
THREAD (oldest first):
${thread}

Call record_triage now with the complete result.`;
}

// ─── Main entry ────────────────────────────────────────────────────────────

export interface TriageInput {
  ticketId: string;
  workspaceId: string;
  // null = system-triggered (e.g. auto-triage from inbound webhook). Schema
  // has user_id nullable on ai_usage_log specifically for this case.
  userId: string | null;
}

export interface TriageResult {
  triage: TriageOutput;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    cost_usd_micro: number;
    duration_ms: number;
    model: string;
  };
  budget: {
    balance_after_micro: number | null;  // null if deduct failed (logged server-side)
  };
  auto_reply: {
    decision: AutoReplyDecision;
    posted: boolean;
    message_id?: string;             // ticket_messages.id of the posted reply
    postmark_message_id?: string;    // Postmark's MessageID for the sent email
    not_posted_reason?:              // populated when decision.eligible but posted=false
      | 'already_auto_replied'
      | 'postmark_not_configured'
      | 'customer_email_missing'
      | 'email_suppressed'
      | 'send_failed'
      | 'unknown_error';
    not_posted_detail?: string;      // free-form context (e.g. Postmark error body)
  };
}

export class TriageError extends Error {
  constructor(message: string, public status: number = 500) {
    super(message);
  }
}

export async function triageTicket(input: TriageInput): Promise<TriageResult> {
  const { ticketId, workspaceId, userId } = input;

  // 0. Budget gate — refuse cheaply before doing any work. Log the blocked
  //    attempt so we have telemetry on how often this fires.
  try {
    await assertHasBudget(workspaceId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await getDb()`
        insert into ai_usage_log (workspace_id, ticket_id, user_id, action, model,
          input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
          cost_usd_micro, duration_ms, request_id)
        values (${workspaceId}, ${ticketId}, ${userId}, 'triage_blocked_no_budget', ${MODEL},
          0, 0, 0, 0, 0, 0, null)
      `;
    }
    throw err;
  }

  // 1. Load the ticket + thread + customer in parallel with the lookups.
  const [ticketRes, lookups] = await Promise.all([
    loadTicketSnapshot(ticketId, workspaceId),
    loadWorkspaceLookups(workspaceId),
  ]);

  // 2. Build the prompt. System has TWO blocks: stable intro + per-workspace
  //    lookups. cache_control on the LAST system block caches both together
  //    (render order is tools → system → messages, so tools are cached too).
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_INTRO },
    {
      type: 'text',
      text: buildWorkspaceContext(lookups),
      cache_control: { type: 'ephemeral' },
    },
  ];

  // Enrich with live Maestro player data ONLY when the workspace has opted in
  // (ai_player_enrichment). Default is off — the data-minimising posture: no
  // balance/country/VIP reaches the LLM unless a brand explicitly enables
  // it (AML is excluded regardless). Best-effort even when on: any failure or
  // missing config yields null and the prompt is unchanged.
  // Also requires the workspace to BE a Maestro brand: with no brand id the
  // worker would fall back to the global MAESTRO_BRAND_ID and enrich this
  // tenant's ticket with some OTHER brand's player record.
  const playerContext = lookups.aiPlayerEnrichment && lookups.maestroBrandId
    ? await buildPlayerContext({
        email: ticketRes.customer_email,
        username: ticketRes.customer_username,
        brandId: lookups.maestroBrandId,
      })
    : null;
  const userMessage = buildUserMessage(ticketRes, playerContext, lookups.aiPlayerEnrichment);

  // 3. Call Claude with tool_choice forcing the tool. We deliberately do NOT
  //    enable adaptive thinking here — the Anthropic API rejects the
  //    combination ("Thinking may not be enabled when tool_choice forces tool
  //    use."). Sonnet 4.6 produces strong triage output without thinking,
  //    and the structured-output guarantee from forced tool_choice is more
  //    valuable than the marginal quality bump from adaptive thinking.
  //    If we want thinking back, switch to tool_choice {type: "auto"} and
  //    handle the (rare) case where the model returns text instead.
  const startedAt = Date.now();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [RECORD_TRIAGE_TOOL],
    tool_choice: { type: 'tool', name: 'record_triage' },
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  const durationMs = Date.now() - startedAt;

  // Compute the cost once — used by logUsage, deductBudget, and the response.
  // Failure paths still pay Anthropic (tokens were spent) so they deduct too.
  const costMicro = computeCostMicro(MODEL, {
    input_tokens: response.usage.input_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    output_tokens: response.usage.output_tokens,
  });

  // 4. Extract + validate the tool call.
  const toolUseBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_triage',
  );
  if (!toolUseBlock) {
    await Promise.all([
      logUsage({
        workspaceId, ticketId, userId,
        action: 'triage_failed_no_tool_use',
        model: MODEL,
        usage: response.usage,
        durationMs,
        requestId: response.id,
      }),
      deductBudget(workspaceId, costMicro),
    ]);
    throw new TriageError('Model did not call record_triage', 502);
  }
  const parsed = TriageOutput.safeParse(toolUseBlock.input);
  if (!parsed.success) {
    await Promise.all([
      logUsage({
        workspaceId, ticketId, userId,
        action: 'triage_failed_schema',
        model: MODEL,
        usage: response.usage,
        durationMs,
        requestId: response.id,
      }),
      deductBudget(workspaceId, costMicro),
    ]);
    throw new TriageError(
      `Triage output failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      502,
    );
  }
  const triage = parsed.data;

  // 5. Validate category/priority keys exist in the workspace lookups (model
  //    occasionally hallucinates close-but-not-exact keys). Category match is
  //    case-insensitive — casing differs across layers — and on a match we
  //    write the canonical workspace key back so downstream consumers see it.
  const catMatch = lookups.categories.find(
    (c) => String(c.key ?? '').toLowerCase() === String(triage.category_key ?? '').toLowerCase(),
  );
  if (catMatch) {
    triage.category_key = catMatch.key;
  } else {
    triage.category_key = ticketRes.current_category_key ?? lookups.categories[0]?.key ?? '';
  }
  if (!lookups.priorities.find((p) => p.key === triage.priority_key)) {
    triage.priority_key = ticketRes.current_priority_key ?? 'normal';
  }

  // 6. Persist in parallel: update ticket + replace AI tags + log usage + deduct budget.
  const [, , , balanceAfterMicro] = await Promise.all([
    persistTicketTriage(ticketId, workspaceId, triage),
    persistAITags(ticketId, workspaceId, triage.tags),
    logUsage({
      workspaceId, ticketId, userId,
      action: 'triage',
      model: MODEL,
      usage: response.usage,
      durationMs,
      requestId: response.id,
    }),
    deductBudget(workspaceId, costMicro),
  ]);

  // 7. Confidence-gated auto-reply. If the workspace has it enabled AND the
  //    category is whitelisted AND triage confidence cleared the threshold,
  //    post the AI draft as an actual ai-role ticket_message. No new Claude
  //    call — we just reuse the draft from above. Idempotent (skips if a
  //    prior auto-reply event exists for this ticket).
  //
  //    Failures don't propagate to the caller — the triage itself was
  //    successful; auto-reply is a downstream side-effect. We log and
  //    return decision: { eligible: true, ... } so callers can see what
  //    happened.
  // Responsible-gambling safety gate: hold the auto-reply for a human if the
  // customer is disclosing gambling harm, asking to self-exclude/limit, or in
  // distress. Scan only customer-authored content (subject + customer messages)
  // — agent/AI replies must not trip the gate.
  const rgConcern = detectResponsibleGamblingConcern([
    ticketRes.subject,
    ...ticketRes.messages.filter((m) => m.role === 'customer').map((m) => m.body),
  ]);
  const decision = evaluateAutoReply(triage, lookups.autoReply, rgConcern);
  let autoReply: TriageResult['auto_reply'] = { decision, posted: false };
  if (decision.eligible) {
    try {
      const post = await postAutoReply({
        workspaceId,
        ticketId,
        draftReply: triage.draft_reply,
        confidence: triage.confidence,
        model: MODEL,
        workspaceName: lookups.workspaceName,
      });
      if (post.posted) {
        autoReply = {
          decision,
          posted: true,
          message_id: post.message_id,
          postmark_message_id: post.postmark_message_id ?? undefined,
        };
      } else {
        autoReply = {
          decision,
          posted: false,
          not_posted_reason: post.reason,
          not_posted_detail: post.detail,
        };
      }
    } catch (err) {
      console.error('[triage] auto-reply post failed:', err);
      // Unexpected throw (idempotency-check DB error etc). Surface so callers know.
      autoReply = {
        decision,
        posted: false,
        not_posted_reason: 'unknown_error',
        not_posted_detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    triage,
    usage: {
      input_tokens: response.usage.input_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      output_tokens: response.usage.output_tokens,
      cost_usd_micro: costMicro,
      duration_ms: durationMs,
      model: MODEL,
    },
    budget: {
      balance_after_micro: balanceAfterMicro,
    },
    auto_reply: autoReply,
  };
}

// ─── DB helpers (Neon) ──────────────────────────────────────────────────────

async function loadTicketSnapshot(
  ticketId: string,
  workspaceId: string,
): Promise<TicketSnapshot> {
  const sql = getDb();
  const [ticket] = await sql<{
    display_id: string; subject: string; status_key: string;
    priority_key: string | null; category_key: string | null;
    first_name: string | null; last_name: string | null;
    email: string | null; username: string | null;
    vip_tier: string | null; brand: string | null; jurisdiction: string | null;
  }[]>`
    select t.display_id, t.subject, t.status_key, t.priority_key, t.category_key,
           c.first_name, c.last_name, c.email, c.username, c.vip_tier, c.brand, c.jurisdiction
    from tickets t
    left join customers c on c.id = t.customer_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
  `;
  if (!ticket) throw new TriageError('Ticket not found', 404);

  const msgs = await sql<{ role: string; author_label: string; body: string; created_at: string }[]>`
    select role, author_label, body, created_at from ticket_messages
    where ticket_id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
    order by created_at asc
  `;

  const label = `${ticket.first_name ?? ''} ${ticket.last_name ?? ''}`.trim() || '(unknown)';
  return {
    display_id: ticket.display_id,
    subject: ticket.subject,
    current_category_key: ticket.category_key,
    current_priority_key: ticket.priority_key,
    current_status_key: ticket.status_key,
    customer_label: label,
    customer_email: ticket.email ?? null,
    customer_username: ticket.username ?? null,
    customer_vip_tier: ticket.vip_tier ?? null,
    customer_brand: ticket.brand ?? null,
    customer_jurisdiction: ticket.jurisdiction ?? null,
    messages: [...msgs],
  };
}

async function loadWorkspaceLookups(
  workspaceId: string,
): Promise<WorkspaceLookups> {
  const sql = getDb();
  // Only active categories are offered to the AI — disabled ones must not be
  // suggested on new triage (existing tickets keep their stored category).
  const [cats, prios, stats, wsRows] = await Promise.all([
    sql<{ key: string; label: string }[]>`select key, label from ticket_categories where workspace_id = ${workspaceId} and is_active = true order by label`,
    sql<{ key: string; label: string }[]>`select key, label from ticket_priorities where workspace_id = ${workspaceId} order by sort_order`,
    sql<{ key: string; label: string }[]>`select key, label from ticket_statuses where workspace_id = ${workspaceId} order by sort_order`,
    sql<{ name: string; auto_reply_min_confidence: number | null; auto_reply_categories: string[] | null; ai_player_enrichment: boolean | null; maestro_brand_id: string | null }[]>`
      select name, auto_reply_min_confidence, auto_reply_categories, ai_player_enrichment, maestro_brand_id from workspaces where id = ${workspaceId}`,
  ]);
  const ws = wsRows[0];
  return {
    categories: [...cats],
    priorities: [...prios],
    statuses: [...stats],
    workspaceName: ws?.name ?? 'Support',
    autoReply: {
      min_confidence: ws?.auto_reply_min_confidence ?? null,
      categories: ws?.auto_reply_categories ?? [],
      name: ws?.name ?? 'Support',
    },
    aiPlayerEnrichment: ws?.ai_player_enrichment === true,
    maestroBrandId: ws?.maestro_brand_id ?? null,
  };
}

async function persistTicketTriage(
  ticketId: string,
  workspaceId: string,
  triage: TriageOutput,
) {
  const sql = getDb();
  const now = new Date().toISOString();
  const aiSummary = {
    text: triage.summary,
    sentiment: triage.sentiment,
    confidence: triage.confidence,
    suggested_category_key: triage.category_key,
    suggested_priority_key: triage.priority_key,
    model: MODEL,
    generated_at: now,
  };
  const aiDraft = { text: triage.draft_reply, confidence: triage.confidence, model: MODEL, generated_at: now };
  await sql`
    update tickets set ai_summary = ${sql.json(aiSummary)}, ai_draft_reply = ${sql.json(aiDraft)}
    where id = ${ticketId} and workspace_id = ${workspaceId}
  `;
}

async function persistAITags(
  ticketId: string,
  workspaceId: string,
  tags: TriageOutput['tags'],
) {
  // Wipe and replace — AI tags are derived data we can re-generate.
  const sql = getDb();
  await sql`delete from ticket_ai_tags where ticket_id = ${ticketId}`;
  if (tags.length === 0) return;
  const rows = tags.map((t) => ({
    workspace_id: workspaceId, ticket_id: ticketId, tag: t.tag, confidence: t.confidence, accepted: false,
  }));
  await sql`insert into ticket_ai_tags ${sql(rows)}`;
}

async function logUsage(args: {
  workspaceId: string;
  ticketId: string;
  userId: string | null;
  action: string;
  model: string;
  usage: Anthropic.Usage;
  durationMs: number;
  requestId?: string;
}) {
  const input_tokens = args.usage.input_tokens;
  const cache_creation_input_tokens = args.usage.cache_creation_input_tokens ?? 0;
  const cache_read_input_tokens = args.usage.cache_read_input_tokens ?? 0;
  const output_tokens = args.usage.output_tokens;
  const cost = computeCostMicro(args.model, {
    input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
  });
  // Best-effort — failure to log usage should not break the request.
  try {
    await getDb()`
      insert into ai_usage_log (workspace_id, ticket_id, user_id, action, model,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
        cost_usd_micro, duration_ms, request_id)
      values (${args.workspaceId}, ${args.ticketId}, ${args.userId}, ${args.action}, ${args.model},
        ${input_tokens}, ${cache_creation_input_tokens}, ${cache_read_input_tokens}, ${output_tokens},
        ${cost}, ${args.durationMs}, ${args.requestId ?? null})
    `;
  } catch (err) {
    console.error('ai_usage_log insert failed:', err instanceof Error ? err.message : err);
  }
}
