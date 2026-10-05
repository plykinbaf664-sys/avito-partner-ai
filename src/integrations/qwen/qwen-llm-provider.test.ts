import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { createLlmUsageTracker } from "@/application/observability/llm-usage";
import { buildLlmUsageReport } from "@/application/observability/llm-usage-report";
import { silentLogger } from "@/application/observability/structured-logger";
import { QwenLLMProvider } from "./qwen-llm-provider";
import { qwenApiBase, type QwenConfig } from "./config";
import { prepareQwenContext } from "./context";
import { createRuntimeLlmProvider } from "../llm/runtime-provider";
import { createMessageExtractor } from "@/application/extraction/extract-message";
import { COMPACT_EXTRACTION_CONTRACT } from "@/application/extraction/compact-contract";
import { FakeLLMProvider } from "../fake/fake-llm-provider";

const config: QwenConfig = { apiKey: "synthetic-private-key", baseUrl: "https://synthetic.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.8-flash", timeoutMs: 1000, cacheMode: "explicit", structuredOutput: "json_schema", thinkingMode: "off", thinkingBudget: 1024 };
const request = { systemPrompt: "Rules", userMessage: JSON.stringify({ approvedFacts: [{ id: "approved", answer: "Fact" }],
  current: "private customer text" }), maxTokens: 100, cache: { stableFields: ["approvedFacts"], ttl: "1h" as const },
  metadata: { requestId: "workflow", eventId: "event", stage: "GENERATION", attempt: 1, promptVersion: "v1", operation: "INBOUND" as const },
  jsonSchema: { type: "object", properties: { answer: { type: "string", minLength: 1 }, text: { const: "" } },
    required: ["answer"], additionalProperties: false } };
const completion = { id: "provider-request", model: "qwen3.8-flash", choices: [{ finish_reason: "stop",
  message: { content: '{"answer":"Approved"}', reasoning_content: "private reasoning" } }], usage: { prompt_tokens: 6000,
  completion_tokens: 10, prompt_tokens_details: { cached_tokens: 3000, cache_creation_input_tokens: 2000 } } };
const ok = (body: unknown = completion) => new Response(JSON.stringify(body), { status: 200 });

