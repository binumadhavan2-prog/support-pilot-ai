import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import type { AnswerModel, AnswerOutput } from "@/server/ai/answer";
import type { DraftModel, DraftOutput } from "@/server/ai/drafts";

/**
 * MOCK embedder: hashes each word into one of 384 dimensions and normalizes, so texts sharing
 * words get similar vectors. Deterministic, instant, and no model download. It tests the
 * plumbing (storage, cosine search, fusion), not retrieval quality.
 */
export function mockEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % EMBEDDING_DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export const mockEmbedder = {
  embedPassages: async (texts: string[]) => texts.map(mockEmbed),
  embedQuery: async (text: string) => mockEmbed(text),
};

/** MOCK answer model: records the messages it receives and returns a canned answer. */
export function mockAnswerModel(
  answer: Partial<AnswerOutput> | ((message: string) => Partial<AnswerOutput>) = {},
): AnswerModel & { messages: string[] } {
  const messages: string[] = [];
  return {
    model: "mock-answer-model",
    messages,
    async answer(message) {
      messages.push(message);
      const overrides = typeof answer === "function" ? answer(message) : answer;
      return {
        output: {
          status: "answered",
          answer: "Refunds for duplicate charges are issued from the Billing page [1].",
          cited_sources: [1],
          ...overrides,
        },
        model: "mock-answer-model",
        inputTokens: 2000,
        outputTokens: 120,
        latencyMs: 55,
      };
    },
  };
}

/** MOCK draft model: records the messages it receives and returns a canned reply. */
export function mockDraftModel(
  reply: Partial<DraftOutput> | ((message: string) => Partial<DraftOutput>) = {},
): DraftModel & { messages: string[] } {
  const messages: string[] = [];
  return {
    model: "mock-draft-model",
    messages,
    async draft(message) {
      messages.push(message);
      const overrides = typeof reply === "function" ? reply(message) : reply;
      return {
        output: {
          status: "answered",
          reply:
            "Hi Priya,\n\nSorry about the double charge. Open Billing, select the duplicate invoice and click Refund [1]. It reaches your card in 5 to 7 business days [1].\n\nBest regards,",
          cited_sources: [1],
          ...overrides,
        },
        model: "mock-draft-model",
        inputTokens: 2500,
        outputTokens: 180,
        latencyMs: 70,
      };
    },
  };
}
