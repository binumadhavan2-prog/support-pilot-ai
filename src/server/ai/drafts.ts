import { readFileSync } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { aiDrafts, citations, ticketMessages, tickets, user } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "../audit";
import { searchKnowledge, type EmbedQuery } from "../knowledge/search";
import { citedNumbers } from "./answer";
import {
  DEFAULT_MODEL,
  callStructured,
  createMessagesApi,
  escapeHtml,
  type BetaMessagesApi,
  type ModelCall,
} from "./claude";
import { Redactor } from "./redact";

export const DRAFT_PROMPT_VERSION = "draft_v1";
export const DEFAULT_DRAFT_MODEL = DEFAULT_MODEL;

let systemPrompt: string | undefined;
export function draftSystemPrompt(): string {
  systemPrompt ??= readFileSync(
    path.join(process.cwd(), "src/server/ai/prompts", `${DRAFT_PROMPT_VERSION}.md`),
    "utf8",
  );
  return systemPrompt;
}

export const draftOutputSchema = z.object({
  status: z.enum(["answered", "insufficient_evidence"]),
  reply: z.string(),
  cited_sources: z.array(z.number()),
});

export type DraftOutput = z.infer<typeof draftOutputSchema>;

/** The model boundary. Production uses Claude; tests pass a mock (no network, no cost). */
export interface DraftModel {
  readonly model: string;
  draft(userMessage: string): Promise<ModelCall<DraftOutput>>;
}