describe("Qwen API, usage and provider boundaries", () => {
  let persistence: SqlitePersistence;
  beforeEach(async () => { persistence = await SqlitePersistence.createMigrated("file::memory:", resolve(process.cwd(), "drizzle")); });
  afterEach(() => persistence.close());

  it("writes STARTED before the network and accounts for cache tokens without double billing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      expect(await persistence.llmUsage.list()).toMatchObject([{ status: "STARTED", provider: "qwen" }]);
      const payload = JSON.parse(options!.body as string);
      expect(payload.enable_thinking).toBe(false);
      expect(payload.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
      expect(payload.response_format.json_schema.schema.properties.answer.minLength).toBe(1);
      expect(payload.messages[0].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
      expect(payload.messages[0].content.at(-1).cache_control).not.toHaveProperty("ttl");
      expect(payload.messages[1].content).toContain("private customer text");
      return ok();
    });
    const logger = { info: vi.fn(), error: vi.fn() };
    const provider = new QwenLLMProvider(config, fetcher, { usage: persistence.llmUsage, logger, workload: "PRODUCTION" });
    const result = await provider.generateText(request);
    expect(result).toMatchObject({ provider: "qwen", model: "qwen3.8-flash", inputTokens: 1000,
      outputTokens: 10, cacheReadInputTokens: 3000, cacheCreationInputTokens: 2000, estimatedCostMicrousd: 603 });
    await provider.annotateCall(result.callId, "ACCEPTED");
    await persistence.llmUsage.settle([result.callId!], "USED");
    const rows = await persistence.llmUsage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SUCCESS", providerTotalInputTokens: 6000, validationOutcome: "ACCEPTED", workflowOutcome: "USED" });
    expect(JSON.stringify(rows) + JSON.stringify(logger.info.mock.calls)).not.toMatch(/private customer|private reasoning|synthetic-private-key|Approved/u);
    expect(buildLlmUsageReport(rows).total.knownEstimatedCostUsd).toBe(0.000603);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps a paid truncated response in the ledger and tracker before rejecting it", async () => {
    const provider = new QwenLLMProvider(config, vi.fn<typeof fetch>().mockResolvedValue(ok({ ...completion,
      choices: [{ finish_reason: "length", message: { content: '{"answer":' } }] })), { usage: persistence.llmUsage, logger: silentLogger });
    const tracker = createLlmUsageTracker();
    await expect(tracker.call(provider, request)).rejects.toMatchObject({ code: "QWEN_OUTPUT_TRUNCATED", retryable: false });
    expect(tracker.totals).toMatchObject({ calls: 1, successfulCalls: 1, complete: true, inputTokens: 1000, outputTokens: 10,
      estimatedCostMicrousd: 603 });
    expect(await persistence.llmUsage.list()).toMatchObject([{ status: "SUCCESS", validationOutcome: "REJECTED",
      validationErrorCode: "QWEN_OUTPUT_TRUNCATED" }]);
  });

  it("reports access-denied without a hidden Claude fallback, retry or secret error body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: "AccessDenied.Unpurchased", message: "private-account-details" } }), { status: 403 }));
    const provider = new QwenLLMProvider(config, fetcher, { usage: persistence.llmUsage, logger: silentLogger });
    await expect(provider.generateText(request)).rejects.toMatchObject({ code: "QWEN_HTTP_403", retryable: false });
    const rows = await persistence.llmUsage.list();
    expect(rows).toMatchObject([{ provider: "qwen", status: "ERROR", inputTokens: null, providerErrorCode: "AccessDenied.Unpurchased" }]);
    expect(JSON.stringify(rows)).not.toContain("private-account-details");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("leaves workflow retries to the application and never retries 429 inside the provider", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(new QwenLLMProvider(config, fetcher, { logger: silentLogger }).generateText(request))
      .rejects.toMatchObject({ code: "QWEN_HTTP_429", retryable: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects another model's answer while retaining its paid usage", async () => {
    const provider = new QwenLLMProvider(config, vi.fn<typeof fetch>().mockResolvedValue(ok({ ...completion, model: "other-model" })),
      { usage: persistence.llmUsage, logger: silentLogger });
    await expect(provider.generateText(request)).rejects.toMatchObject({ code: "QWEN_MODEL_MISMATCH" });
    expect(await persistence.llmUsage.list()).toMatchObject([{ model: "other-model", provider: "qwen", inputTokens: 1000,
      estimatedCostMicrousd: null, validationErrorCode: "QWEN_MODEL_MISMATCH" }]);
  });

  it("uses explicit, visible JSON Object configuration with a stable schema when selected", () => {
    const first = prepareQwenContext(request, { ...config, structuredOutput: "json_object" });
    const second = prepareQwenContext({ ...request, userMessage: JSON.stringify({ approvedFacts: [{ id: "approved", answer: "Fact" }],
      current: "different turn" }) }, { ...config, structuredOutput: "json_object" });
    expect(first.response_format).toEqual({ type: "json_object" });
    expect(first.messages[0]).toEqual(second.messages[0]);
    expect(JSON.stringify(first.messages[0])).toContain("additionalProperties");
    const implicit = prepareQwenContext(request, { ...config, cacheMode: "implicit" });
    expect(JSON.stringify(implicit)).not.toContain("cache_control");
  });

  it("keeps literal conversational referents in Qwen payloads", () => {
    const userMessage = JSON.stringify({ approvedFacts: [],
      recentMessages: [{ direction: "OUTBOUND", actor: "MANAGER", content: "Сколько часов в день сможете уделять проекту?" },
        { direction: "INBOUND", actor: "USER", content: "А сколько надо?" }],
      currentExchange: { previousSpeakerTurn: "Сколько часов в день сможете уделять проекту?", activeUserTurn: ["А сколько надо?"] },
    });
    const payload = prepareQwenContext({ ...request, userMessage }, config);
    const context = JSON.parse(payload.messages[1]!.content as string);
    expect(context.currentExchange.previousSpeakerTurn).toBe("Сколько часов в день сможете уделять проекту?");
    expect(context.currentExchange.activeUserTurn).toEqual(["А сколько надо?"]);
  });

  it("bounds optional reasoning without recording the reasoning content", () => {
    const selected = { ...config, thinkingMode: "bounded" as const, thinkingBudget: 1024 };
    const payload = prepareQwenContext(request, selected);
    expect(payload.enable_thinking).toBe(true);
    expect(payload).toHaveProperty("thinking_budget", 1024);
    expect(payload.max_tokens).toBeGreaterThanOrEqual(request.maxTokens + 1024);
  });

  it("accepts only Singapore workspace hosts and never redirects credentials", () => {
    expect(qwenApiBase("synthetic.ap-southeast-1.maas.aliyuncs.com")).toBe(config.baseUrl);
    for (const host of ["http://synthetic.ap-southeast-1.maas.aliyuncs.com", "https://example.org", "https://synthetic.ap-southeast-1.maas.aliyuncs.com.evil.org",
      "https://user:password@synthetic.ap-southeast-1.maas.aliyuncs.com", config.baseUrl + "/chat/completions"]) expect(() => qwenApiBase(host)).toThrow();
    const selected = createRuntimeLlmProvider({ NODE_ENV: "test", LLM_PROVIDER: "qwen", QWEN_API_KEY: "synthetic", QWEN_API_HOST: "synthetic.ap-southeast-1.maas.aliyuncs.com" }, "conversation");
    expect(selected).toBeInstanceOf(QwenLLMProvider);
  });

  it("selects the compact extraction contract without exposing eval trajectories", async () => {
    const llm = Object.assign(new FakeLLMProvider(["{}", "{}"]), { promptProfile: "compact-v1" as const });
    await createMessageExtractor({ llmProvider: llm })("Сколько времени потребуется?");
    expect(llm.requests[0]!.systemPrompt).toBe(COMPACT_EXTRACTION_CONTRACT);
    expect(llm.requests[0]!.metadata?.promptVersion).toBe("extraction-compact-v3");
    expect(llm.requests[0]!.systemPrompt).not.toContain("operations-after-capital-correction");
  });

  it("accepts a sparse Qwen fact delta without inventing unknown values or retrying", async () => {
    const llm = Object.assign(new FakeLLMProvider([JSON.stringify({ intent: "QUALIFICATION_INFORMATION",
      facts: { city: "Москва", availableCapital: 400000, availableCapitalConfirmed: true },
      signals: {}, confidence: 0.95, uncertainty: [] })]), { promptProfile: "compact-v1" as const });
    const result = await createMessageExtractor({ llmProvider: llm })("Москва, на запуск есть 400 тысяч.");
    expect(result.extraction.facts).toMatchObject({ city: "Москва", availableCapital: 400000,
      availableCapitalConfirmed: true, startingUnits: null, managementReadiness: null, primaryGoal: "UNKNOWN",
      rejectsBusinessModel: null, additionalLaunchCapital: null });
    expect(result.diagnostics?.status).toBe("VALID");
    expect(llm.callCount).toBe(1);
    const schema = llm.requests[0]!.jsonSchema as { properties: { facts: { required?: string[] } } };
    expect(schema.properties.facts.required ?? []).toEqual([]);
    const context = JSON.parse(llm.requests[0]!.userMessage);
    expect(context.APPROVED_KNOWLEDGE.length).toBeGreaterThan(10);
    expect(context.APPROVED_KNOWLEDGE.every((entry: Record<string, unknown>) => !Object.hasOwn(entry, "answer"))).toBe(true);
  });
});
