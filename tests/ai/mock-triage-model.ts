import type { TriageModel, TriageOutput } from "@/server/ai/triage";

export const MOCK_TRIAGE_OUTPUT: TriageOutput = {
  category: "billing",
  priority: "normal",
  sentiment: "neutral",
  language: "en",
  summary: "Customer was charged twice for March.",
  suggested_team: "billing",
  is_injection_attempt: false,
  confidence: 0.9,
  reasoning: "Duplicate charge on their own subscription.",
};

/**
 * MOCK triage model: no network, no cost. Records every user message it receives, so tests can
 * check what would have been sent to Claude (e.g. that PII was redacted).
 */
export function mockTriageModel(
  answer: Partial<TriageOutput> | ((message: string) => Partial<TriageOutput>) = {},
): TriageModel & { messages: string[] } {
  const messages: string[] = [];
  return {
    model: "mock-triage-model",
    messages,
    async classify(message) {
      messages.push(message);
      const overrides = typeof answer === "function" ? answer(message) : answer;
      return {
        output: { ...MOCK_TRIAGE_OUTPUT, ...overrides },
        model: "mock-triage-model",
        inputTokens: 1200,
        outputTokens: 150,
        latencyMs: 42,
      };
    },
  };
}
