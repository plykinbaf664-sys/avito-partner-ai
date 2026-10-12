import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { createRuntimeLlmProvider } from "../src/integrations/llm/runtime-provider";
import { createTestChatLabService } from "../src/application/test-chat-lab/test-chat-lab-service";
import { FakeOutboundProvider } from "../src/integrations/fake/fake-outbound-provider";
import { FakeManagerNotificationProvider } from "../src/integrations/fake/fake-manager-notification-provider";
import { evaluateServiceability } from "../src/domain/lead/serviceability";
import type { LlmCallRecord } from "../src/application/observability/llm-usage";
import type { LlmProvider, LlmTextResponse } from "../src/application/ports/llm-provider";

// Opt-in synthetic application pipeline. Production DB and channels are never used.
async function main() {
  const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const replayPath = option("--replay");
  const recorded = replayPath ? JSON.parse(await readFile(replayPath, "utf8")) : null;
  const reportPath = option("--report");
  assert(recorded || process.argv.includes("--live") && reportPath, "Explicit --live --report or --replay required");
  const scenario = recorded?.scenario ?? option("--scenario");
  assert(scenario === "geography" || scenario === "uncertainty", "Choose geography or uncertainty");
  const persistence = await SqlitePersistence.createMigrated("file::memory:");
  const calls = new Map<string, LlmCallRecord>();
  const trace: Array<{ stage: string | undefined; response: LlmTextResponse }> = [];
  const telemetry = { workload: "EVAL" as const, logger: { info() {}, error() {} }, usage: {
    list: persistence.llmUsage.list.bind(persistence.llmUsage),
    record: async (record: LlmCallRecord) => { calls.set(record.id, record); await persistence.llmUsage.record(record); },
    settle: persistence.llmUsage.settle.bind(persistence.llmUsage),
  } };
  let replayCalls = 0;
  const provider = (purpose: "extraction" | "conversation"): LlmProvider => {
    if (recorded) return { promptProfile: "compact-v1", async generateText(request) {
      const entry = recorded.trace[replayCalls++];
      assert(entry, "Unexpected extra call"); assert.equal(entry.stage, request.metadata?.stage, "Stage order changed");
      return { ...entry.response, callId: undefined, inputTokens: 0, outputTokens: 0 };
    } };
    const real = createRuntimeLlmProvider(process.env, purpose, telemetry);
    return { promptProfile: real.promptProfile, annotateCall: real.annotateCall?.bind(real), async generateText(request) {
      assert(calls.size < 12 && [...calls.values()].reduce((s, r) => s + (r.estimatedCostMicrousd ?? 0), 0) < 30_000,
        "Focused eval budget reached");
      const response = await real.generateText(request); trace.push({ stage: request.metadata?.stage, response }); return response;
    } };
  };
  const outbound = new FakeOutboundProvider();
  const notifications = new FakeManagerNotificationProvider();
  try {
    const lab = createTestChatLabService({ persistence, llmProvider: provider("extraction"),
      conversationLlmProvider: provider("conversation"), outboundProvider: outbound, managerNotificationProvider: notifications });
    const session = `synthetic-location-${scenario}`;
    const start = new Date("2026-10-12T10:00:00Z");
    const manager = scenario === "geography" ? "Какой город Вам подходит для запуска?"
      : "При Вашем капитале 350 000 ₽ можно начать с небольшого масштаба. Со скольких объектов хотите начать?";
    const clientMessages = scenario === "geography" ? ["Химки, Подмосковье", "А по времени сколько нужно?"]
      : ["Пока не знаю, хочу сначала попробовать", "Я ошибся с городом — Волгоград. Хочу запуститься в этом месяце."];
    await lab.managerMessage(session, manager, start, "manager");
    if (scenario === "uncertainty") {
      const lead = await persistence.leads.findByExternalIdentity("TEST_CHAT_LAB", session);
      assert(lead);
      await persistence.leads.update({ ...lead, city: "Москва", serviceability: evaluateServiceability("Москва"),
        availableCapital: 350000, availableCapitalConfirmed: true, capitalScope: "TOTAL_LIMIT" });
    }
    const turns = [];
    for (const [index, text] of clientMessages.entries()) {
      const result = await lab.clientMessage(session, text, new Date(start.getTime() + (index + 1) * 60_000), `client-${index}`);
      assert.equal(result.snapshot.lastProcessing?.responseFailureCode, null, "No technical fallback");
      assert.equal(result.snapshot.lastProcessing?.responseGenerationSource, "LLM", "Brain must supply the answer");
      turns.push(result);
    }
    const lead = await persistence.leads.findByExternalIdentity("TEST_CHAT_LAB", session);
    assert.equal(lead?.city, scenario === "geography" ? "Химки" : "Волгоград");
    assert.equal(lead?.serviceability, "SUPPORTED");
    assert.notEqual(lead?.qualificationStatus, "NO_FIT");
    if (scenario === "geography") assert.equal(lead?.hasFreeTime, null, "Question does not confirm availability");
    else { assert.equal(lead?.availableCapital, 350000); assert.equal(lead?.startingUnits, null); }
    assert.equal(outbound.requests.length, 2); assert.equal(notifications.requests.length, 0);
    const transcript = outbound.requests.map(r => r.text);
    if (recorded) {
      assert.equal(replayCalls, recorded.trace.length); assert.deepEqual(transcript, recorded.transcript);
      process.stdout.write(JSON.stringify({ recordedReplay: "PASS", scenario, replayedCalls: replayCalls,
        liveModelCalls: 0, deliveries: 2, handoffs: 0 }) + "\n"); return;
    }
    const usage = [...calls.values()];
    assert(usage.every(r => r.provider === "qwen" && r.model === "qwen3.8-flash" && r.status === "SUCCESS"));
    const report = { status: "PENDING_MANUAL_REVIEW", scenario, fixtureMethod: "Manager history, explicit prior facts, two real new client turns, isolated SQLite and fake channels",
      productionTouched: false, realChannelSends: 0, manager, clientMessages, transcript, turns, trace, usage,
      totalEstimatedCostMicrousd: usage.reduce((s, r) => s + (r.estimatedCostMicrousd ?? 0), 0) };
    await writeFile(reportPath!, JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: report.status, scenario, calls: usage.length,
      totalEstimatedCostMicrousd: report.totalEstimatedCostMicrousd, reportPath }) + "\n");
  } finally { persistence.close(); }
}
main().catch(error => { process.stderr.write(`LOCATION_EVAL_FAILED:${error instanceof Error ? error.message : "UNKNOWN"}\n`); process.exitCode = 1; });
