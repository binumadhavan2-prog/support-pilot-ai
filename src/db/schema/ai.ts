import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import {
  draftStatus,
  evalRunStatus,
  evaluator,
  groundingStatus,
  supportTeam,
  ticketCategory,
  ticketPriority,
  ticketSentiment,
  toolCallStatus,
} from "./enums";
import { documentChunks, documents } from "./knowledge";
import { sameTenantCascade, sameTenantCheck, tenantId } from "./tenancy";
import { tickets } from "./tickets";

/** Usage metadata recorded on every model call, for cost tracking and analytics. */
const modelUsage = () => ({
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
});

/**
 * One AI triage pass over a ticket. Kept as history (re-triage adds a row); the latest values are
 * copied onto `tickets` for list views. `is_injection` flags text that tries to instruct the model.
 */
export const triageResults = pgTable(
  "triage_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ticketId: uuid("ticket_id").notNull(),
    category: ticketCategory("category").notNull(),
    priority: ticketPriority("priority").notNull(),
    sentiment: ticketSentiment("sentiment").notNull(),
    language: text("language").notNull(),
    isInjection: boolean("is_injection").notNull().default(false),
    summary: text("summary").notNull(),
    suggestedTeam: supportTeam("suggested_team").notNull().default("general"),
    // The model's short justification, for agents reviewing the triage. Never shown to customers.
    reasoning: text("reasoning").notNull().default(""),
    // Which prompt produced this row (e.g. "triage_v1"), so results stay comparable across edits.
    promptVersion: text("prompt_version").notNull().default("unknown"),
    // The article the model judged most relevant, if any (used by the golden-set eval).
    suggestedDocumentId: uuid("suggested_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    confidence: real("confidence").notNull(),
    ...modelUsage(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("triage_results_ticket_idx").on(t.ticketId, t.createdAt.desc()),
    sameTenantCascade(
      "triage_results_ticket_same_tenant_fk",
      [t.ticketId, t.tenantId],
      [tickets.id, tickets.tenantId],
    ),
    sameTenantCheck(
      "triage_results_document_same_tenant_fk",
      [t.suggestedDocumentId, t.tenantId],
      [documents.id, documents.tenantId],
    ),
    check("triage_results_confidence_range", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
  ],
);

/** AI-generated reply drafts. Nothing is sent to a customer until a human approves it. */
export const aiDrafts = pgTable(
  "ai_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ticketId: uuid("ticket_id").notNull(),
    body: text("body").notNull(),
    groundingStatus: groundingStatus("grounding_status").notNull(),
    status: draftStatus("status").notNull().default("pending"),
    // The text actually sent after human review; null unless approved or edited.
    finalBody: text("final_body"),
    rejectReason: text("reject_reason"),
    requestedById: text("requested_by_id").references(() => user.id, { onDelete: "set null" }),
    reviewedById: text("reviewed_by_id").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...modelUsage(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_drafts_ticket_idx").on(t.ticketId, t.createdAt.desc()),
    index("ai_drafts_tenant_status_idx").on(t.tenantId, t.status),
    unique("ai_drafts_id_tenant_uq").on(t.id, t.tenantId),
    sameTenantCascade(
      "ai_drafts_ticket_same_tenant_fk",
      [t.ticketId, t.tenantId],
      [tickets.id, tickets.tenantId],
    ),
  ],
);

/**
 * An action the AI proposes while handling a ticket, e.g. `refund_order` with its arguments.
 * Read-only tools may run automatically; anything that changes customer data waits as `pending`
 * until a human approves it. Arguments are validated against the tool's schema before execution.
 */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ticketId: uuid("ticket_id").notNull(),
    draftId: uuid("draft_id"),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull().default({}),
    // The model's stated reason, shown to the reviewer.
    rationale: text("rationale"),
    status: toolCallStatus("status").notNull().default("pending"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    model: text("model"),
    reviewedById: text("reviewed_by_id").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tool_calls_ticket_idx").on(t.ticketId, t.createdAt.desc()),
    index("tool_calls_tenant_status_idx").on(t.tenantId, t.status),
    sameTenantCascade(
      "tool_calls_ticket_same_tenant_fk",
      [t.ticketId, t.tenantId],
      [tickets.id, tickets.tenantId],
    ),
    sameTenantCascade(
      "tool_calls_draft_same_tenant_fk",
      [t.draftId, t.tenantId],
      [aiDrafts.id, aiDrafts.tenantId],
    ),
    // A decision needs a timestamp; execution needs an approval first.
    check(
      "tool_calls_reviewed_when_decided",
      sql`${t.status} = 'pending' OR ${t.reviewedAt} IS NOT NULL`,
    ),
    check(
      "tool_calls_executed_at_when_executed",
      sql`(${t.status} = 'executed') = (${t.executedAt} IS NOT NULL)`,
    ),
  ],
);

/** Questions asked on the knowledge base `/ask` page. */
export const kbQueries = pgTable(
  "kb_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    groundingStatus: groundingStatus("grounding_status").notNull(),
    askedById: text("asked_by_id").references(() => user.id, { onDelete: "set null" }),
    ...modelUsage(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("kb_queries_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    unique("kb_queries_id_tenant_uq").on(t.id, t.tenantId),
  ],
);

/**
 * A source passage cited by a draft or an answer. `quote` snapshots the passage so citations stay
 * readable even if the source document is later deleted (chunkId then becomes null).
 */
export const citations = pgTable(
  "citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    draftId: uuid("draft_id"),
    queryId: uuid("query_id"),
    chunkId: uuid("chunk_id").references(() => documentChunks.id, { onDelete: "set null" }),
    // The [n] marker used in the generated text.
    position: integer("position").notNull(),
    documentTitle: text("document_title").notNull(),
    quote: text("quote").notNull(),
    // Retrieval relevance score in [0, 1].
    score: real("score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("citations_draft_idx").on(t.draftId),
    index("citations_query_idx").on(t.queryId),
    sameTenantCascade(
      "citations_draft_same_tenant_fk",
      [t.draftId, t.tenantId],
      [aiDrafts.id, aiDrafts.tenantId],
    ),
    sameTenantCascade(
      "citations_query_same_tenant_fk",
      [t.queryId, t.tenantId],
      [kbQueries.id, kbQueries.tenantId],
    ),
    sameTenantCheck(
      "citations_chunk_same_tenant_fk",
      [t.chunkId, t.tenantId],
      [documentChunks.id, documentChunks.tenantId],
    ),
    check("citations_exactly_one_target", sql`num_nonnulls(${t.draftId}, ${t.queryId}) = 1`),
    check("citations_score_range", sql`${t.score} >= 0 AND ${t.score} <= 1`),
  ],
);

/**
 * A batch evaluation, e.g. triage accuracy on evals/golden_tickets.jsonl. `metrics` holds the
 * aggregate scores; `cases` the per-row results for drill-down.
 */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    datasetName: text("dataset_name").notNull(),
    // SHA-256 of the dataset file, so results are comparable only across identical datasets.
    datasetHash: text("dataset_hash").notNull(),
    model: text("model").notNull(),
    status: evalRunStatus("status").notNull().default("running"),
    totalCases: integer("total_cases").notNull().default(0),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
    cases: jsonb("cases").$type<Record<string, unknown>[]>().notNull().default([]),
    errorMessage: text("error_message"),
    startedById: text("started_by_id").references(() => user.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("eval_runs_tenant_started_idx").on(t.tenantId, t.startedAt.desc()),
    unique("eval_runs_id_tenant_uq").on(t.id, t.tenantId),
  ],
);

/** Quality scores for a draft or answer, from an LLM judge or a human reviewer. Scores are in [0, 1]. */
export const answerEvaluations = pgTable(
  "answer_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    draftId: uuid("draft_id"),
    queryId: uuid("query_id"),
    // Set when the evaluation was produced by a batch eval run.
    evalRunId: uuid("eval_run_id"),
    evaluator: evaluator("evaluator").notNull(),
    groundedness: real("groundedness"),
    relevance: real("relevance"),
    citationAccuracy: real("citation_accuracy"),
    rationale: text("rationale"),
    // Set for human evaluations.
    evaluatedById: text("evaluated_by_id").references(() => user.id, { onDelete: "set null" }),
    // Set for LLM-judge evaluations.
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("answer_evaluations_draft_idx").on(t.draftId),
    index("answer_evaluations_query_idx").on(t.queryId),
    index("answer_evaluations_run_idx").on(t.evalRunId),
    sameTenantCascade(
      "answer_evaluations_draft_same_tenant_fk",
      [t.draftId, t.tenantId],
      [aiDrafts.id, aiDrafts.tenantId],
    ),
    sameTenantCascade(
      "answer_evaluations_query_same_tenant_fk",
      [t.queryId, t.tenantId],
      [kbQueries.id, kbQueries.tenantId],
    ),
    sameTenantCascade(
      "answer_evaluations_run_same_tenant_fk",
      [t.evalRunId, t.tenantId],
      [evalRuns.id, evalRuns.tenantId],
    ),
    check(
      "answer_evaluations_exactly_one_target",
      sql`num_nonnulls(${t.draftId}, ${t.queryId}) = 1`,
    ),
    check(
      "answer_evaluations_score_range",
      sql`(${t.groundedness} IS NULL OR ${t.groundedness} BETWEEN 0 AND 1) AND (${t.relevance} IS NULL OR ${t.relevance} BETWEEN 0 AND 1) AND (${t.citationAccuracy} IS NULL OR ${t.citationAccuracy} BETWEEN 0 AND 1)`,
    ),
  ],
);
