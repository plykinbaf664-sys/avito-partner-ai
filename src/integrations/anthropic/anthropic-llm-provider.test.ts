import Anthropic, { APIConnectionError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { AnthropicLLMProvider } from "./anthropic-llm-provider";

describe("AnthropicLLMProvider", () => {
  it("maps Anthropic availability failures to a retryable infrastructure error", async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(
          new APIConnectionError({
            message: "network unavailable",
            cause: new Error("ECONNRESET"),
          }),
        ),
      },
    } as unknown as Anthropic;
    const provider = new AnthropicLLMProvider(
      { apiKey: "test-key", model: "test-model", timeoutMs: 50 },
      client,
    );

    await expect(
      provider.generateText({
        systemPrompt: "Extract JSON",
        userMessage: "test",
        maxTokens: 100,
      }),
    ).rejects.toMatchObject({
      name: "RetryableInfrastructureError",
      retryable: true,
    });
  });

  it("passes a requested JSON schema to the official SDK", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"ok":true}' }],
      model: "test-model",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const provider = new AnthropicLLMProvider(
      { apiKey: "test-key", model: "test-model", timeoutMs: 50 },
      client,
    );

    await provider.generateText({
      systemPrompt: "Extract JSON",
      userMessage: "test",
      maxTokens: 100,
      jsonSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          amount: { type: "integer", minimum: 0, maximum: 10 },
        },
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                amount: { type: "integer" },
              },
            },
          },
        },
      }),
    );
  });
});
