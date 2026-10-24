import "server-only";
import { getEnv } from "@/env";
import { AppError } from "@/lib/errors";
import { createClaudeAnswerModel, DEFAULT_ANSWER_MODEL, type AnswerModel } from "./answer";
import { createClaudeDraftModel, DEFAULT_DRAFT_MODEL, type DraftModel } from "./drafts";
import { createClaudeTriageModel, DEFAULT_TRIAGE_MODEL, type TriageModel } from "./triage";

let triage: TriageModel | undefined;
let answer: AnswerModel | undefined;

/** The configured triage model. Fails with a clear error (and the job retries) when no key is set. */
export function getTriageModel(): TriageModel {
  if (!triage) {
    const env = getEnv();
    if (!env.ANTHROPIC_API_KEY) {
      throw new AppError("SERVICE_UNAVAILABLE", "ANTHROPIC_API_KEY is not set; AI triage is off");
    }
    triage = createClaudeTriageModel({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.TRIAGE_MODEL ?? DEFAULT_TRIAGE_MODEL,
    });
  }
  return triage;
}

let draft: DraftModel | undefined;

/** The draft-reply model, or null when no key is set (drafting is unavailable). */
export function getDraftModel(): DraftModel | null {
  const env = getEnv();
  if (!env.ANTHROPIC_API_KEY) return null;
  draft ??= createClaudeDraftModel({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANSWER_MODEL ?? DEFAULT_DRAFT_MODEL,
  });
  return draft;
}

/** The knowledge-base answer model, or null when no key is set (search-only mode). */
export function getAnswerModel(): AnswerModel | null {
  const env = getEnv();
  if (!env.ANTHROPIC_API_KEY) return null;
  answer ??= createClaudeAnswerModel({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANSWER_MODEL ?? DEFAULT_ANSWER_MODEL,
  });
  return answer;
}
