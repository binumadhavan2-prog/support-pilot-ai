import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { citations, kbQueries } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "../audit";
import { searchKnowledge, type EmbedQuery, type SearchHit } from "../knowledge/search";
import {
  DEFAULT_MODEL,
  callStructured,
  createMessagesApi,
  escapeHtml,
  type BetaMessagesApi,
  type ModelCall,
} from "./claude";
import { Redactor } from "./redact";

export const ANSWER_PROMPT_VERSION = "answer_v1";
export const DEFAULT_ANSWER_MODEL = DEFAULT_MODEL;

/** Shown when the knowledge base has nothing relevant; the model is not called in that case. */
export const NO_SOURCES_ANSWER =
  "I couldn't find anything about this in the knowledge base. Check with a teammate, or add an article that covers it.";

let systemPrompt: string | undefined;
export function answerSystemPrompt(): string {
  systemPrompt ??= readFileSync(
    path.join(process.cwd(), "src/server/ai/prompts", `${ANSWER_PROMPT_VERSION}.md`),
    "utf8",
  );
  return systemPrompt;
}

export const answerOutputSchema = z.object({
  status: z.enum(["answered", "insufficient_evidence"]),
  answer: z.string(),
  cited_sources: z.array(z.number()),
});

export type AnswerOutput = z.infer<typeof answerOutputSchema>;

/** The model boundary. Production uses Claude; tests pass a mock (no network, no cost). */
export interface AnswerModel {
  readonly model: string;
  answer(userMessage: string): Promise<ModelCall<AnswerOutput>>;
}

export function createClaudeAnswerModel({
  apiKey,
  model = DEFAULT_ANSWER_MODEL,
  messagesApi,
}: {
  apiKey: string;
  model?: string;
  messagesApi?: BetaMessagesApi;
}): AnswerModel {
  const api = messagesApi ?? createMessagesApi(apiKey);
  return {
    model,
    answer: (userMessage) =>
      callStructured(api, {
        model,
        system: answerSystemPrompt(),
        user: userMessage,
        schema: answerOutputSchema,
        effort: "medium",
        maxTokens: 8000,
        task: "answer",
      }),
  };
}

/** Sources and question, escaped so neither can close or forge the surrounding tags. */
export function buildAnswerMessage(
  question: string,
  hits: Pick<SearchHit, "documentTitle" | "kind" | "content">[],
) {
  const sources = hits
    .map(
      (h, i) =>
        `<source n="${i + 1}" title="${escapeHtml(h.documentTitle).replace(/"/g, "&quot;")}" kind="${h.kind}">\n${escapeHtml(h.content)}\n</source>`,
    )
    .join("\n");
  return `<sources>\n${sources}\n</sources>\n\n<question>${escapeHtml(question)}</question>`;
}

/** Source numbers the answer text actually uses, limited to sources that exist. */
export function citedNumbers(answer: string, declared: number[], sourceCount: number) {
  const inText = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  return [...new Set([...inText, ...declared])]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount)
    .sort((a, b) => a - b);
}

export interface KbAnswer {
  mode: "ai" | "search_only";
  status: "answered" | "insufficient_evidence";
  answer: string | null;
  /** Sources the answer cites (AI mode), or the top search results (search-only mode). */
  sources: (SearchHit & { n: number })[];
  queryId: string | null;
  model: string | null;
}

/**
 * Answers a staff question from the tenant's knowledge base. Retrieval runs first; with no
 * relevant chunks the fallback is returned without calling the model. Without a model (no API
 * key) the matching sections are returned for the agent to read. An AI answer must cite its
 * sources, or it is downgraded to `insufficient_evidence`.
 */
export async function askKnowledgeBase(
  db: AnyDatabase,
  { tenantId, userId, question }: { tenantId: string; userId: string; question: string },
  {
    embedQuery,
    model,
    log,
  }: { embedQuery: EmbedQuery | null; model: AnswerModel | null; log: Logger },
): Promise<KbAnswer> {
  const hits = await searchKnowledge(db, tenantId, question, { embedQuery, log });
  const numbered = hits.map((h, i) => ({ ...h, n: i + 1 }));

  if (!model) {
    return {
      mode: "search_only",
      status: hits.length ? "answered" : "insufficient_evidence",
      answer: null,
      sources: numbered,
      queryId: null,
      model: null,
    };
  }
  if (hits.length === 0) {
    return {
      mode: "ai",
      status: "insufficient_evidence",
      answer: NO_SOURCES_ANSWER,
      sources: [],
      queryId: null,
      model: null,
    };
  }

  const redactor = new Redactor();
  const call = await model.answer(buildAnswerMessage(redactor.redact(question), hits));
  const answerText = redactor.restore(call.output.answer).trim();
  const cited = citedNumbers(answerText, call.output.cited_sources, hits.length);
  // "Answers must cite retrieved chunks" (CLAUDE.md): an uncited answer is not trusted.
  const status =
    call.output.status === "answered" && cited.length > 0 ? "answered" : "insufficient_evidence";
  const sources = numbered.filter((h) => cited.includes(h.n));

  const queryId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(kbQueries)
      .values({
        tenantId,
        question,
        answer: answerText,
        groundingStatus: status === "answered" ? "grounded" : "insufficient_evidence",
        askedById: userId,
        model: call.model,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        latencyMs: call.latencyMs,
      })
      .returning({ id: kbQueries.id });
    if (sources.length > 0) {
      await tx.insert(citations).values(
        sources.map((s) => ({
          tenantId,
          queryId: row.id,
          chunkId: s.chunkId,
          position: s.n,
          documentTitle: s.documentTitle,
          quote: s.content.slice(0, 1000),
          score: s.score,
        })),
      );
    }
    await recordAudit(
      {
        tenantId,
        actorId: userId,
        action: "kb.asked",
        entityType: "kb_query",
        entityId: row.id,
        // No question text: it may contain customer data.
        metadata: { status, sources: sources.length, model: call.model },
      },
      tx,
    );
    return row.id;
  });

  log.info(
    {
      queryId,
      status,
      hits: hits.length,
      cited: cited.length,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
    },
    "knowledge base question answered",
  );
  return { mode: "ai", status, answer: answerText, sources, queryId, model: call.model };
}
