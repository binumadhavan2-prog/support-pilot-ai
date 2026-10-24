import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/*
 * Minimal structured-output client for the seed generator: forces a single tool call, validates
 * the tool input with Zod, and on a validation failure sends the errors back so the model can fix
 * its answer (up to `maxAttempts`). The system prompt is marked cacheable, so the shared fact
 * sheet is billed once per cache window instead of once per call.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredRequest<T extends z.ZodType> {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: T;
  maxTokens?: number;
  /** Extra checks beyond the schema (e.g. "refs must match the request"). Return error strings. */
  check?: (value: z.infer<T>) => string[];
}

export interface StructuredClient {
  readonly model: string;
  call<T extends z.ZodType>(request: StructuredRequest<T>): Promise<z.infer<T>>;
  usage(): Usage;
}

/** The slice of the SDK we use; tests pass a mock (no network, no cost). */
export type MessagesApi = Pick<Anthropic["messages"], "create">;

export function createClaudeClient({
  apiKey,
  model,
  maxAttempts = 3,
  messagesApi,
}: {
  apiKey: string;
  model: string;
  maxAttempts?: number;
  messagesApi?: MessagesApi;
}): StructuredClient {
  // The SDK retries 429/5xx itself with backoff; allow a few more for long generation runs.
  const api = messagesApi ?? new Anthropic({ apiKey, maxRetries: 4 }).messages;
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  return {
    model,
    usage: () => ({ ...total }),
    async call(request) {
      const inputSchema = z.toJSONSchema(request.schema) as Anthropic.Tool.InputSchema;
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: request.prompt }];

      for (let attempt = 1; ; attempt++) {
        const response = (await api.create({
          model,
          max_tokens: request.maxTokens ?? 8000,
          system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
          tools: [
            {
              name: request.toolName,
              description: request.toolDescription,
              input_schema: inputSchema,
            },
          ],
          tool_choice: { type: "tool", name: request.toolName },
          // Copy: later retries append to `messages`, and callers (or mocks) may keep a reference.
          messages: [...messages],
          stream: false,
        })) as Anthropic.Message;
        total.inputTokens += response.usage.input_tokens;
        total.outputTokens += response.usage.output_tokens;
        total.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
        total.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

        const toolUse = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );
        const errors: string[] = [];
        if (response.stop_reason === "max_tokens") {
          errors.push("The answer was cut off (max_tokens). Be more concise.");
        }
        let value: z.infer<typeof request.schema> | undefined;
        if (!toolUse) errors.push(`Call the ${request.toolName} tool.`);
        else {
          const parsed = request.schema.safeParse(toolUse.input);
          if (!parsed.success) errors.push(z.prettifyError(parsed.error));
          else {
            value = parsed.data;
            errors.push(...(request.check?.(parsed.data) ?? []));
          }
        }

        if (errors.length === 0 && value !== undefined) return value;
        if (attempt >= maxAttempts) {
          throw new Error(
            `${request.toolName}: invalid output after ${attempt} attempts:\n${errors.join("\n")}`,
          );
        }
        // Ask for a corrected answer, keeping the failed attempt in context.
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: toolUse
            ? [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  is_error: true,
                  content: `Invalid. Fix these problems and call the tool again with the complete corrected answer:\n${errors.join("\n")}`,
                },
              ]
            : `Invalid: ${errors.join(" ")}`,
        });
      }
    },
  };
}
