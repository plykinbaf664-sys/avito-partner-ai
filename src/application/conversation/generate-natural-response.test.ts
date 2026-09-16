import { describe, expect, it } from "vitest";

import type { Lead } from "@/domain/lead/lead";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";

import { createNaturalResponseGenerator } from "./generate-natural-response";
import type { ConversationResponsePlan } from "@/domain/conversation/conversation-response";
import { PARTNER_KNOWLEDGE_BASE } from "@/domain/knowledge/knowledge-base";

describe("natural response generation", () => {
  const offerPlan: ConversationResponsePlan = {
    text: PARTNER_KNOWLEDGE_BASE.find((entry) => entry.id === "offer-overview")!.answer +
      " Какую сумму вы реально готовы выделить: это бюджет только на первый этап или общий доступный капитал?",
    nextInformationNeed: "AVAILABLE_CAPITAL", asksUserQuestion: true,
    knowledgeEntryIds: ["offer-overview"], unresolvedQuestions: [], useNaturalAdaptation: true,
  };
  const validOffer = "Помогаем запустить бизнес на субаренде. Первый этап — около 50 000 ₽ за подбор и рекомендации по комплектации; для квалификации нужен бюджет от 150 000 ₽, базовый запуск — около 120 000 ₽, плюс желательно около 20 000 ₽ на оснащение. Аренда, залог и комплектация — расходы партнёра, а команда помогает с бронированиями и гостями. Смета зависит от объекта, доход не гарантируется. Это ваш общий капитал или бюджет только на первый этап?";

  it.each([
    validOffer,
    validOffer.replace("50 000 ₽", "50 тыс. ₽").replace("120 000 ₽", "120 тыс. ₽").replace("20 000 ₽", "20 тыс. ₽"),
  ])("allows a natural paraphrase that keeps amounts, cost structure and restrictions", async (text) => {
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([JSON.stringify({ text })]) });
    await expect(generate({ lead: {} as Lead, plan: offerPlan, recentMessages: [] })).resolves.toMatchObject({ text });
  });

  it.each([
    validOffer.replace(", доход не гарантируется", ""),
    validOffer.replace("базовый запуск — около 120 000 ₽", "аренда и залог — около 120 000 ₽"),
    validOffer.replace("20 000 ₽", "30 000 ₽"),
    validOffer.replace("первый этап?", "первый объект?"),
    validOffer.replace("Это ваш общий капитал или бюджет только на первый этап?", "Это ваш общий капитал или бюджет только на первый этап? В каком городе?"),
    validOffer.replace("Помогаем запустить бизнес на субаренде.", "Условия лучше уточнить у менеджера."),
  ])("rejects an adaptation that changes the approved response policy", async (text) => {
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([JSON.stringify({ text })]) });
    await expect(generate({ lead: {} as Lead, plan: offerPlan, recentMessages: [] })).rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("rejects the observed live paraphrase that drops guests, cleaners and platforms", async () => {
    const plan: ConversationResponsePlan = { ...offerPlan,
      text: PARTNER_KNOWLEDGE_BASE.find((entry) => entry.id === "launch-process")!.answer,
      knowledgeEntryIds: ["launch-process"], nextInformationNeed: null, asksUserQuestion: false };
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({ text: "Команда подбирает объект, консультирует по оснащению и поддерживает запуск. Бронирования принимает администратор, размещения видны в CRM, работает персональный менеджер." }),
    ]) });
    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] })).rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("uses one compact validated call only when the workflow requests adaptation", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({ text: "Понял ваше сомнение. Уточните, пожалуйста, бюджет на запуск?" }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const lead = {
      city: null,
      budget: null,
      startingUnits: null,
      scalingPotentialUnits: null,
      launchTiming: null,
      primaryGoal: null,
    } as Lead;

    const result = await generate({
      lead,
      plan: {
        text: "Сомнение понятно. Какой бюджет вы готовы выделить на запуск?",
        nextInformationNeed: "AVAILABLE_CAPITAL",
        asksUserQuestion: true,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
      },
      recentMessages: [
        { direction: "INBOUND", content: "Первое" },
        { direction: "OUTBOUND", content: "Второе" },
        { direction: "INBOUND", content: "Третье" },
        { direction: "OUTBOUND", content: "Четвёртое" },
      ],
    });

    expect(result.text).toContain("бюджет");
    expect(llm.callCount).toBe(1);
    expect(llm.requests[0]?.maxTokens).toBe(480);
    const sentContext = JSON.parse(llm.requests[0]!.userMessage) as {
      recentMessages: { content: string }[];
    };
    expect(sentContext.recentMessages).toHaveLength(4);
    expect(llm.requests[0]?.systemPrompt).toContain("SECURITY BOUNDARY");
    expect(llm.requests[0]?.systemPrompt).toContain("Не заменяй известный ответ");
    expect(llm.requests[0]?.systemPrompt).toContain("только один следующий вопрос");
    expect(JSON.parse(llm.requests[0]!.userMessage)).toMatchObject({
      asksNextQuestion: true, unresolvedQuestions: [],
    });
    expect(llm.requests[0]?.userMessage).toContain("Первое");
  });

  it.each([
    [
      "Получается всего 120 тысяч?",
      "Да, по перечисленным ориентирам получается около 120 000 ₽. Это расчёт по примерным составляющим, итоговая смета зависит от объекта.",
    ],
    [
      "Получается всего 190 тысяч?",
      "Не совсем: по перечисленным ориентирам получается около 120 000 ₽. Это расчёт по примерным составляющим, итоговая смета зависит от объекта.",
    ],
  ])("checks a contextual total instead of trusting the client's number: %s", async (question, answer) => {
    const plan: ConversationResponsePlan = {
      text: "Первый этап — около 50 000 ₽, аренда — около 35 000 ₽, залог — около 35 000 ₽. Это ориентиры, точная смета зависит от объекта.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: ["small-business-entry"],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      contextualReference: true,
    };
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({ text: answer })]),
    });

    await expect(generate({
      lead: {} as Lead,
      plan,
      recentMessages: [
        { direction: "OUTBOUND", content: plan.text },
        { direction: "INBOUND", content: question },
      ],
    })).resolves.toMatchObject({ text: answer });
  });

  it("understands a two-object reference and permits only grounded arithmetic", async () => {
    const plan: ConversationResponsePlan = {
      text: "Ориентир по доходу — около 20 000 ₽ с одного объекта в месяц, без гарантии результата.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: ["guarantees-and-economics"],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      contextualReference: true,
    };
    const text = "Для двух объектов ориентир получается около 40 000 ₽ в месяц, но доход не гарантируется.";
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({ text })]),
    });

    await expect(generate({
      lead: {} as Lead,
      plan,
      recentMessages: [
        { direction: "OUTBOUND", content: plan.text },
        { direction: "INBOUND", content: "А если два объекта?" },
      ],
    })).resolves.toMatchObject({ text });
  });

  it("rejects an ungrounded business condition in a contextual answer", async () => {
    const plan: ConversationResponsePlan = {
      text: "Первый этап — около 50 000 ₽. Это ориентир, итог зависит от объекта.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: ["small-business-entry"],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      contextualReference: true,
    };
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({ text: "В сумму входит первый этап, также доступна рассрочка." })]),
    });

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });
});
