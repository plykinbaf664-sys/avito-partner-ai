import type { LlmCallRecord, LlmWorkflowOutcome } from "./llm-usage";

type Row = LlmCallRecord & { workflowOutcome?: LlmWorkflowOutcome | null };
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const quantile = (q: number) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q;
    return sorted[Math.floor(i)]! + (sorted[Math.ceil(i)]! - sorted[Math.floor(i)]!) * (i - Math.floor(i));
  };
  return { count: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    median: quantile(0.5), p90: quantile(0.9) };
}

/** Aggregates only metadata and usage. Never emits customer identifiers or transcript. */
export function buildLlmUsageReport(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  const events = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.workload}/${row.operation}/${row.provider ?? "anthropic"}/${row.stage}/${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
    if (row.eventId && row.operation === "INBOUND") events.set(row.eventId, [...(events.get(row.eventId) ?? []), row]);
  }
  const stats = (items: Row[]) => {
    const successes = items.filter(row => row.status === "SUCCESS");
    const sum = (get: (row: Row) => number | null) => successes.reduce((total, row) => total + (get(row) ?? 0), 0);
    return { attempts: items.length, successfulCalls: successes.length, errors: items.filter(row => row.status === "ERROR").length,
      unresolvedCalls: items.filter(row => row.status === "STARTED").length,
      rejectedOutputs: items.filter(row => row.validationOutcome === "REJECTED").length,
      uncachedInputTokens: sum(row => row.inputTokens), outputTokens: sum(row => row.outputTokens),
      cacheCreationInputTokens: sum(row => row.cacheCreationInputTokens), cacheReadInputTokens: sum(row => row.cacheReadInputTokens),
      cacheCreation5mInputTokens: sum(row => row.cacheCreation5mInputTokens), cacheCreation1hInputTokens: sum(row => row.cacheCreation1hInputTokens),
      cacheReadCalls: successes.filter(row => (row.cacheReadInputTokens ?? 0) > 0).length,
      cacheWriteCalls: successes.filter(row => (row.cacheCreationInputTokens ?? 0) > 0).length,
      knownEstimatedCostUsd: sum(row => row.estimatedCostMicrousd) / 1_000_000,
      costComplete: items.every(row => row.status === "SUCCESS" && row.estimatedCostMicrousd !== null),
      inputDistribution: distribution(successes.flatMap(row => row.inputTokens === null ? [] : [row.inputTokens])),
      totalInputDistribution: distribution(successes.flatMap(row => row.inputTokens === null ? [] :
        [row.inputTokens + (row.cacheCreationInputTokens ?? 0) + (row.cacheReadInputTokens ?? 0)])),
      outputDistribution: distribution(successes.flatMap(row => row.outputTokens === null ? [] : [row.outputTokens])),
      latencyMs: distribution(items.flatMap(row => row.latencyMs === null ? [] : [row.latencyMs])),
      workflowOutcomes: Object.fromEntries([...new Set(items.map(row => row.workflowOutcome ?? "UNSET"))]
        .map(outcome => [outcome, items.filter(row => (row.workflowOutcome ?? "UNSET") === outcome).length])) };
  };
  const eventStats = [...events.values()].map(stats);
  const costComplete = eventStats.every(item => item.costComplete);
  const costs = distribution(eventStats.map(item => item.knownEstimatedCostUsd));
  return { total: stats(rows), byStage: Object.fromEntries([...groups].map(([key, items]) => [key, stats(items)])),
    inboundsWithRecordedCalls: { count: events.size, calls: distribution(eventStats.map(item => item.attempts)),
      uncachedInputTokens: distribution(eventStats.map(item => item.uncachedInputTokens)),
      totalInputTokens: distribution(eventStats.map(item => item.uncachedInputTokens + item.cacheCreationInputTokens + item.cacheReadInputTokens)),
      outputTokens: distribution(eventStats.map(item => item.outputTokens)), knownCostUsd: costs, costComplete,
      projectedCostUsd: costComplete && costs.mean !== null
        ? Object.fromEntries([100, 1_000, 10_000].map(n => [n, n * costs.mean!])) : null },
    note: "Only recorded calls are included. STARTED/ERROR calls have unknown usage; zero-call inbounds are outside this denominator. Costs are tariff estimates, not provider invoices." };
}
