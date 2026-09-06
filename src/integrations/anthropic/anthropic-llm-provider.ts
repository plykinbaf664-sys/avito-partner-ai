import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";

import { RetryableInfrastructureError } from "../../application/errors/infrastructure-error";
import type {
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse,
} from "../../application/ports/llm-provider";

export interface AnthropicLLMProviderConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const unsupportedStructuredOutputKeywords = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
]);

function toAnthropicJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toAnthropicJsonSchema);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupportedStructuredOutputKeywords.has(key))
      .map(([key, nestedValue]) => [key, toAnthropicJsonSchema(nestedValue)]),
  );
}

function isRetryableAnthropicError(error: unknown): boolean {
  return (
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    error instanceof RateLimitError ||
    error instanceof InternalServerError ||
    (error instanceof APIError && (error.status ?? 0) >= 500)
  );
}

export class AnthropicLLMProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(
    private readonly config: AnthropicLLMProviderConfig,
    client?: Anthropic,
  ) {
    this.client =
      client ??
      new Anthropic({
        apiKey: config.apiKey,
        timeout: config.timeoutMs,
        // Event retry/idempotency belongs to the application workflow.
        maxRetries: 0,
      });
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: request.maxTokens,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userMessage }],
        ...(request.jsonSchema
          ? {
              output_config: {
                format: {
                  type: "json_schema" as const,
                  schema: toAnthropicJsonSchema(
                    request.jsonSchema,
                  ) as Record<string, unknown>,
                },
              },
            }
          : {}),
      });
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      return {
        text,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (error) {
      if (isRetryableAnthropicError(error)) {
        throw new RetryableInfrastructureError(
          "Anthropic is temporarily unavailable",
          { cause: error },
        );
      }
      throw error;
    }
  }
}

// Backward-compatible export for Foundation consumers.
export { AnthropicLLMProvider as AnthropicLlmProvider };
export type AnthropicLlmProviderConfig = AnthropicLLMProviderConfig;
