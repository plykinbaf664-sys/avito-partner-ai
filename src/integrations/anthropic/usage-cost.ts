import type { LlmCallRecord } from "@/application/observability/llm-usage";

export const LLM_PRICING_VERSION = "anthropic-standard-2026-10-03";
/** USD per million tokens; cache creation duration is accounted for separately. Unknown models stay unpriced. */
export function estimateCostMicrousd(usage: Pick<LlmCallRecord, "model" | "inputTokens" | "outputTokens" |
  "cacheReadInputTokens" | "cacheCreation5mInputTokens" | "cacheCreation1hInputTokens">): number | null {
  const prices = usage.model === "claude-sonnet-4-6" ? [3, 15] :
    ["claude-haiku-4-5", "claude-haiku-4-5-20251001"].includes(usage.model) ? [1, 5] : null;
  if (!prices || usage.inputTokens === null || usage.outputTokens === null) return null;
  return Math.round(prices[0]! * (usage.inputTokens + 1.25 * (usage.cacheCreation5mInputTokens ?? 0) +
    2 * (usage.cacheCreation1hInputTokens ?? 0) + 0.1 * (usage.cacheReadInputTokens ?? 0)) + prices[1]! * usage.outputTokens);
}
