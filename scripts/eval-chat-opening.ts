import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { createRuntimeLlmProvider } from "../src/integrations/llm/runtime-provider";
import { createNaturalResponseGenerator } from "../src/application/conversation/generate-natural-response";
import { createChatOpeningWorkflow } from "../src/application/workflows/process-chat-openings";
import { createTestChatLabService } from "../src/application/test-chat-lab/test-chat-lab-service";
import { FakeOutboundProvider } from "../src/integrations/fake/fake-outbound-provider";
import { FakeManagerNotificationProvider } from "../src/integrations/fake/fake-manager-notification-provider";
import type { LlmCallRecord } from "../src/application/observability/llm-usage";
import type { LlmProvider } from "../src/application/ports/llm-provider";
import type { AvitoMessage } from "../src/integrations/avito/avito-api-client";

// Opt-in, one focused live trajectory. All persistence and deliveries are fake;
// only the configured LLM API is called. Synthetic customer data exclusively.
async function main() {
  const replayIndex = process.argv.indexOf("--replay");
  const recorded = replayIndex < 0 ? null : JSON.parse(await readFile(process.argv[replayIndex+1], "utf8"));
  assert(recorded || process.argv.includes("--live"), "Explicit --live or --replay is required");
  const index = process.argv.indexOf("--report");
  const reportPath = index < 0 ? undefined : process.argv[index+1];
  assert(recorded || reportPath, "--report path is required for a live run");
  const persistence = await SqlitePersistence.createMigrated("file::memory:");
  const calls = new Map<string, LlmCallRecord>();
  const trace: unknown[] = [];
  const telemetry = { workload: "EVAL" as const, usage: {
    list: persistence.llmUsage.list.bind(persistence.llmUsage),
    record: async (record: LlmCallRecord) => { calls.set(record.id, record); await persistence.llmUsage.record(record); },
    settle: async (ids: string[], outcome: LlmCallRecord["workflowOutcome"]) => {
      for (const id of ids) { const row = calls.get(id); if (row) row.workflowOutcome = outcome; }
      await persistence.llmUsage.settle(ids, outcome!);
    },
  } };
  const observe = (provider: LlmProvider): LlmProvider => ({ promptProfile: provider.promptProfile,
    annotateCall: provider.annotateCall?.bind(provider),
    async generateText(request) {
      const response = await provider.generateText(request);
      trace.push({ stage: request.metadata?.stage, response }); return response;
    } });
  let replayCalls = 0;
  const replayProvider: LlmProvider = { promptProfile: "compact-v1", async generateText(request) {
    const entry = recorded.trace[replayCalls++];
    assert(entry, "Unexpected extra call"); assert.equal(request.metadata?.stage, entry.stage, "Stage order changed");
    return { ...entry.response, callId: undefined, inputTokens: 0, outputTokens: 0 };
  } };
  const extraction = recorded ? replayProvider : observe(createRuntimeLlmProvider(process.env, "extraction", telemetry));
  const brain = recorded ? replayProvider : observe(createRuntimeLlmProvider(process.env, "conversation", telemetry));
  const outbound = new FakeOutboundProvider();
  const notifications = new FakeManagerNotificationProvider();
  const start = new Date(); let now = new Date(start.getTime()+10_000);
  const sessionId = "synthetic-service-only-opening";
  const service: AvitoMessage = { id: "synthetic-service", authorId: "0", createdAtUnix: start.getTime()/1000+1,
    type: "system", direction: "in", origin: "MESSAGE_HISTORY",
    text: "Пользователь заинтересовался вашим объявлением и открыл чат, но пока ничего не написал. Вы можете написать первым." };
  try {
    const openings = createChatOpeningWorkflow({ persistence, stateRepository: persistence.pollingStates,
      readHistory: async () => [service], generateNaturalResponse: createNaturalResponseGenerator({ llmProvider: brain }),
      outboundProvider: outbound, clock: () => now });
    await openings.start("synthetic-owner", start);
    await openings.observe({ id: sessionId, updatedAtUnix: null, createdAtUnix: start.getTime()/1000+1,
      contextType: "item", listingOwnerId: "synthetic-owner", participantIds: ["synthetic-owner", "synthetic-buyer"] }, "synthetic-owner", now);
    now = new Date(now.getTime()+120_000); await openings.processDue(now);
    assert.equal(outbound.requests.length, 1, "Exactly one useful initial contact is required");
    const lead = (await persistence.leads.findByExternalIdentity("AVITO", sessionId))!;
    assert(lead); assert.equal(lead.availableCapital, null); assert.equal(lead.phoneNumber, null);
    const openingHistory = await persistence.messages.listByLeadId(lead.id);
    assert.equal(openingHistory.filter(m => m.direction === "INBOUND").length, 0, "No fabricated user speech");
    const callsAfterOpening = recorded ? replayCalls : calls.size;
    await openings.processDue(now); assert.equal(recorded ? replayCalls : calls.size, callsAfterOpening, "No repeated generation");
    // Transfer the synthetic opening fixture into the actual local Test Chat
    // Lab namespace, preserving the same conversation/history/state.
    await persistence.leads.update({ ...lead, source: "TEST_CHAT_LAB" });
    const lab = createTestChatLabService({ persistence, llmProvider: extraction, conversationLlmProvider: brain,
      outboundProvider: outbound, managerNotificationProvider: notifications });
    const turns = [];
    for (const text of ["А как это работает и сколько надо на один объект в Москве?", "А кто потом занимается гостями и уборкой?"]) {
      now = new Date(now.getTime()+10_000);
      const result = await lab.clientMessage(sessionId, text, now);
      assert.equal(result.snapshot.lastProcessing?.responseFailureCode ?? null, null, "No response-generation fallback is permitted");
      turns.push(result);
    }
    assert.equal(outbound.requests.length, 3, "One opening plus one answer per real inbound");
    assert.equal(notifications.requests.length, 0, "No premature handoff");
    if (recorded) {
      assert.equal(replayCalls, recorded.trace.length);
      assert.deepEqual(outbound.requests.map(r => r.text), recorded.transcript);
      process.stdout.write(JSON.stringify({ recordedReplay: "PASS", replayedCalls: replayCalls,
        liveModelCalls: 0, deliveries: outbound.requests.length, handoffs: notifications.requests.length })+"\n");
      return;
    }
    const records = [...calls.values()];
    const report = { status: "PENDING_MANUAL_REVIEW", scenario: "service-only-opening-to-normal-conversation",
      checks: { noFabricatedInbound: true, firstContactOnce: true, ordinaryInboundContinues: true, noPrematureHandoff: true },
      transcript: outbound.requests.map(r => r.text), turns, trace,
      usage: records.map(({ id, provider, model, stage, inputTokens, outputTokens, cacheReadInputTokens, latencyMs, estimatedCostMicrousd, status }) =>
        ({ id, provider, model, stage, inputTokens, outputTokens, cacheReadInputTokens, latencyMs, estimatedCostMicrousd, status })),
      totalEstimatedCostMicrousd: records.reduce((sum, r) => sum+(r.estimatedCostMicrousd ?? 0), 0) };
    await writeFile(reportPath!, JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: report.status, calls: records.length,
      totalEstimatedCostMicrousd: report.totalEstimatedCostMicrousd, reportPath })+"\n");
  } finally { persistence.close(); }
}
main().catch(error => { process.stderr.write(`CHAT_OPENING_EVAL_FAILED:${error instanceof Error ? error.message : "UNKNOWN"}\n`); process.exitCode = 1; });
