import { describe, expect, it } from "vitest";

import type { Lead } from "@/domain/lead/lead";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";

import { createNaturalResponseGenerator } from "./generate-natural-response";
import type { ConversationResponsePlan } from "@/domain/conversation/conversation-response";
import { PARTNER_KNOWLEDGE_BASE } from "@/domain/knowledge/knowledge-base";
import { buildApprovedEconomicsContext } from "@/domain/economics/economics-calculator";

describe("natural response generation", () => {
  const offerPlan: ConversationResponsePlan = {
    text: PARTNER_KNOWLEDGE_BASE.find((entry) => entry.id === "offer-overview")!.answer +
      " Какую сумму вы реально готовы выделить: это бюджет только на услугу или общий доступный капитал?",
    nextInformationNeed: "AVAILABLE_CAPITAL", asksUserQuestion: true,
    knowledgeEntryIds: ["offer-overview"], unresolvedQuestions: [], useNaturalAdaptation: true,
  };
  const validOffer = "Помогаем запустить бизнес на субаренде. Услуга запуска стоит 50 000 ₽; аренда, залог, подготовка и операционные расходы оплачиваются отдельно. При залоге за месяц старт считается как 80 000 ₽ плюс две аренды. Команда помогает с рекламой, бронированиями, гостями и координацией персонала. Смета зависит от объекта, доход не гарантируется. Это ваш общий капитал или бюджет только на услугу?";

  it.each([
    validOffer,
    validOffer.replace("50 000 ₽", "50 тыс. ₽").replace("80 000 ₽", "80 тыс. ₽"),
  ])("allows a natural paraphrase that keeps amounts, cost structure and restrictions", async (text) => {
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([JSON.stringify({ text })]) });
    await expect(generate({ lead: {} as Lead, plan: offerPlan, recentMessages: [] })).resolves.toMatchObject({ text });
  });

  it.each([
    validOffer.replace(", доход не гарантируется", ""),
    validOffer.replace("80 000 ₽ плюс две аренды", "100 000 ₽ плюс две аренды"),
    validOffer.replace("50 000 ₽", "60 000 ₽"),
    validOffer.replace("бюджет только на услугу?", "бюджет первого объекта?"),
    validOffer.replace("Это ваш общий капитал или бюджет только на услугу?", "Это ваш общий капитал или бюджет только на услугу? В каком городе?"),
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
      hasFreeTime: false,
      availableTimeDetails: "Только час вечером",
      launchTiming: null,
      primaryGoal: null,
      buyingIntent: "CONSIDERING",
      desiredIncome: 100_000,
      questions: ["Сколько стоит запуск?"],
      objections: ["Мало времени"],
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
      currentFacts: {
        hasFreeTime: false,
        availableTimeDetails: "Только час вечером",
        buyingIntent: "CONSIDERING",
        desiredIncome: 100_000,
        questions: ["Сколько стоит запуск?"],
        objections: ["Мало времени"],
      },
    });
    expect(llm.requests[0]?.userMessage).toContain("Первое");
  });

  it("lets the model choose one validated missing fact instead of following the fallback order", async () => {
    const text = "Понял, на старте готовы выделить 300 000 ₽. Когда примерно хотите запустить первый объект?";
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([
        JSON.stringify({ text, nextInformationNeed: "LAUNCH_TIMING" }),
      ]),
    });
    const plan: ConversationResponsePlan = {
      text: "Какую сумму вы готовы выделить на запуск?",
      nextInformationNeed: "AVAILABLE_CAPITAL",
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL", "LAUNCH_TIMING", "GOAL"],
      allowedNextQuestions: [
        { need: "AVAILABLE_CAPITAL", question: "Какую сумму вы готовы выделить на запуск?" },
        { need: "LAUNCH_TIMING", question: "Когда примерно рассматриваете запуск?" },
        { need: "GOAL", question: "Какую цель хотите решить этим бизнесом?" },
      ],
      knownFacts: ["CITY"],
      missingCriticalFacts: ["AVAILABLE_CAPITAL", "LAUNCH_TIMING", "GOAL"],
      missingOptionalFacts: [],
      qualificationReasonCodes: ["CAPITAL_UNKNOWN"],
    };

    await expect(generate({
      lead: {
        city: "Екатеринбург",
        availableCapital: 300_000,
        availableCapitalConfirmed: true,
      } as Lead,
      plan,
      recentMessages: [],
    }))
      .resolves.toMatchObject({ text, nextInformationNeed: "LAUNCH_TIMING" });
  });

  it("passes deterministic economics capability and rejects invented values", async () => {
    const economicsContext = buildApprovedEconomicsContext({
      availableCapital: 250_000,
      requestedUnits: 2,
    });
    const plan: ConversationResponsePlan = {
      text: "По утверждённому региональному ориентиру 250 000 ₽ хватает примерно на 2 объекта; ориентир дохода для двух объектов — 40 000 ₽ в месяц, без гарантии.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      economicsContext,
    };
    const accepted = "При региональном ориентире 250 000 ₽ — это около 2 объектов. Ориентир дохода для двух объектов — около 40 000 ₽ в месяц, но это не гарантия.";
    const llm = new FakeLLMProvider([JSON.stringify({ text: accepted })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] })).resolves.toMatchObject({ text: accepted });
    expect(llm.requests[0]?.userMessage).toContain("economicsContext");

    const invented = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({
        text: "При этих условиях получится 3 объекта с доходом 60 000 ₽ в месяц.",
      })]),
    });
    await expect(invented({ lead: {} as Lead, plan, recentMessages: [] }))
      .rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("lets the conversation brain answer semantically from approved facts", async () => {
    const text = "Бухгалтерское сопровождение входит в поддержку компании, поэтому вести бухгалтерию самостоятельно не требуется. Ваша сторона занимается объектом и необходимыми договорами.";
    const llm = new FakeLLMProvider([JSON.stringify({
      text,
      answerCoverage: "FULL",
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      approvedFacts: [
        {
          id: "pricing",
          category: "PRICING",
          answer: "Есть бухгалтерское и юридическое сопровождение.",
        },
        {
          id: "launch-process",
          category: "OPERATIONS",
          answer: "Партнёр ездит на объекты и заключает необходимые договоры.",
        },
      ],
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ text, answerCoverage: "FULL" });
    const sentContext = JSON.parse(llm.requests[0]!.userMessage) as {
      approvedFacts: { id: string }[];
    };
    expect(sentContext.approvedFacts.map((fact) => fact.id)).toEqual(["pricing", "launch-process"]);
  });

  it("preserves partial answerability instead of turning the whole turn into fallback", async () => {
    const text = "Ориентир запуска трёх квартир в Москве — около 440 000 ₽ по утверждённой модели. Конкретные квартиры заранее назвать нельзя: они зависят от подбора объекта.";
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({
        text,
        answerCoverage: "PARTIAL",
        unresolvedTopics: ["конкретные квартиры"],
      })]),
    });
    const plan: ConversationResponsePlan = {
      text: "Ориентир запуска трёх квартир в Москве — около 440 000 ₽.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ answerCoverage: "PARTIAL", unresolvedTopics: ["конкретные квартиры"] });
  });

  it("rejects a full-coverage claim that still reports an unresolved topic", async () => {
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({
        text: "Не знаю.",
        answerCoverage: "FULL",
        unresolvedTopics: ["актуальная аренда"],
      })]),
    });

    await expect(generate({
      lead: {} as Lead,
      plan: {
        text: "",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
      },
      recentMessages: [],
    })).rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("rejects a next step outside deterministic allowed needs", async () => {
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([
        JSON.stringify({ text: "Оставьте номер телефона?", nextInformationNeed: "PHONE_NUMBER" }),
      ]),
    });
    const plan: ConversationResponsePlan = {
      text: "Когда примерно рассматриваете запуск?",
      nextInformationNeed: "LAUNCH_TIMING",
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      allowedNextInformationNeeds: ["LAUNCH_TIMING", "GOAL"],
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it.each([
    [
      "Получается всего 150 тысяч?",
      "Да, по перечисленным ориентирам получается около 150 000 ₽. Это расчёт по примерным составляющим, итоговая смета зависит от объекта.",
    ],
    [
      "Получается всего 190 тысяч?",
      "Не совсем: по перечисленным ориентирам получается около 150 000 ₽. Это расчёт по примерным составляющим, итоговая смета зависит от объекта.",
    ],
  ])("checks a contextual total instead of trusting the client's number: %s", async (question, answer) => {
    const plan: ConversationResponsePlan = {
      text: "Услуга — около 50 000 ₽, аренда — около 35 000 ₽, залог — около 35 000 ₽, подготовка — около 30 000 ₽. Это ориентиры, точная смета зависит от объекта.",
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

  it("allows an explicit no-reply decision after a manager-led step", async () => {
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([
        JSON.stringify({ replyAction: "NO_REPLY", text: "", nextInformationNeed: null }),
      ]),
    });

    await expect(generate({
      lead: {} as Lead,
      plan: {
        text: "Спасибо, Дмитрий свяжется с вами.",
        nextInformationNeed: "PHONE_NUMBER",
        asksUserQuestion: true,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
      },
      recentMessages: [
        { direction: "OUTBOUND", actor: "MANAGER", content: "Оставьте номер, я вам позвоню." },
        { direction: "INBOUND", actor: "USER", content: "89049163020" },
      ],
    })).resolves.toMatchObject({ replyAction: "NO_REPLY", text: "", nextInformationNeed: null });
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
