import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicLLMProvider } from "./anthropic-llm-provider";
import { createNaturalResponseGenerator } from "@/application/conversation/generate-natural-response";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";
import type { Lead } from "@/domain/lead/lead";
import type { LlmTextResponse } from "@/application/ports/llm-provider";
import { PARTNER_KNOWLEDGE_BASE } from "@/domain/knowledge/knowledge-base";

const facts = PARTNER_KNOWLEDGE_BASE.map(({ id, category, answer }) => ({ id, category, answer }));
const answer = JSON.stringify({ text: "", answerText: "Команда поможет подобрать подходящий объект.",
  qualificationQuestion: "", interpretedQuestionKind: "RECOMMENDATION", usedKnowledgeEntryIds: ["launch-process"] });
const review = (supported: boolean) => JSON.stringify({ answerIsSupported: supported,
  answersCurrentRequest: true, optionalQuestionAppropriate: true, feedback: supported ? "" : "Исправьте неподтверждённое действие." });
const reply = (text: string, tokens: number): LlmTextResponse => ({ text, model: "fake-model", inputTokens: tokens, outputTokens: tokens / 10 });
const input = { lead: {} as Lead, recentMessages: [{ direction: "INBOUND" as const, content: "Помогите выбрать первое действие." }],
  plan: { text: "", nextInformationNeed: null, asksUserQuestion: false, knowledgeEntryIds: [],
    unresolvedQuestions: [], useNaturalAdaptation: true, currentTurnRequiresAnswer: true, approvedFacts: facts } };

describe("LLM cost regressions", () => {
  it("preserves the whole current request and verified facts for the generator and critic", async () => {
    const current = "Подробности. ".repeat(240) + "Помогите выбрать первое действие.";
    const llm = new FakeLLMProvider([reply(answer, 10), reply(review(true), 20)]);
    await createNaturalResponseGenerator({ llmProvider: llm })({ ...input,
      lead: { businessExperience: "Опыт управления", managementReadiness: "READY" } as Lead,
      conversationMemory: "Менеджер согласовал обсуждение первого шага.",
      recentMessages: [{ direction: "INBOUND", actor: "USER", content: current }] });
    for (const request of llm.requests) {
      const context = JSON.parse(request.userMessage);
      expect(context.currentExchange.activeUserTurn).toEqual([current]);
      expect(context.currentFacts.businessExperience).toBe("Опыт управления");
      expect(context.conversationMemory).toContain("Менеджер согласовал");
    }
  });
  it("retains usage of rejected generation and review when repair succeeds", async () => {
    const llm = new FakeLLMProvider([reply(answer, 10), reply(review(false), 20), reply(answer, 30), reply(review(true), 40)]);
    const result = await createNaturalResponseGenerator({ llmProvider: llm })(input);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(10);
    expect(result.llmUsage?.calls).toBe(4);
  });

  it("retains already paid usage when repair fails", async () => {
    const llm = new FakeLLMProvider([reply(answer, 10), reply(review(false), 20), new Error("safe-provider-failure")]);
    const error = await createNaturalResponseGenerator({ llmProvider: llm })(input).catch(error => error);
    expect(error.llmUsage).toMatchObject({ calls: 3, successfulCalls: 2, inputTokens: 30, outputTokens: 3, complete: false });
  });

  it("caches approved facts before mutable context and keeps the prefix stable", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{}" }], model: "test-model",
      usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" });
    const provider = new AnthropicLLMProvider({ apiKey: "test-key", model: "test-model", timeoutMs: 50 },
      { messages: { create } } as unknown as Anthropic);
    for (const current of ["Первый запрос", "Другой запрос"]) {
      await provider.generateText({ systemPrompt: "Stable instructions", userMessage: JSON.stringify({ current, approvedFacts: facts }),
        maxTokens: 100, cache: { stableFields: ["approvedFacts"], ttl: "5m" } });
    }
    const first = create.mock.calls[0]![0];
    const second = create.mock.calls[1]![0];
    expect(first.system).toEqual(second.system);
    expect(first.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.parse(first.messages[0].content)).not.toHaveProperty("approvedFacts");
    expect(JSON.stringify(first.system)).toContain("launch-process");
    expect(JSON.parse(first.messages[0].content).current).toBe("Первый запрос");
  });
});
