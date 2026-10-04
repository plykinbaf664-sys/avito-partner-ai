import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { RetryableInfrastructureError } from "@/application/errors/infrastructure-error";
import type { LlmProvider, LlmTextRequest, LlmTextResponse } from "@/application/ports/llm-provider";
import { ConsoleStructuredLogger, type StructuredLogger } from "@/application/observability/structured-logger";
import type { LlmCallRecord, LlmUsageRepository } from "@/application/observability/llm-usage";
import { runtimeRelease } from "../anthropic/runtime-release";
import { prepareQwenContext, qwenJsonSchema } from "./context";
import type { QwenConfig } from "./config";

const tokenCount = z.number().int().nonnegative();
const usageSchema = z.object({ prompt_tokens: tokenCount, completion_tokens: tokenCount,
  prompt_tokens_details: z.object({ cached_tokens: tokenCount.optional(), cache_creation_input_tokens: tokenCount.optional() }).nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: tokenCount.optional() }).nullish() });
const completionSchema = z.object({ model: z.string().min(1), id: z.string().optional(), usage: usageSchema,
  choices: z.array(z.object({ finish_reason: z.string().nullable(), message: z.object({ content: z.string().nullable(),
    refusal: z.string().nullish() }) })).min(1) });

function safeEmit(logger: StructuredLogger, level: "info" | "error", event: string,
  fields: Parameters<StructuredLogger["info"]>[1]) { try { logger[level](event, fields); } catch { /* no paid replay */ } }

export const QWEN_PRICING_VERSION = "qwen-singapore-international-2026-09-28";
export function qwenCostMicrousd(record: Pick<LlmCallRecord, "model" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens">) {
  if (record.model !== "qwen3.8-flash" || record.inputTokens === null || record.outputTokens === null) return null;
  // Singapore standard tariffs, not promotional prices/invoices. Qwen prompt_tokens includes cache reads/writes.
  return Math.round(0.15 * record.inputTokens + 0.47 * record.outputTokens +
    0.016 * (record.cacheReadInputTokens ?? 0) + 0.2 * (record.cacheCreationInputTokens ?? 0));
}