export function createClaudeDraftModel({
  apiKey,
  model = DEFAULT_DRAFT_MODEL,
  messagesApi,
}: {
  apiKey: string;
  model?: string;
  messagesApi?: BetaMessagesApi;
}): DraftModel {
  const api = messagesApi ?? createMessagesApi(apiKey);
  return {
    model,
    draft: (userMessage) =>
      callStructured(api, {
        model,
        system: draftSystemPrompt(),
        user: userMessage,
        schema: draftOutputSchema,
        effort: "medium",
        maxTokens: 8000,
        task: "draft reply",
      }),
  };
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";

/**
 * Safe reply when the help articles don't cover the question: acknowledges the ticket and makes
 * no factual claim or promise, so nothing unsupported can reach the customer.
 */
export function fallbackReply(customerName: string) {
  return `Hi ${firstName(customerName)},\n\nThanks for getting in touch. I'm looking into this and will get back to you with an answer shortly.\n\nBest regards,`;
}

/** Citation markers help the reviewer; the customer never sees them. */
export function stripCitations(text: string) {
  return text
    .replace(/[ \t]*\[\d+\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function buildDraftMessage(
  ticket: { subject: string; body: string; customerName: string },
  sources: { documentTitle: string; content: string }[],
) {
  const sourceBlocks = sources
    .map(
      (s, i) =>
        `<source n="${i + 1}" title="${escapeHtml(s.documentTitle).replace(/"/g, "&quot;")}">\n${escapeHtml(s.content)}\n</source>`,
    )
    .join("\n");
  return [
    "Draft a reply to this ticket.",
    `<customer>${escapeHtml(firstName(ticket.customerName))}</customer>`,
    "<ticket>",
    `<subject>${escapeHtml(ticket.subject)}</subject>`,
    `<body>\n${escapeHtml(ticket.body)}\n</body>`,
    "</ticket>",
    "",
    `<sources>\n${sourceBlocks}\n</sources>`,
  ].join("\n");
}

async function loadTicketText(db: AnyDatabase, tenantId: string, ticketId: string) {
  if (!z.uuid().safeParse(ticketId).success) throw new AppError("NOT_FOUND", "Ticket not found");
  const [ticket] = await db
    .select({ id: tickets.id, subject: tickets.subject, customerName: tickets.customerName })
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
  return { ...ticket, messages: messages.map((m) => m.body) };
}

/**
 * Drafts a reply for a ticket from the tenant's help articles (never internal runbooks, since
 * the text is for the customer). With no matching article, or when the model says the articles
 * don't cover it, the draft is the fixed fallback and marked `insufficient_evidence`. A new draft
 * supersedes the ticket's earlier pending drafts.
 */
export async function generateDraft(
  db: AnyDatabase,
  { tenantId, ticketId, userId }: { tenantId: string; ticketId: string; userId: string },
  { embedQuery, model, log }: { embedQuery: EmbedQuery | null; model: DraftModel; log: Logger },
) {
  const ticket = await loadTicketText(db, tenantId, ticketId);
  const body = ticket.messages.join("\n\n[follow-up]\n");
  // The latest message says what the customer needs now; the subject anchors the topic.
  const query = `${ticket.subject}\n${ticket.messages.at(-1) ?? ""}`.slice(0, 1500);
  const hits = await searchKnowledge(db, tenantId, query, {
    embedQuery,
    kinds: ["article"],
    limit: 5,
    log,
  });

  let reply = fallbackReply(ticket.customerName);
  let grounded = false;
  let cited: number[] = [];
  let usage = { model: "none", inputTokens: 0, outputTokens: 0, latencyMs: 0 };

  if (hits.length > 0) {
    const redactor = new Redactor();
    const call = await model.draft(
      buildDraftMessage(
        {
          subject: redactor.redact(ticket.subject),
          body: redactor.redact(body),
          customerName: ticket.customerName,
        },
        hits,
      ),
    );
    usage = call;
    const text = redactor.restore(call.output.reply).trim();
    cited = citedNumbers(text, call.output.cited_sources, hits.length);
    // An uncited draft could be general knowledge: fall back rather than risk it (CLAUDE.md).
    if (call.output.status === "answered" && cited.length > 0 && text) {
      reply = text;
      grounded = true;
    } else {
      cited = [];
    }
  }

  const draftId = await db.transaction(async (tx) => {
    await tx
      .update(aiDrafts)
      .set({
        status: "rejected",
        rejectReason: "Superseded by a newer draft",
        reviewedById: userId,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(aiDrafts.ticketId, ticketId),
          eq(aiDrafts.tenantId, tenantId),
          eq(aiDrafts.status, "pending"),
        ),
      );
    const [row] = await tx
      .insert(aiDrafts)
      .values({
        tenantId,
        ticketId,
        body: reply,
        groundingStatus: grounded ? "grounded" : "insufficient_evidence",
        requestedById: userId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
      })
      .returning({ id: aiDrafts.id });
    const citedHits = hits.map((h, i) => ({ ...h, n: i + 1 })).filter((h) => cited.includes(h.n));
    if (citedHits.length > 0) {
      await tx.insert(citations).values(
        citedHits.map((h) => ({
          tenantId,
          draftId: row.id,
          chunkId: h.chunkId,
          position: h.n,
          documentTitle: h.documentTitle,
          quote: h.content.slice(0, 1000),
          score: h.score,
        })),
      );
    }
    await recordAudit(
      {
        tenantId,
        actorId: userId,
        action: "draft.generated",
        entityType: "ticket",
        entityId: ticketId,
        metadata: { draftId: row.id, grounded, sources: citedHits.length, model: usage.model },
      },
      tx,
    );
    return row.id;
  });

  log.info(
    { ticketId, draftId, grounded, hits: hits.length, cited: cited.length, ...usage },
    "draft generated",
  );
  return { draftId, grounded };
}

export const reviewSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    draftId: z.uuid(),
    body: z.string().trim().min(1, "The reply is empty").max(10_000),
  }),
  z.object({
    decision: z.literal("reject"),
    draftId: z.uuid(),
    reason: z.string().trim().max(500).optional(),
  }),
]);

export type ReviewInput = z.infer<typeof reviewSchema>;

/**
 * The human approval step. Approving adds the reply to the ticket's conversation as the
 * reviewer's message (status `edited` if they changed the text, else `approved`); rejecting
 * records why. Both are audited, and only a pending draft can be reviewed (no double send).
 */
