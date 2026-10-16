import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { createRuntimeLlmProvider, runtimeLlmIdentity } from "../src/integrations/llm/runtime-provider";
import { createTestChatLabService } from "../src/application/test-chat-lab/test-chat-lab-service";
import { FakeOutboundProvider } from "../src/integrations/fake/fake-outbound-provider";
import { FakeManagerNotificationProvider } from "../src/integrations/fake/fake-manager-notification-provider";
import type { LlmCallRecord } from "../src/application/observability/llm-usage";
import type { LlmProvider, LlmTextResponse } from "../src/application/ports/llm-provider";

// Synthetic data, isolated in-memory SQLite and fake channels. No production writes.
const ready = "Я в Москве. На запуск есть 400 тысяч, это весь доступный капитал, готов потратить его на аренду, залог, подготовку и текущие расходы. Хочу свой основной бизнес, начать на следующей неделе. На просмотры и договоры буду ездить сам, 3–4 часа в день выделю.";
const phone = "+79990001122";
type Step = { actor: "USER" | "MANAGER"; text: string; ready?: boolean; phone?: string; handoffs?: number; duplicate?: boolean; brain?: boolean };
const scenarios: Array<{ id: string; criteria: string; steps: Step[] }> = [
  { id: "ready-side-question", criteria: "Неизвестный масштаб не мешает готовности малого бизнеса. Ответить на экономический вопрос, естественно предложить контакт, не повторять анкету. После номера один handoff, продолжить отвечать.", steps: [
    { actor: "USER", text: ready, ready: true, handoffs: 0 },
    { actor: "USER", text: "Если начну с одной, из этих денег сколько уйдёт сразу и сколько останется?", ready: true, handoffs: 0, brain: true },
    { actor: "USER", text: `Хорошо, обсудим запуск. Мой номер ${phone}`, ready: true, phone, handoffs: 1 },
    { actor: "USER", text: "А кто потом будет отвечать гостям?", ready: true, phone, handoffs: 1, brain: true },
  ] },
  { id: "phone-refusal-then-consent", criteria: "Отказ от телефона не означает NO_FIT. Ответить на вопрос о гостях без давления, затем принять добровольно предоставленный номер и передать один раз. Время связи, переданное вместе с номером, должно попасть в карточку менеджеру. Память описывает только фактически отправленные вопросы.", steps: [
    { actor: "USER", text: ready, ready: true, handoffs: 0 },
    { actor: "USER", text: "Номер пока не дам. Сначала объясните, откуда возьмутся гости и кто займётся бронированиями?", ready: true, handoffs: 0, brain: true },
    { actor: "USER", text: `Теперь понятно. Давайте свяжемся, 8 (999) 000-11-22. Звонить удобно после 18.`, ready: true, phone, handoffs: 1 },
  ] },
  { id: "early-phone-correction", criteria: "Ранний номер сам по себе не квалифицирует. Новое исправление номера имеет приоритет, карточка менеджеру содержит исправленный номер. После передачи не спрашивать его снова.", steps: [
    { actor: "USER", text: "Интересует ваше предложение. Мой телефон +79990001133.", phone: "+79990001133", handoffs: 0 },
    { actor: "USER", text: `В номере ошибся, верный ${phone}. ${ready}`, ready: true, phone, handoffs: 1 },
    { actor: "USER", text: "А 50 тысяч я плачу за каждую квартиру или за весь запуск?", ready: true, phone, handoffs: 1, brain: true },
  ] },
  { id: "no-fit-recovery-contact", criteria: "После уточнения достаточного капитала не сохранять отказ. 1,2 млн достаточно для шести объектов (830 тысяч). После телефона один handoff, повтор inbound не расходует LLM и не дублирует доставку.", steps: [
    { actor: "USER", text: "Я в Москве, хочу свой бизнес, но на запуск денег вообще нет, взять тоже негде.", handoffs: 0 },
    { actor: "USER", text: "Поясню: свободных денег на карте нет, но на запуск отложено 1 миллион 200 тысяч. Это мои средства, готов оплатить аренду, залог, подготовку и текущие расходы. Начну с шести квартир в Москве на следующей неделе. Это будет мой основной бизнес, ездить на просмотры и подписывать договоры буду сам, время 3–4 часа в день есть.", ready: true, handoffs: 0 },
    { actor: "USER", text: "Да, передайте менеджеру: 89990001122, это мой номер.", ready: true, phone, handoffs: 1, duplicate: true },
  ] },
  { id: "human-manager-contact-preference", criteria: "AI учитывает просьбу менеджера, предпочтение переписки и вопрос клиента. Не обещать звонок против воли человека, не изобретать правила связи, не возвращаться к известным фактам. После добровольного номера один handoff, карточка сохраняет просьбу сначала написать и не звонить сейчас.", steps: [
    { actor: "USER", text: ready, ready: true, handoffs: 0 },
    { actor: "MANAGER", text: "Я менеджер. Для обсуждения конкретного запуска оставьте, пожалуйста, номер телефона. По условиям объекта помогу разобраться лично." },
    { actor: "USER", text: "А без звонка можно? Я на работе, мне удобнее переписка. И какие расходы будут каждый месяц?", ready: true, handoffs: 0, brain: true },
    { actor: "USER", text: `Ладно, контакт ${phone}, но пожалуйста сначала напишите, звонить сейчас не надо.`, ready: true, phone, handoffs: 1 },
    { actor: "USER", text: "Пока ждём, а доход с одной квартиры вы гарантируете?", ready: true, phone, handoffs: 1, brain: true },
  ] },
];