export class QwenLLMProvider implements LlmProvider {
  readonly promptProfile = "compact-v1" as const;
  constructor(private readonly config: QwenConfig, private readonly fetcher: typeof fetch = fetch,
    private readonly observability: { usage?: LlmUsageRepository; logger?: StructuredLogger;
      workload?: LlmCallRecord["workload"]; release?: string } = {}) {}

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    const payload = prepareQwenContext(request, this.config);
    const started = performance.now();
    const logger = this.observability.logger ?? new ConsoleStructuredLogger();
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const record: LlmCallRecord = { id: randomUUID(), requestId: request.metadata?.requestId ?? randomUUID(),
      eventId: request.metadata?.eventId ?? null, leadId: request.metadata?.leadId ?? null,
      conversationId: request.metadata?.conversationId ?? null, source: request.metadata?.source ?? null,
      operation: request.metadata?.operation ?? "INBOUND", workload: this.observability.workload ?? "DEVELOPMENT",
      stage: request.metadata?.stage ?? "UNCLASSIFIED", attempt: request.metadata?.attempt ?? 1,
      promptVersion: request.metadata?.promptVersion ?? "unversioned", promptHash: hash(payload.messages[0]),
      schemaHash: hash(request.jsonSchema ? qwenJsonSchema(request.jsonSchema) : null), release: this.observability.release ?? runtimeRelease(),
      provider: "qwen", model: this.config.model, cacheMode: request.cache ? this.config.cacheMode : "implicit",
      thinkingMode: this.config.thinkingMode, thinkingBudget: this.config.thinkingMode === "bounded" ? this.config.thinkingBudget : 0,
      structuredOutputMode: request.jsonSchema ? this.config.structuredOutput : "text",
      status: "STARTED", startedAt: new Date(), completedAt: null, latencyMs: null, inputTokens: null,
      outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, cacheCreation5mInputTokens: null,
      cacheCreation1hInputTokens: null, providerTotalInputTokens: null, reasoningTokens: null,
      stopReason: null, providerRequestId: null, errorCode: null, estimatedCostMicrousd: null, pricingVersion: QWEN_PRICING_VERSION };
    const persist = async () => {
      safeEmit(logger, "info", "llm.call", { ...record, startedAt: record.startedAt.toISOString(), completedAt: record.completedAt?.toISOString() ?? null });
      try { await this.observability.usage?.record({ ...record }); }
      catch { safeEmit(logger, "error", "llm.usage_persistence_failed", { callId: record.id, status: record.status }); }
    };
    await persist();
    let knownResponse: LlmTextResponse | undefined;
    let status: number | undefined;
    const reject = (code: string, retryable = false): Error => Object.assign(retryable
      ? new RetryableInfrastructureError("Qwen request unavailable") : new Error("Qwen request rejected"),
      { code, status, retryable, llmCallId: record.id, ...(knownResponse ? { llmResponseUsage: knownResponse } : {}) });
    try {
      const response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` }, body: JSON.stringify(payload) });
      status = response.status;
      record.providerRequestId = response.headers.get("x-request-id") ?? response.headers.get("x-dashscope-request-id");
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const upstreamCode = typeof body?.error?.code === "string" ? body.error.code : "";
        record.providerErrorCode = ["AccessDenied.Unpurchased", "Model.AccessDenied", "Workspace.AccessDenied",
          "InvalidApiKey", "QuotaExceeded", "InsufficientBalance", "Throttling.RateQuota", "AllocationQuota.FreeTierOnly"].includes(upstreamCode)
          ? upstreamCode : null;
        record.providerFailureCategory = status === 402 || ["AccessDenied.Unpurchased", "QuotaExceeded", "InsufficientBalance"].includes(upstreamCode)
          ? "BILLING" : [401, 403].includes(status) ? "AUTH" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "AVAILABILITY" : "REQUEST";
        throw reject(`QWEN_HTTP_${status}`, [408, 429].includes(status) || status >= 500);
      }
      const parsed = completionSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw reject("QWEN_INVALID_RESPONSE");
      const completion = parsed.data;
      const created = completion.usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
      const cached = completion.usage.prompt_tokens_details?.cached_tokens ?? 0;
      if (created + cached > completion.usage.prompt_tokens) throw reject("QWEN_INVALID_USAGE");
      const choice = completion.choices[0]!;
      Object.assign(record, { status: "SUCCESS", model: completion.model, completedAt: new Date(),
        latencyMs: Math.round(performance.now() - started), inputTokens: completion.usage.prompt_tokens - created - cached,
        providerTotalInputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens,
        cacheCreationInputTokens: created, cacheReadInputTokens: cached, cacheCreation5mInputTokens: created, cacheCreation1hInputTokens: 0,
        reasoningTokens: completion.usage.completion_tokens_details?.reasoning_tokens ?? null,
        stopReason: choice.finish_reason, providerRequestId: record.providerRequestId ?? completion.id ?? null });
      record.estimatedCostMicrousd = qwenCostMicrousd(record);
      knownResponse = { text: choice.message.content ?? "", provider: "qwen", model: record.model,
        inputTokens: record.inputTokens!, outputTokens: record.outputTokens!, callId: record.id,
        cacheCreationInputTokens: created, cacheReadInputTokens: cached, estimatedCostMicrousd: record.estimatedCostMicrousd };
      if (completion.model !== this.config.model) throw reject("QWEN_MODEL_MISMATCH");
      if (choice.finish_reason !== "stop" || choice.message.refusal || !choice.message.content) throw reject(
        choice.finish_reason === "length" ? "QWEN_OUTPUT_TRUNCATED" : "QWEN_OUTPUT_UNAVAILABLE");
      await persist();
      return knownResponse;
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code :
        status === undefined ? "QWEN_TRANSPORT_ERROR" : "QWEN_INVALID_RESPONSE";
      Object.assign(record, { status: knownResponse ? "SUCCESS" : "ERROR", completedAt: new Date(),
        latencyMs: Math.round(performance.now() - started), errorCode: code,
        ...(knownResponse ? { validationOutcome: "REJECTED", validationErrorCode: code } : {}) });
      record.providerFailureCategory ??= status === undefined ? "AVAILABILITY" : "REQUEST";
      await persist();
      throw reject(code, status === undefined || [408, 429].includes(status) || status >= 500);
    }
  }

  async annotateCall(callId: string | undefined, outcome: "ACCEPTED" | "REJECTED", errorCode?: string) {
    if (!callId) return;
    const safeCode = errorCode && /^[A-Z0-9_]+$/u.test(errorCode) ? errorCode : undefined;
    const logger = this.observability.logger ?? new ConsoleStructuredLogger();
    safeEmit(logger, "info", "llm.validation", { callId, outcome, errorCode: safeCode ?? null });
    try { await this.observability.usage?.annotate?.(callId, outcome, safeCode); }
    catch { safeEmit(logger, "error", "llm.usage_annotation_failed", { callId }); }
  }
}
