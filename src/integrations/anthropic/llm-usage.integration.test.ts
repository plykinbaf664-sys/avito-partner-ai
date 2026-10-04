import Anthropic from "@anthropic-ai/sdk";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { AnthropicLLMProvider } from "./anthropic-llm-provider";
import { estimateCostMicrousd } from "./usage-cost";
import { buildLlmUsageReport } from "@/application/observability/llm-usage-report";
import { prepareAnthropicContext } from "./prompt-context";

describe("durable API usage and context", () => {
  let persistence: SqlitePersistence;
  beforeEach(async () => { persistence = await SqlitePersistence.createMigrated("file::memory:", resolve(process.cwd(), "drizzle")); });
  afterEach(() => persistence.close());
  const logger = { info: vi.fn(), error: vi.fn() };
  const metadata = { stage: "GENERATION", attempt: 1, promptVersion: "test-v1", requestId: "workflow-1", eventId: "event-1", operation: "INBOUND" as const };

  it("persists the start before API work, then complete cache usage and delivery outcome", async () => {
    let complete!: (value: unknown) => void;
    const create = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const provider = new AnthropicLLMProvider({ apiKey: "secret-test-key", model: "claude-sonnet-4-6", timeoutMs: 50 },
      { messages: { create } } as unknown as Anthropic, { usage: persistence.llmUsage, logger, workload: "PRODUCTION" });
    const operation = provider.generateText({ systemPrompt: "private prompt", userMessage: "private customer text", maxTokens: 100, metadata });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(await persistence.llmUsage.list()).toMatchObject([{ status: "STARTED", inputTokens: null }]);
    complete({ model: "claude-sonnet-4-6", content: [{ type: "text", text: "private answer" }], _request_id: "provider-request",
      stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 3_000,
        cache_read_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 } } });
    const result = await operation;
    await persistence.llmUsage.settle([result.callId!], "SUPPRESSED");
    await provider.annotateCall(result.callId, "REJECTED", "INVALID_RESPONSE");
    const rows = await persistence.llmUsage.list({ eventId: "event-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SUCCESS", requestId: "workflow-1", cacheCreation5mInputTokens: 1_000,
      validationOutcome: "REJECTED", validationErrorCode: "INVALID_RESPONSE",
      cacheCreation1hInputTokens: 2_000, cacheReadInputTokens: 3_000, stopReason: "end_turn",
      providerRequestId: "provider-request", estimatedCostMicrousd: 17_100, workflowOutcome: "SUPPRESSED" });
    expect(JSON.stringify(rows)).not.toMatch(/private prompt|private customer|private answer|secret-test-key/u);
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/private prompt|private customer|private answer|secret-test-key/u);
    const report = buildLlmUsageReport(rows);
    expect(report.inboundsWithRecordedCalls.calls.mean).toBe(1);
    expect(report.total.knownEstimatedCostUsd).toBe(0.0171);
    expect(report.total.rejectedOutputs).toBe(1);
    expect(JSON.stringify(report)).not.toContain("event-1");
  });

  it("preserves an unknown-cost API failure without inventing zero usage", async () => {
    const client = new Anthropic({ apiKey: "secret-test-key", maxRetries: 0, fetch: vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "private billing details" } }), { status: 429, headers: { "content-type": "application/json" } })) });
    const provider = new AnthropicLLMProvider({ apiKey: "secret-test-key", model: "claude-sonnet-4-6", timeoutMs: 50 }, client,
      { usage: persistence.llmUsage, logger });
    await expect(provider.generateText({ systemPrompt: "private prompt", userMessage: "private user", maxTokens: 100, metadata })).rejects.toMatchObject({ code: "ANTHROPIC_HTTP_429" });
    const rows = await persistence.llmUsage.list();
    expect(rows[0]).toMatchObject({ status: "ERROR", inputTokens: null, estimatedCostMicrousd: null, errorCode: "ANTHROPIC_HTTP_429" });
    const report = buildLlmUsageReport(rows);
    expect(report.total.costComplete).toBe(false);
    expect(report.inboundsWithRecordedCalls.projectedCostUsd).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("private billing details");
  });

  it("does not retry a paid API call because the usage sink fails", async () => {
    const create = vi.fn().mockResolvedValue({ model: "test-model", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 2 } });
    const provider = new AnthropicLLMProvider({ apiKey: "test-key", model: "test-model", timeoutMs: 50 },
      { messages: { create } } as unknown as Anthropic,
      { usage: { record: vi.fn().mockRejectedValue(new Error("DB unavailable")), settle: vi.fn(), list: vi.fn() }, logger });
    await expect(provider.generateText({ systemPrompt: "test", userMessage: "test", maxTokens: 100 })).resolves.toMatchObject({ inputTokens: 10 });
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not repeat paid work when both logging and validation telemetry fail", async () => {
    const create = vi.fn().mockResolvedValue({ model: "test-model", content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 2 } });
    const throwLog = () => { throw new Error("Logger unavailable"); };
    const provider = new AnthropicLLMProvider({ apiKey: "test-key", model: "test-model", timeoutMs: 50 },
      { messages: { create } } as unknown as Anthropic,
      { logger: { info: throwLog, error: throwLog }, usage: { record: vi.fn().mockRejectedValue(new Error("DB unavailable")),
        annotate: vi.fn().mockRejectedValue(new Error("DB unavailable")), settle: vi.fn(), list: vi.fn() } });
    const result = await provider.generateText({ systemPrompt: "test", userMessage: "test", maxTokens: 100 });
    await expect(provider.annotateCall(result.callId, "ACCEPTED")).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps retry feedback outside the cache prefix", () => {
    const base = { maxTokens: 100, userMessage: JSON.stringify({ APPROVED_KNOWLEDGE: [{ id: "fact", answer: "Approved" }], CURRENT_MESSAGE: "User" }),
      cache: { stableFields: ["APPROVED_KNOWLEDGE"], ttl: "5m" as const, systemPrefix: "Static" } };
    const first = prepareAnthropicContext({ ...base, systemPrompt: "Static" });
    const second = prepareAnthropicContext({ ...base, systemPrompt: "Static\n\nTRUSTED_VALIDATION_FEEDBACK: Invalid JSON" });
    expect(first.system).toEqual(second.system);
    expect(JSON.parse(second.userMessage).applicationValidationFeedback).toContain("Invalid JSON");
  });

  it("factors exact duplicates without losing history roles or older referents", () => {
    const messages = [{ direction: "OUTBOUND", actor: "MANAGER", content: "Вопрос менеджера" },
      { direction: "INBOUND", actor: "USER", content: "Текущий ответ" }];
    const document = { recentMessages: messages, currentExchange: { previousSpeakerTurn: messages[0].content,
      activeUserTurn: [messages[1].content], previousUserTurn: ["Ранее сообщённая поправка"] },
      economicsContext: { requestedUnits: 2, total: 310_000 }, availableEconomics: { requestedUnits: 2, total: 310_000 } };
    const packed = JSON.parse(prepareAnthropicContext({ systemPrompt: "Rules", userMessage: JSON.stringify(document), maxTokens: 100,
      cache: { stableFields: [], ttl: "5m" } }).userMessage);
    expect(packed.recentMessages).toEqual(messages);
    expect(packed.currentExchange.previousSpeakerTurn).toEqual({ sameValueAs: "recentMessages[0].content" });
    expect(packed.currentExchange.activeUserTurn).toEqual([{ sameValueAs: "recentMessages[1].content" }]);
    expect(packed.currentExchange.previousUserTurn).toEqual(["Ранее сообщённая поправка"]);
    expect(packed.economicsContext).toEqual({ sameValueAs: "availableEconomics" });
    const distinct = JSON.parse(prepareAnthropicContext({ systemPrompt: "Rules", maxTokens: 100,
      userMessage: JSON.stringify({ ...document, economicsContext: { requestedUnits: 3, total: 440_000 } }),
      cache: { stableFields: [], ttl: "5m" } }).userMessage);
    expect(distinct.economicsContext).toEqual({ requestedUnits: 3, total: 440_000 });
  });

  it("does not price unknown models with an assumed tariff", () => {
    expect(estimateCostMicrousd({ model: "unknown-model", inputTokens: 100, outputTokens: 10,
      cacheReadInputTokens: 0, cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 0 })).toBeNull();
  });
});
