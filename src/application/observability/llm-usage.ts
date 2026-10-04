import type { LlmTextRequest, LlmTextResponse } from "../ports/llm-provider";

export interface LlmCallContext {
  requestId?: string;
  eventId?: string;
  leadId?: string;
  conversationId?: string;
  source?: string;
  operation?: "INBOUND" | "FOLLOW_UP" | "EVAL";
}

export type LlmWorkflowOutcome = "USED" | "FALLBACK" | "SUPPRESSED" | "NO_REPLY" | "FAILED";
export interface LlmCallRecord {
  id: string;
  requestId: string;
  eventId: string | null;
  leadId: string | null;
  conversationId: string | null;
  source: string | null;
  operation: string;
  workload: "PRODUCTION" | "TEST_LAB" | "EVAL" | "DEVELOPMENT";
  stage: string;
  attempt: number;
  promptVersion: string;
  promptHash: string;
  schemaHash: string;
  release: string | null;
  model: string;
  provider?: "anthropic" | "qwen";
  cacheMode?: "implicit" | "explicit" | "none";
  structuredOutputMode?: "json_schema" | "json_object" | "text";
  reasoningTokens?: number | null;
  thinkingMode?: "off" | "bounded";
  thinkingBudget?: number;
  providerTotalInputTokens?: number | null;
  status: "STARTED" | "SUCCESS" | "ERROR";
  startedAt: Date;
  completedAt: Date | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreation5mInputTokens: number | null;
  cacheCreation1hInputTokens: number | null;
  stopReason: string | null;
  providerRequestId: string | null;
  errorCode: string | null;
  providerErrorCode?: string | null;
  providerFailureCategory?: "BILLING" | "REQUEST" | "AUTH" | "RATE_LIMIT" | "AVAILABILITY";
  estimatedCostMicrousd: number | null;
  pricingVersion: string;
  validationOutcome?: "ACCEPTED" | "REJECTED";
  validationErrorCode?: string | null;
  workflowOutcome?: LlmWorkflowOutcome | null;
}

export interface LlmUsageRepository {
  record(record: LlmCallRecord): Promise<void>;
  settle(callIds: string[], outcome: LlmWorkflowOutcome): Promise<void>;
  annotate?(callId: string, outcome: "ACCEPTED" | "REJECTED", errorCode?: string): Promise<void>;
  list(query?: { eventId?: string; workload?: LlmCallRecord["workload"]; since?: Date; limit?: number }): Promise<Array<LlmCallRecord & { workflowOutcome: LlmWorkflowOutcome | null }>>;
}

export interface LlmUsageTotals {
  calls: number;
  successfulCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostMicrousd: number;
  costComplete: boolean;
  complete: boolean;
  callIds: string[];
}

/** Counts API attempts, including attempts that throw, independently of JSON validation. */
export function createLlmUsageTracker() {
  const totals: LlmUsageTotals = { calls: 0, successfulCalls: 0, inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostMicrousd: 0,
    costComplete: true, complete: true, callIds: [] };
  const accumulate = (result: LlmTextResponse) => {
    totals.successfulCalls++;
    totals.inputTokens += result.inputTokens;
    totals.outputTokens += result.outputTokens;
    totals.cacheCreationInputTokens += result.cacheCreationInputTokens ?? 0;
    totals.cacheReadInputTokens += result.cacheReadInputTokens ?? 0;
    if (result.estimatedCostMicrousd == null) totals.costComplete = false;
    else totals.estimatedCostMicrousd += result.estimatedCostMicrousd;
    if (result.callId) totals.callIds.push(result.callId);
  };
  return {
    totals,
    async call(provider: { generateText(request: LlmTextRequest): Promise<LlmTextResponse> }, request: LlmTextRequest) {
      totals.calls++;
      try {
        const result = await provider.generateText(request);
        accumulate(result);
        return result;
      } catch (error) {
        if (error instanceof Error && "llmResponseUsage" in error && error.llmResponseUsage) {
          accumulate(error.llmResponseUsage as LlmTextResponse);
        } else {
          totals.complete = false;
          totals.costComplete = false;
          if (error instanceof Error && "llmCallId" in error && typeof error.llmCallId === "string") totals.callIds.push(error.llmCallId);
        }
        throw error;
      }
    },
  };
}

/** Never turns a telemetry failure into a repeat of paid model work. */
export async function settleLlmUsage(repository: LlmUsageRepository | undefined, callIds: string[], outcome: LlmWorkflowOutcome,
  onError: () => void = () => undefined) {
  if (!repository || callIds.length === 0) return;
  try { await repository.settle(callIds, outcome); } catch { try { onError(); } catch { /* telemetry cannot repeat paid work */ } }
}
