import { readFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { ticketMessages, tickets, triageResults } from "@/db/schema";
import { supportTeam, ticketCategory, ticketPriority, ticketSentiment } from "@/db/schema/enums";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "../audit";
import {
  DEFAULT_MODEL,
  callStructured,
  createMessagesApi,
  escapeHtml,
  type BetaMessagesApi,
  type ModelCall,
} from "./claude";
import { Redactor, type PiiKind } from "./redact";

export const TRIAGE_PROMPT_VERSION = "triage_v1";
export const DEFAULT_TRIAGE_MODEL = DEFAULT_MODEL;
export type { BetaMessagesApi, ModelCall };

// Read once per process. A path from the project root, so it resolves the same in Next.js, the
// worker script and tests (all run from the root).
let systemPrompt: string | undefined;
export function triageSystemPrompt(): string {
  systemPrompt ??= readFileSync(
    path.join(process.cwd(), "src/server/ai/prompts", `${TRIAGE_PROMPT_VERSION}.md`),
    "utf8",
  );
  return systemPrompt;
}

/** Teams the model may suggest. `lead` is only ever set by the routing rules. */
export const SUGGESTED_TEAMS = supportTeam.enumValues.filter((t) => t !== "lead") as [
  Exclude<(typeof supportTeam.enumValues)[number], "lead">,
  ...Exclude<(typeof supportTeam.enumValues)[number], "lead">[],
];

/** What the model must return. Validated by the API (structured outputs) and again by Zod. */
export const triageOutputSchema = z.object({
  category: z.enum(ticketCategory.enumValues),
  priority: z.enum(ticketPriority.enumValues),
  sentiment: z.enum(ticketSentiment.enumValues),
  language: z.enum(["en", "hinglish", "tanglish", "other"]),
  summary: z.string(),
  suggested_team: z.enum(SUGGESTED_TEAMS),
  is_injection_attempt: z.boolean(),
  confidence: z.number(),
  reasoning: z.string(),
});

export type TriageOutput = z.infer<typeof triageOutputSchema>;
export type SupportTeam = (typeof supportTeam.enumValues)[number];

/** The model boundary. Production uses Claude; tests pass a mock (no network, no cost). */
export interface TriageModel {
  readonly model: string;
  classify(userMessage: string): Promise<ModelCall<TriageOutput>>;
}

export function createClaudeTriageModel({
  apiKey,
  model = DEFAULT_TRIAGE_MODEL,
  messagesApi,
}: {
  apiKey: string;
  model?: string;
  messagesApi?: BetaMessagesApi;
}): TriageModel {
  const api = messagesApi ?? createMessagesApi(apiKey);
  return {
    model,
    classify: (userMessage) =>
      callStructured(api, {
        model,
        system: triageSystemPrompt(),
        user: userMessage,
        schema: triageOutputSchema,
        // Thinking is always on for current models; classification needs little of it.
        effort: "low",
        maxTokens: 4000,
        task: "triage",
      }),
  };
}

/**
 * The user turn: the ticket inside <ticket> tags. Escaping means customer text cannot close the
 * tag or open a fake one; the system prompt tells the model the content is escaped data.
 */
export function buildTriageMessage(ticket: { subject: string; body: string }): string {
  return [
    "Triage this ticket.",
    "<ticket>",
    `<subject>${escapeHtml(ticket.subject)}</subject>`,
    `<body>\n${escapeHtml(ticket.body)}\n</body>`,
    "</ticket>",
  ].join("\n");
}

/**
 * Routing rules, applied in code after the model answers so they cannot be talked out of:
 * urgent (P1) or angry customers go to the lead queue; otherwise the model's suggestion stands.
 */
export function routeTicket(
  output: Pick<TriageOutput, "priority" | "sentiment" | "suggested_team">,
) {
  if (output.priority === "urgent" || output.sentiment === "negative") return "lead" as const;
  return output.suggested_team;
}

export interface TriageResult extends ModelCall<TriageOutput> {
  team: SupportTeam;
  redactions: Partial<Record<PiiKind, number>>;
}

/**
 * Redacts PII, asks the model, restores PII tokens in the free-text fields (they are stored for
 * agents, not sent anywhere) and applies routing. No database access, so the eval uses it too.
 */
export async function triageText(
  model: TriageModel,
  ticket: { subject: string; body: string },
): Promise<TriageResult> {
  const redactor = new Redactor();
  const redacted = { subject: redactor.redact(ticket.subject), body: redactor.redact(ticket.body) };
  const call = await model.classify(buildTriageMessage(redacted));
  const confidence = Math.min(1, Math.max(0, call.output.confidence));
  const output = {
    ...call.output,
    confidence,
    summary: redactor.restore(call.output.summary).trim().slice(0, 1000),
    reasoning: redactor.restore(call.output.reasoning).trim().slice(0, 2000),
  };
  return { ...call, output, team: routeTicket(output), redactions: redactor.stats };
}

/** Ticket text as the model sees it: subject, first message, follow-ups marked as in the golden set. */
export function ticketBody(messages: { body: string }[]): string {
  return messages.map((m) => m.body).join("\n\n[follow-up]\n");
}

/**
 * The `triage_ticket` job: triages one ticket and records the result. Only customer messages are
 * sent; agent replies and internal notes are not the customer's request.
 */
export async function triageTicket(
  db: AnyDatabase,
  model: TriageModel,
  { tenantId, ticketId, log }: { tenantId: string; ticketId: string; log: Logger },
) {
  const [ticket] = await db
    .select({ id: tickets.id, subject: tickets.subject })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)));
  if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found");

  const messages = await db
    .select({ body: ticketMessages.body })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.ticketId, ticketId),
        eq(ticketMessages.tenantId, tenantId),
        eq(ticketMessages.authorType, "customer"),
      ),
    )
    .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));

  const result = await triageText(model, { subject: ticket.subject, body: ticketBody(messages) });
  const { output } = result;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(triageResults)
      .values({
        tenantId,
        ticketId,
        category: output.category,
        priority: output.priority,
        sentiment: output.sentiment,
        language: output.language,
        isInjection: output.is_injection_attempt,
        summary: output.summary,
        suggestedTeam: output.suggested_team,
        reasoning: output.reasoning,
        promptVersion: TRIAGE_PROMPT_VERSION,
        confidence: output.confidence,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
      })
      .returning({ id: triageResults.id });
    await tx
      .update(tickets)
      .set({
        category: output.category,
        priority: output.priority,
        sentiment: output.sentiment,
        language: output.language,
        aiSummary: output.summary,
        team: result.team,
        injectionFlagged: output.is_injection_attempt,
        classifiedAt: new Date(),
      })
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)));
    await recordAudit(
      {
        tenantId,
        actorId: null,
        action: "ticket.triaged",
        entityType: "ticket",
        entityId: ticketId,
        metadata: {
          triageResultId: row.id,
          team: result.team,
          injection: output.is_injection_attempt,
          model: result.model,
        },
      },
      tx,
    );
  });

  // Counts only: never log ticket text, PII or the redaction map.
  log.info(
    {
      ticketId,
      category: output.category,
      priority: output.priority,
      team: result.team,
      injection: output.is_injection_attempt,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      redactions: result.redactions,
    },
    "ticket triaged",
  );
  return result;
}
