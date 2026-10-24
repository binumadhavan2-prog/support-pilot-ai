import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AppError } from "@/lib/errors";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** The slice of the SDK used here, so tests can inject a mock. */
export type BetaMessagesApi = Pick<Anthropic["beta"]["messages"], "parse">;

export function createMessagesApi(apiKey: string): BetaMessagesApi {
  return new Anthropic({ apiKey, maxRetries: 3 }).beta.messages;
}

export interface ModelCall<T> {
  output: T;
  /** The model that answered (a server-side fallback can differ from the one requested). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * One structured-output request: a cached system prompt, one user message, and a Zod schema the
 * answer must match. Records the model, tokens and latency for every call (see CLAUDE.md).
 */
export async function callStructured<T extends z.ZodType>(
  api: BetaMessagesApi,
  request: {
    model: string;
    system: string;
    user: string;
    schema: T;
    effort: "low" | "medium" | "high";
    maxTokens: number;
    /** Used in error messages, e.g. "triage". */
    task: string;
  },
): Promise<ModelCall<z.infer<T>>> {
  const startedAt = performance.now();
  const response = await api.parse({
    model: request.model,
    max_tokens: request.maxTokens,
    output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema) },
    // If a safety classifier declines (adversarial-looking text can trigger one), the API retries
    // on a fallback model instead of failing the request.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request.user }],
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  if (response.stop_reason === "refusal") {
    throw new AppError("UPSTREAM_ERROR", `The model declined the ${request.task} request`);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new AppError("UPSTREAM_ERROR", `The model returned an incomplete ${request.task}`);
  }
  return {
    output: request.schema.parse(response.parsed_output),
    model: response.model,
    inputTokens:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
    latencyMs,
  };
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
