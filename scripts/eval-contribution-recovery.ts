import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { createRuntimeLlmProvider } from "../src/integrations/llm/runtime-provider";
import { createTestChatLabService } from "../src/application/test-chat-lab/test-chat-lab-service";
import { FakeOutboundProvider } from "../src/integrations/fake/fake-outbound-provider";
import { FakeManagerNotificationProvider } from "../src/integrations/fake/fake-manager-notification-provider";
import type { LlmCallRecord } from "../src/application/observability/llm-usage";
import type { LlmProvider, LlmTextResponse } from "../src/application/ports/llm-provider";

// One opt-in, synthetic two-turn Test Chat Lab trajectory; no live channel writes.
async function main() {
  const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const replayPath = option("--replay");
  const recorded = replayPath ? JSON.parse(await readFile(replayPath, "utf8")) : null;
  const reportPath = option("--report");
  assert(recorded || process.argv.includes("--live") && reportPath, "Explicit --live --report or --replay required");
  const persistence = await SqlitePersistence.createMigrated("file::memory:");
  const calls = new Map<string, LlmCallRecord>();
  const trace: Array<{ stage: string | undefined; response: LlmTextResponse }> = [];
  const telemetry = { workload: "EVAL" as const, logger: { info() {}, error() {} }, usage: {
    list: persistence.llmUsage.list.bind(persistence.llmUsage),
    record: async (record: LlmCallRecord) => { calls.set(record.id, record); await persistence.llmUsage.record(record); },
    settle: async (ids: string[], outcome: LlmCallRecord["workflowOutcome"]) => {
      for (const id of ids) { const row = calls.get(id); if (row) row.workflowOutcome = outcome; }
      await persistence.llmUsage.settle(ids, outcome!);
    },
  } };
  let replayCalls = 0;
  const provider = (purpose: "extraction" | "conversation"): LlmProvider => {
    if (recorded) return { promptProfile: "compact-v1", async generateText(request) {
      const entry = recorded.trace[replayCalls++];
      assert(entry, "Unexpected extra call"); assert.equal(entry.stage, request.metadata?.stage, "Stage order changed");
      return { ...entry.response, callId: undefined, inputTokens: 0, outputTokens: 0 };
    } };
    const real = createRuntimeLlmProvider(process.env, purpose, telemetry);
    return { promptProfile: real.promptProfile, annotateCall: real.annotateCall?.bind(real),
      async generateText(request) {
        assert([...calls.values()].reduce((sum, r) => sum + (r.estimatedCostMicrousd ?? 0), 0) < 50_000, "Eval cost budget reached");
        const response = await real.generateText(request);
        trace.push({ stage: request.metadata?.stage, response }); return response;
      } };
  };
  const outbound = new FakeOutboundProvider();
  const notifications = new FakeManagerNotificationProvider();
  try {
    const lab = createTestChatLabService({ persistence, llmProvider: provider("extraction"),
      conversationLlmProvider: provider("conversation"), outboundProvider: outbound, managerNotificationProvider: notifications });
    const session = "synthetic-manager-city-contribution";
    const start = new Date("2026-10-12T09:00:00Z");
    await lab.managerMessage(session, "Работаем в Москве и нескольких других городах. Какой город Вам подходит?", start, "manager-city");
    const turns = [];
    for (const [index, text] of ["Москва", "А сколько потребуется на один объект?"].entries()) {
      const result = await lab.clientMessage(session, text, new Date(start.getTime() + (index + 1) * 60_000), `customer-${index}`);
      assert.equal(result.snapshot.lastProcessing?.responseFailureCode, null, "No technical response fallback");
      assert.equal(result.snapshot.lastProcessing?.responseGenerationSource, "LLM", "Brain must supply the reply");
      turns.push(result);
    }
    assert.equal(outbound.requests.length, 2, "One answer per inbound");
    assert.equal(notifications.requests.length, 0, "No premature handoff");
    const transcript = outbound.requests.map(r => r.text);
    if (recorded) {
      assert.equal(replayCalls, recorded.trace.length); assert.deepEqual(transcript, recorded.transcript);
      process.stdout.write(JSON.stringify({ recordedReplay: "PASS", replayedCalls: replayCalls, liveModelCalls: 0,
        deliveries: 2, handoffs: 0 }) + "\n"); return;
    }
    const records = [...calls.values()];
    assert(records.every(r => r.provider === "qwen" && r.model === "qwen3.8-flash" && r.status === "SUCCESS"));
    const report = { status: "PENDING_MANUAL_REVIEW", scenario: "manager-city-contribution-to-contextual-economics",
      transcript, turns, trace, usage: records,
      totalEstimatedCostMicrousd: records.reduce((sum, r) => sum + (r.estimatedCostMicrousd ?? 0), 0) };
    await writeFile(reportPath!, JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: report.status, calls: records.length,
      totalEstimatedCostMicrousd: report.totalEstimatedCostMicrousd, reportPath }) + "\n");
  } finally { persistence.close(); }
}
main().catch(error => { process.stderr.write(`CONTRIBUTION_EVAL_FAILED:${error instanceof Error ? error.message : "UNKNOWN"}\n`); process.exitCode = 1; });
