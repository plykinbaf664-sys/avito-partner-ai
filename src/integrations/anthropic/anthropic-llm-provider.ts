import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { createHash, randomUUID } from "node:crypto";
import { ConsoleStructuredLogger, type StructuredLogger } from "../../application/observability/structured-logger";
import type { LlmCallRecord, LlmUsageRepository } from "../../application/observability/llm-usage";
import { prepareAnthropicContext } from "./prompt-context";
import { estimateCostMicrousd, LLM_PRICING_VERSION } from "./usage-cost";
import { runtimeRelease } from "./runtime-release";

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

function emit(logger: StructuredLogger, level: "info" | "error", event: string, fields: Parameters<StructuredLogger["info"]>[1]) {
  try { logger[level](event, fields); } catch { /* Observability must not change API retry/delivery semantics. */ }
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

export function toAnthropicJsonSchema(value: unknown): unknown {
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
    private readonly observability: { usage?: LlmUsageRepository; logger?: StructuredLogger;
      workload?: LlmCallRecord["workload"]; release?: string } = {},
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
    const prepared = prepareAnthropicContext(request);
    const schema = request.jsonSchema ? toAnthropicJsonSchema(request.jsonSchema) as Record<string, unknown> : undefined;
    const startedAt = new Date();
    const started = performance.now();
    const logger = this.observability.logger ?? new ConsoleStructuredLogger();
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const record: LlmCallRecord = {
      id: randomUUID(), requestId: request.metadata?.requestId ?? randomUUID(),
      eventId: request.metadata?.eventId ?? null, leadId: request.metadata?.leadId ?? null,
      conversationId: request.metadata?.conversationId ?? null, source: request.metadata?.source ?? null,
      operation: request.metadata?.operation ?? "INBOUND", workload: this.observability.workload ?? "DEVELOPMENT",
      stage: request.metadata?.stage ?? "UNCLASSIFIED", attempt: request.metadata?.attempt ?? 1,
      promptVersion: request.metadata?.promptVersion ?? "unversioned", promptHash: hash(prepared.system), schemaHash: hash(schema ?? null),
      release: this.observability.release ?? runtimeRelease(), model: this.config.model,
      provider: "anthropic", cacheMode: request.cache ? "explicit" : "none", structuredOutputMode: schema ? "json_schema" : "text",
      status: "STARTED", startedAt, completedAt: null, latencyMs: null, inputTokens: null, outputTokens: null,
      cacheCreationInputTokens: null, cacheReadInputTokens: null, cacheCreation5mInputTokens: null,
      cacheCreation1hInputTokens: null, stopReason: null, providerRequestId: null, errorCode: null,
      estimatedCostMicrousd: null, pricingVersion: LLM_PRICING_VERSION,
    };
    const persist = async () => {
      // This allowlisted record contains no transcript, prompt, response, credentials or provider error body.
      emit(logger, "info", "llm.call", { ...record, startedAt: record.startedAt.toISOString(), completedAt: record.completedAt?.toISOString() ?? null });
      try { await this.observability.usage?.record(record); }
      catch { emit(logger, "error", "llm.usage_persistence_failed", { callId: record.id, requestId: record.requestId, status: record.status }); }
    };
    await persist();
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: request.maxTokens,
        system: prepared.system,
        messages: [{ role: "user", content: prepared.userMessage }],
        ...(schema
          ? {
              output_config: {
                format: {
                  type: "json_schema" as const,
                  schema,
                },
              },
            }
          : {}),
      });
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      const created = response.usage.cache_creation_input_tokens ?? 0;
      const oneHour = response.usage.cache_creation?.ephemeral_1h_input_tokens ?? (request.cache?.ttl === "1h" ? created : 0);
      Object.assign(record, { status: "SUCCESS", model: response.model, completedAt: new Date(),
        latencyMs: Math.round(performance.now() - started), inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens, cacheCreationInputTokens: created,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreation5mInputTokens: response.usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, created - oneHour),
        cacheCreation1hInputTokens: oneHour, stopReason: response.stop_reason ?? null,
        providerRequestId: response._request_id ?? null });
      record.estimatedCostMicrousd = estimateCostMicrousd(record);
      await persist();

      return {
        text,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        callId: record.id,
        cacheCreationInputTokens: record.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: record.cacheReadInputTokens ?? 0,
        estimatedCostMicrousd: record.estimatedCostMicrousd,
      };
    } catch (error) {
      // Provider protocol diagnostics only; never used to route human messages.
      const failureCategory = error instanceof APIError && error.status === 400 && error.message.toLowerCase().includes("credit balance")
        ? "BILLING" : error instanceof APIError && [401, 403].includes(error.status ?? 0) ? "AUTH" :
          error instanceof RateLimitError ? "RATE_LIMIT" : isRetryableAnthropicError(error) ? "AVAILABILITY" : "REQUEST";
      Object.assign(record, { status: "ERROR", completedAt: new Date(), latencyMs: Math.round(performance.now() - started),
        providerFailureCategory: failureCategory,
        errorCode: error instanceof APIError && error.status !== undefined ? `ANTHROPIC_HTTP_${error.status}` :
          isRetryableAnthropicError(error) ? "ANTHROPIC_CONNECTION_ERROR" : "ANTHROPIC_ERROR",
        providerRequestId: error instanceof APIError ? error.requestID ?? null : null });
      await persist();
      if (error instanceof APIError && error.status !== undefined) {
        const retryable = isRetryableAnthropicError(error);
        const message = `Anthropic request failed (HTTP ${error.status})`;
        // SDK API errors have name="Error". Preserve a stable diagnostic code
        // without logging the provider body, request headers or credentials.
        throw Object.assign(
          retryable
            ? new RetryableInfrastructureError(message, { cause: error })
            : new Error(message, { cause: error }),
          { code: `ANTHROPIC_HTTP_${error.status}`, status: error.status, retryable, llmCallId: record.id },
        );
      }
      if (isRetryableAnthropicError(error)) {
        throw Object.assign(new RetryableInfrastructureError(
          "Anthropic is temporarily unavailable",
          { cause: error },
        ), { llmCallId: record.id });
      }
      if (error instanceof Error) Object.assign(error, { llmCallId: record.id });
      throw error;
    }
  }
  async annotateCall(callId: string | undefined, outcome: "ACCEPTED" | "REJECTED", errorCode?: string): Promise<void> {
    if (!callId) return;
    const safeCode = errorCode && /^[A-Z0-9_]+$/u.test(errorCode) ? errorCode : undefined;
    const logger = this.observability.logger ?? new ConsoleStructuredLogger();
    emit(logger, "info", "llm.validation", { callId, outcome, errorCode: safeCode ?? null });
    try { await this.observability.usage?.annotate?.(callId, outcome, safeCode); }
    catch { emit(logger, "error", "llm.usage_annotation_failed", { callId }); }
  }
}

// Backward-compatible export for Foundation consumers.
export { AnthropicLLMProvider as AnthropicLlmProvider };
export type AnthropicLlmProviderConfig = AnthropicLLMProviderConfig;
