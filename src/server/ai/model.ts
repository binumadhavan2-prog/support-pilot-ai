import "server-only";
import { getEnv } from "@/env";
import { createClaudeAnswerModel, DEFAULT_ANSWER_MODEL, type AnswerModel } from "./answer";
import { createRulesTriageModel, createTemplateDraftModel } from "./builtin";
import { createClaudeDraftModel, DEFAULT_DRAFT_MODEL, type DraftModel } from "./drafts";
import { createClaudeTriageModel, DEFAULT_TRIAGE_MODEL, type TriageModel } from "./triage";

/**
 * "claude" when ANTHROPIC_API_KEY is set; otherwise "builtin": free, no-model mode (keyword
 * triage, template drafts, search-only answers). See ./builtin.ts.
 */
export type AiMode = "claude" | "builtin";

export function aiMode(): AiMode {
  return getEnv().ANTHROPIC_API_KEY ? "claude" : "builtin";
}

let triage: TriageModel | undefined;
let answer: AnswerModel | undefined;
let draft: DraftModel | undefined;

export function getTriageModel(): TriageModel {
  if (!triage) {
    const env = getEnv();
    triage = env.ANTHROPIC_API_KEY
      ? createClaudeTriageModel({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.TRIAGE_MODEL ?? DEFAULT_TRIAGE_MODEL,
        })
      : createRulesTriageModel();
  }
  return triage;
}

export function getDraftModel(): DraftModel {
  if (!draft) {
    const env = getEnv();
    draft = env.ANTHROPIC_API_KEY
      ? createClaudeDraftModel({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.ANSWER_MODEL ?? DEFAULT_DRAFT_MODEL,
        })
      : createTemplateDraftModel();
  }
  return draft;
}

/**
 * The knowledge-base answer model, or null without a key. There is no built-in answer writer:
 * search-only mode already shows the matching passages with their sources.
 */
export function getAnswerModel(): AnswerModel | null {
  const env = getEnv();
  if (!env.ANTHROPIC_API_KEY) return null;
  answer ??= createClaudeAnswerModel({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANSWER_MODEL ?? DEFAULT_ANSWER_MODEL,
  });
  return answer;
}
