import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createClaudeClient, type MessagesApi } from "../../seed/lib/claude";

/** MOCK of the Anthropic messages API: replays scripted tool inputs and records each request. */
function mockMessagesApi(toolInputs: unknown[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const api = {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      requests.push(params);
      const input = toolInputs[requests.length - 1];
      return {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: params.model,
        stop_reason: "tool_use",
        stop_sequence: null,
        content: [{ type: "tool_use", id: `tool_${requests.length}`, name: "submit", input }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: requests.length > 1 ? 80 : 0,
          cache_creation_input_tokens: requests.length === 1 ? 80 : 0,
        },
      } as unknown as Anthropic.Message;
    },
  };
  return { api: api as unknown as MessagesApi, requests };
}

const request = {
  system: "system prompt",
  prompt: "make two items",
  toolName: "submit",
  toolDescription: "Submit items",
  schema: z.object({ items: z.array(z.string()) }),
  check: (v: { items: string[] }) => (v.items.length === 2 ? [] : ["need exactly 2 items"]),
};

describe("createClaudeClient", () => {
  it("returns the validated tool input and marks the system prompt cacheable", async () => {
    const { api, requests } = mockMessagesApi([{ items: ["a", "b"] }]);
    const client = createClaudeClient({ apiKey: "test", model: "test-model", messagesApi: api });

    await expect(client.call(request)).resolves.toEqual({ items: ["a", "b"] });
    expect(requests).toHaveLength(1);
    expect(requests[0].tool_choice).toEqual({ type: "tool", name: "submit" });
    expect(requests[0].system).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("feeds schema and check errors back to the model and retries", async () => {
    const { api, requests } = mockMessagesApi([
      { items: "not-an-array" },
      { items: ["only one"] },
      { items: ["a", "b"] },
    ]);
    const client = createClaudeClient({ apiKey: "test", model: "test-model", messagesApi: api });

    await expect(client.call(request)).resolves.toEqual({ items: ["a", "b"] });
    expect(requests).toHaveLength(3);
    const lastTurn = requests[2].messages.at(-1)!;
    expect(lastTurn.role).toBe("user");
    expect(JSON.stringify(lastTurn.content)).toContain("need exactly 2 items");
    expect(JSON.stringify(lastTurn.content)).toContain('"is_error":true');
  });

  it("gives up after maxAttempts with the last errors", async () => {
    const { api } = mockMessagesApi([{ items: [] }, { items: [] }]);
    const client = createClaudeClient({
      apiKey: "test",
      model: "test-model",
      maxAttempts: 2,
      messagesApi: api,
    });
    await expect(client.call(request)).rejects.toThrow(/after 2 attempts[\s\S]*need exactly 2/);
  });

  it("sums token usage across calls", async () => {
    const { api } = mockMessagesApi([{ items: [] }, { items: ["a", "b"] }]);
    const client = createClaudeClient({ apiKey: "test", model: "test-model", messagesApi: api });
    await client.call(request);
    expect(client.usage()).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 80,
      cacheWriteTokens: 80,
    });
  });
});