export async function reviewDraft(
  db: AnyDatabase,
  { tenantId, reviewer }: { tenantId: string; reviewer: { id: string; name: string } },
  input: ReviewInput,
) {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(aiDrafts)
      .where(and(eq(aiDrafts.id, input.draftId), eq(aiDrafts.tenantId, tenantId)));
    if (!draft) throw new AppError("NOT_FOUND", "Draft not found");

    const reviewedAt = new Date();
    if (input.decision === "reject") {
      const [row] = await tx
        .update(aiDrafts)
        .set({
          status: "rejected",
          rejectReason: input.reason || null,
          reviewedById: reviewer.id,
          reviewedAt,
        })
        .where(and(eq(aiDrafts.id, draft.id), eq(aiDrafts.status, "pending")))
        .returning({ id: aiDrafts.id });
      if (!row) throw new AppError("CONFLICT", "This draft was already reviewed");
      await recordAudit(
        {
          tenantId,
          actorId: reviewer.id,
          action: "draft.rejected",
          entityType: "ticket",
          entityId: draft.ticketId,
          metadata: { draftId: draft.id, hasReason: Boolean(input.reason) },
        },
        tx,
      );
      return { status: "rejected" as const, ticketId: draft.ticketId };
    }

    const edited = stripCitations(input.body) !== stripCitations(draft.body);
    let finalBody = stripCitations(input.body);
    if (/Best regards,$/.test(finalBody)) finalBody += `\n${reviewer.name}`;
    const status = edited ? ("edited" as const) : ("approved" as const);

    const [row] = await tx
      .update(aiDrafts)
      .set({ status, finalBody, reviewedById: reviewer.id, reviewedAt })
      .where(and(eq(aiDrafts.id, draft.id), eq(aiDrafts.status, "pending")))
      .returning({ id: aiDrafts.id });
    if (!row) throw new AppError("CONFLICT", "This draft was already reviewed");

    await tx.insert(ticketMessages).values({
      tenantId,
      ticketId: draft.ticketId,
      authorType: "agent",
      authorId: reviewer.id,
      body: finalBody,
      sourceDraftId: draft.id,
    });
    const [ticket] = await tx
      .select({ status: tickets.status, firstResponseAt: tickets.firstResponseAt })
      .from(tickets)
      .where(and(eq(tickets.id, draft.ticketId), eq(tickets.tenantId, tenantId)));
    await tx
      .update(tickets)
      .set({
        firstResponseAt: ticket.firstResponseAt ?? reviewedAt,
        // Replied: now waiting on the customer.
        status: ticket.status === "open" ? "pending" : ticket.status,
      })
      .where(and(eq(tickets.id, draft.ticketId), eq(tickets.tenantId, tenantId)));
    await recordAudit(
      {
        tenantId,
        actorId: reviewer.id,
        action: edited ? "draft.edited_and_approved" : "draft.approved",
        entityType: "ticket",
        entityId: draft.ticketId,
        metadata: { draftId: draft.id, grounded: draft.groundingStatus === "grounded" },
      },
      tx,
    );
    return { status, ticketId: draft.ticketId };
  });
}

/** The ticket's most recent draft with its sources, for the ticket page. */
export async function getLatestDraft(db: AnyDatabase, tenantId: string, ticketId: string) {
  const [draft] = await db
    .select()
    .from(aiDrafts)
    .where(and(eq(aiDrafts.ticketId, ticketId), eq(aiDrafts.tenantId, tenantId)))
    .orderBy(desc(aiDrafts.createdAt))
    .limit(1);
  if (!draft) return null;
  const sources = await db
    .select({
      position: citations.position,
      documentTitle: citations.documentTitle,
      quote: citations.quote,
      score: citations.score,
    })
    .from(citations)
    .where(and(eq(citations.draftId, draft.id), eq(citations.tenantId, tenantId)))
    .orderBy(asc(citations.position));
  return { ...draft, sources };
}

/** Pending drafts across the tenant, oldest first (the review queue). */
export async function listPendingDrafts(db: AnyDatabase, tenantId: string) {
  return db
    .select({
      draftId: aiDrafts.id,
      ticketId: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      customerName: tickets.customerName,
      priority: tickets.priority,
      groundingStatus: aiDrafts.groundingStatus,
      requestedBy: user.name,
      createdAt: aiDrafts.createdAt,
    })
    .from(aiDrafts)
    .innerJoin(tickets, eq(tickets.id, aiDrafts.ticketId))
    .leftJoin(user, eq(user.id, aiDrafts.requestedById))
    .where(
      and(
        eq(aiDrafts.tenantId, tenantId),
        eq(tickets.tenantId, tenantId),
        eq(aiDrafts.status, "pending"),
      ),
    )
    .orderBy(asc(aiDrafts.createdAt));
}