async function main() {
  const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const reportPath = option("--report");
  const replayPath = option("--replay");
  assert(reportPath && (process.argv.includes("--live") || replayPath), "Explicit --live/--replay and --report required");
  assert(!replayPath || resolve(replayPath) !== resolve(reportPath), "Preserve the original live report");
  const recorded = replayPath ? JSON.parse(await readFile(replayPath, "utf8")) : null;
  const budget = Number(option("--max-cost-usd") ?? "0.15") * 1_000_000;
  assert(Number.isFinite(budget) && budget > 0 && budget <= 500_000);
  const selected = scenarios.filter(s => !option("--scenario") || s.id === option("--scenario"));
  assert(selected.length > 0);
  const maxSteps = Number(option("--max-steps") ?? "100");
  assert(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 100);
  const identity = recorded ? { provider: "qwen", model: recorded.model } : runtimeLlmIdentity(process.env, "conversation");
  assert(recorded || identity.provider === "qwen" && identity.model === "qwen3.8-flash", "Expected production Qwen identity");
  const calls = new Map<string, LlmCallRecord>();
  const reports: unknown[] = [];
  let aborted: string | null = null;
  let budgetReached = false;
  const cost = () => [...calls.values()].reduce((sum, row) => sum + (row.estimatedCostMicrousd ?? 0), 0);
  const failedScenarios = () => reports.filter(r => (r as { violations: string[] }).violations.length > 0).length;
  const save = () => writeFile(reportPath, JSON.stringify({ status: aborted ? "ABORTED" : failedScenarios() ? "FAILED_INVARIANTS" : "PENDING_MANUAL_REVIEW",
    model: identity.model, productionTouched: false, realChannelSends: 0, reports, usage: [...calls.values()],
    totalEstimatedCostMicrousd: cost(), replayOf: replayPath ?? null, aborted }, null, 2), { mode: 0o600 });
  for (const scenario of selected) {
    const persistence = await SqlitePersistence.createMigrated("file::memory:");
    const outbound = new FakeOutboundProvider();
    const notifications = new FakeManagerNotificationProvider();
    const trace: Array<{ stage: string | undefined; response: LlmTextResponse }> = [];
    const turns: unknown[] = [];
    const violations: string[] = [];
    const report = { id: scenario.id, criteria: scenario.criteria, turns, trace, violations, notifications: notifications.requests };
    reports.push(report);
    let replayIndex = 0;
    const prior = recorded?.reports.find((r: { id: string }) => r.id === scenario.id);
    const telemetry = { workload: "EVAL" as const, logger: { info() {}, error() {} }, usage: {
      list: persistence.llmUsage.list.bind(persistence.llmUsage),
      record: async (row: LlmCallRecord) => { calls.set(row.id, { ...row }); await persistence.llmUsage.record(row); },
      settle: persistence.llmUsage.settle.bind(persistence.llmUsage),
      annotate: persistence.llmUsage.annotate?.bind(persistence.llmUsage),
    } };
    const provider = (role: "extraction" | "conversation"): LlmProvider => {
      if (recorded) return { promptProfile: "compact-v1", async generateText(request) {
        const entry = prior?.trace[replayIndex++];
        assert(entry && entry.stage === request.metadata?.stage, "Replay stage mismatch");
        return { ...entry.response, callId: undefined, inputTokens: 0, outputTokens: 0 };
      } };
      const real = createRuntimeLlmProvider(process.env, role, telemetry);
      return { promptProfile: real.promptProfile, annotateCall: real.annotateCall?.bind(real), async generateText(request) {
        if (cost() >= budget || calls.size >= 90) { budgetReached = true; throw new Error("EVAL_BUDGET_REACHED"); }
        const response = await real.generateText(request);
        trace.push({ stage: request.metadata?.stage, response }); return response;
      } };
    };
    try {
      const lab = createTestChatLabService({ persistence, llmProvider: provider("extraction"),
        conversationLlmProvider: provider("conversation"), outboundProvider: outbound, managerNotificationProvider: notifications });
      const session = `synthetic-contact-${scenario.id}`;
      const start = new Date("2026-10-16T09:00:00Z");
      for (const [index, step] of scenario.steps.slice(0, maxSteps).entries()) {
        const at = new Date(start.getTime() + index * 60_000);
        if (step.actor === "MANAGER") { await lab.managerMessage(session, step.text, at, String(index)); turns.push({ actor: step.actor, text: step.text }); continue; }
        const { snapshot } = await lab.clientMessage(session, step.text, at, String(index));
        const result = { actor: step.actor, text: step.text, reply: snapshot.lastProcessing?.outboundMessage,
          qualification: snapshot.qualification, phone: snapshot.phone, handoff: snapshot.handoff,
          conversation: snapshot.conversation, lead: snapshot.lead, lastProcessing: snapshot.lastProcessing };
        turns.push(result);
        const check = (ok: boolean, code: string) => { if (!ok) violations.push(`turn-${index}:${code}`); };
        check(!snapshot.lastProcessing?.responseFailureCode, "TECHNICAL_FALLBACK");
        if (step.brain) check(snapshot.lastProcessing?.responseGenerationSource === "LLM", "SUBSTANTIVE_ANSWER_REPLACED_BY_DRAFT");
        if (step.ready) check(["QUALIFIED", "WARM", "HOT", "PRIORITY"].includes(snapshot.qualification.status ?? ""), "EXPECTED_BUSINESS_READY");
        if (step.phone) check(snapshot.phone === step.phone, "PHONE_MISMATCH");
        if (step.handoffs !== undefined) check(notifications.requests.length === step.handoffs, "HANDOFF_COUNT");
        if (step.handoffs && step.phone) check(notifications.requests[0]?.summary.phoneNumber === step.phone, "HANDOFF_PHONE_MISMATCH");
        if (step.duplicate) {
          const before = { calls: calls.size, sends: outbound.requests.length, handoffs: notifications.requests.length, replayIndex };
          await lab.clientMessage(session, step.text, at, String(index));
          check(calls.size === before.calls && replayIndex === before.replayIndex && outbound.requests.length === before.sends && notifications.requests.length === before.handoffs, "DUPLICATE_SIDE_EFFECT");
        }
        await save();
        console.log(JSON.stringify({ scenario: scenario.id, turn: index, qualification: snapshot.qualification.status,
          phoneKnown: !!snapshot.phone, handoffs: notifications.requests.length, violations: violations.length, calls: calls.size, costMicrousd: cost() }));
        if (budgetReached) throw new Error("EVAL_BUDGET_REACHED");
        if (!recorded && [...calls.values()].some(r => r.status === "ERROR" || r.status === "SUCCESS" && r.estimatedCostMicrousd === null)) throw new Error("PROVIDER_ERROR_OR_UNMETERED_USAGE");
      }
      if (recorded && maxSteps >= scenario.steps.length) assert.equal(replayIndex, prior.trace.length, "Unused recorded calls");
    } catch (error) {
      aborted = error instanceof Error && error.message === "EVAL_BUDGET_REACHED" ? "EVAL_BUDGET_REACHED" : "EVAL_ABORTED";
      await save(); throw new Error(aborted);
    } finally { persistence.close(); }
  }
  await save();
  if (failedScenarios()) process.exitCode = 1;
  console.log(JSON.stringify({ completed: true, scenarios: reports.length, failedScenarios: failedScenarios(), calls: calls.size, costMicrousd: cost(), reportPath }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "EVAL_ABORTED"); process.exitCode = 1; });
