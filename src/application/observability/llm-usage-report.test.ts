import { describe, expect, it } from "vitest";
import type { LlmCallRecord } from "./llm-usage";
import { buildLlmUsageReport } from "./llm-usage-report";

function row(id: string, eventId: string, patch: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return { id, eventId, requestId: "request", leadId: null, conversationId: null, source: "synthetic",
    operation: "INBOUND", workload: "PRODUCTION", stage: "GENERATION", attempt: 1, promptVersion: "v1",
    promptHash: "hash", schemaHash: "hash", release: null, model: "claude-sonnet-4-6", status: "SUCCESS",
    startedAt: new Date(0), completedAt: new Date(100), latencyMs: 100, inputTokens: 100, outputTokens: 10,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000, cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0, stopReason: "end_turn", providerRequestId: null, errorCode: null,
    estimatedCostMicrousd: 750, pricingVersion: "test", workflowOutcome: "USED", ...patch };
}

describe("LLM usage reports", () => {
  it("groups all attempts per inbound and separates cached from uncached input", () => {
    const report = buildLlmUsageReport([row("1", "event-a"), row("2", "event-a", { stage: "REVIEW" }),
      row("3", "event-a", { stage: "REPAIR", validationOutcome: "REJECTED" }), row("4", "event-b")]);
    expect(report.inboundsWithRecordedCalls.calls).toMatchObject({ count: 2, mean: 2, median: 2, p90: 2.8 });
    expect(report.total).toMatchObject({ attempts: 4, successfulCalls: 4, uncachedInputTokens: 400,
      cacheReadInputTokens: 4_000, cacheReadCalls: 4, cacheWriteCalls: 0, rejectedOutputs: 1 });
    expect(report.inboundsWithRecordedCalls.totalInputTokens.mean).toBe(2_200);
    expect(report.inboundsWithRecordedCalls.projectedCostUsd).toEqual({ 100: 0.15, 1000: 1.5, 10000: 15 });
    expect(JSON.stringify(report)).not.toMatch(/event-a|event-b|request|hash/u);
  });

  it("retains known cost but refuses projections when any attempt is unresolved", () => {
    const report = buildLlmUsageReport([row("1", "event-a"), row("2", "event-a", { status: "STARTED",
      inputTokens: null, outputTokens: null, cacheReadInputTokens: null, estimatedCostMicrousd: null, latencyMs: null })]);
    expect(report.total).toMatchObject({ unresolvedCalls: 1, costComplete: false, knownEstimatedCostUsd: 0.00075 });
    expect(report.inboundsWithRecordedCalls.projectedCostUsd).toBeNull();
  });

  it("keeps follow-up cost outside the inbound denominator", () => {
    const report = buildLlmUsageReport([row("1", "event-a"), row("2", "event-b", { operation: "FOLLOW_UP" })]);
    expect(report.total.attempts).toBe(2);
    expect(report.inboundsWithRecordedCalls.count).toBe(1);
    expect(report.inboundsWithRecordedCalls.calls.mean).toBe(1);
    expect(report.inboundsWithRecordedCalls.projectedCostUsd?.[1000]).toBe(0.75);
  });
});
