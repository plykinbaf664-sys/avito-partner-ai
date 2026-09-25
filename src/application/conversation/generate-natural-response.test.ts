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
  const validOffer = "Помогаем запустить бизнес на субаренде. Услуга запуска стоит 50 000 ₽; аренда, залог, подготовка и операционные расходы оплачиваются отдельно. Для предварительного расчёта с залогом за месяц старт считается как 80 000 ₽ плюс две аренды, но фактический залог зависит от собственника. Команда помогает с рекламой, бронированиями, гостями и координацией персонала. Смета зависит от объекта, доход не гарантируется. Какой общий бюджет готовы вложить в запуск?";

  it.each([
    validOffer,
    validOffer.replace("50 000 ₽", "50 тыс. ₽").replace("80 000 ₽", "80 тыс. ₽"),
  ])("allows a natural paraphrase that keeps amounts, cost structure and restrictions", async (text) => {
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({ text, nextInformationNeed: "AVAILABLE_CAPITAL" }),
    ]) });
    await expect(generate({ lead: {} as Lead, plan: offerPlan, recentMessages: [] })).resolves.toMatchObject({ text });
  });

  it.each([
    validOffer.replace("80 000 ₽ плюс две аренды", "100 000 ₽ плюс две аренды"),
    validOffer.replace("50 000 ₽", "60 000 ₽"),
    validOffer.replace("Смета зависит от объекта, доход не гарантируется.", "Доход гарантирован при любом объекте."),
    validOffer.replace("Какой общий бюджет готовы вложить в запуск?", "Какой общий бюджет готовы вложить в запуск? В каком городе?"),
    validOffer.replace("Помогаем запустить бизнес на субаренде.", "Условия лучше уточнить у менеджера."),
  ])("rejects an adaptation that changes the approved response policy", async (text) => {
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({ text, nextInformationNeed: "AVAILABLE_CAPITAL" }),
    ]) });
    await expect(generate({ lead: {} as Lead, plan: offerPlan, recentMessages: [] })).rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("allows progressive disclosure instead of forcing every draft detail", async () => {
    const plan: ConversationResponsePlan = { ...offerPlan,
      text: PARTNER_KNOWLEDGE_BASE.find((entry) => entry.id === "launch-process")!.answer,
      knowledgeEntryIds: ["launch-process"], nextInformationNeed: null, asksUserQuestion: false };
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({ text: "Команда подбирает объект, консультирует по оснащению и поддерживает запуск. Бронирования принимает администратор, размещения видны в CRM, работает персональный менеджер." }),
    ]) });
    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({
        text: "Команда подбирает объект, консультирует по оснащению и поддерживает запуск. Бронирования принимает администратор, размещения видны в CRM, работает персональный менеджер.",
      });
  });

  it("uses one compact validated call only when the workflow requests adaptation", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Понял ваше сомнение. Уточните, пожалуйста, бюджет на запуск?",
        nextInformationNeed: "AVAILABLE_CAPITAL",
      }),
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
      qualificationStatus: "NO_FIT",
      qualificationReason: "INSUFFICIENT_LAUNCH_CAPITAL",
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
        qualificationReasonCodes: ["INSUFFICIENT_LAUNCH_CAPITAL"],
        customerFacingDecision: "REJECT",
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
      currentFacts: Record<string, unknown>;
    };
    expect(sentContext.recentMessages).toHaveLength(4);
    expect(llm.requests[0]?.systemPrompt).toContain("SECURITY BOUNDARY");
    expect(llm.requests[0]?.systemPrompt).toContain("Не заменяй известный ответ");
    expect(llm.requests[0]?.systemPrompt).toContain("не более одного направления");
    expect(JSON.parse(llm.requests[0]!.userMessage)).toMatchObject({
      qualificationMoveAvailable: true, unresolvedQuestions: [],
      currentFacts: {
        hasFreeTime: false,
        availableTimeDetails: "Только час вечером",
        buyingIntent: "CONSIDERING",
        desiredIncome: 100_000,
        questions: ["Сколько стоит запуск?"],
        objections: ["Мало времени"],
      },
    });
    expect(sentContext).not.toHaveProperty("qualificationReasonCodes");
    expect(sentContext.currentFacts).not.toHaveProperty("qualificationStatus");
    expect(sentContext.currentFacts).not.toHaveProperty("qualificationReason");
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

  it("passes compact conversational memory as context without presenting fallback copy to the model", async () => {
    const llm = new FakeLLMProvider([JSON.stringify({
      text: "Понимаю сомнение. Давайте сначала разберёмся, какой формат Вам подходит.",
      nextInformationNeed: null,
      conversationAction: "ANSWER",
      qualificationMoveDecision: "DEFER",
      qualificationMoveRationale: "Сначала отвечаю на сомнение клиента.",
      conversationMemory: "Человек хочет понять формат до обсуждения бюджета.",
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Какой бюджет Вы готовы выделить?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL"],
      qualificationProgressExpected: true,
    };

    const result = await generate({
      lead: {} as Lead,
      plan,
      conversationMemory: "Клиент уже обсуждал формат и не захотел сразу назвать бюджет.",
      recentMessages: [
        { direction: "OUTBOUND", content: "Какой бюджет готовы вложить?" },
        { direction: "INBOUND", content: "Сначала расскажите, зачем это нужно" },
      ],
    });

    expect(result.conversationMemory).toContain("понять формат");
    const context = JSON.parse(llm.requests[0]!.userMessage);
    expect(context.conversationMemory).toContain("не захотел сразу назвать бюджет");
    expect(context.currentExchange).toEqual({
      previousSpeakerTurn: "Какой бюджет готовы вложить?",
      activeUserTurn: ["Сначала расскажите, зачем это нужно"],
    });
    expect(context).not.toHaveProperty("fallbackDraft");
  });

  it("presents consecutive inbound messages as one active conversational turn", async () => {
    const llm = new FakeLLMProvider([JSON.stringify({
      text: "Спасибо, понял Вашу ситуацию.",
      nextInformationNeed: null,
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    await generate({
      lead: {} as Lead,
      plan: { ...offerPlan, nextInformationNeed: null, asksUserQuestion: false },
      recentMessages: [
        { direction: "OUTBOUND", content: "Расскажите о себе." },
        { direction: "INBOUND", content: "Здравствуйте" },
        { direction: "INBOUND", content: "Нижний Новгород" },
        { direction: "INBOUND", content: "100 тысяч на старт" },
      ],
    });
    const context = JSON.parse(llm.requests[0]!.userMessage);
    expect(context.currentExchange).toEqual({
      previousSpeakerTurn: "Расскажите о себе.",
      activeUserTurn: ["Здравствуйте", "Нижний Новгород", "100 тысяч на старт"],
    });
  });

  it("keeps a grounded answer when only the optional next-need metadata is inconsistent", async () => {
    const timeFact = PARTNER_KNOWLEDGE_BASE.find((entry) => entry.id === "partner-time")!;
    const llm = new FakeLLMProvider([JSON.stringify({
      text: "Ориентир личного участия — около 3–4 часов в день. В это время входят просмотры объектов и ключевые решения по запуску.",
      nextInformationNeed: "FREE_TIME",
      conversationAction: "ANSWER",
      qualificationMoveDecision: "ADVANCE",
      usedKnowledgeEntryIds: [timeFact.id],
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    await expect(generate({
      lead: {} as Lead,
      plan: {
        text: timeFact.answer,
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [timeFact.id],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        currentTurnRequiresAnswer: true,
        groundedAnswerRequired: true,
        allowedNextInformationNeeds: ["FREE_TIME"],
        approvedFacts: [{ id: timeFact.id, category: timeFact.category, answer: timeFact.answer }],
      },
      recentMessages: [{ direction: "INBOUND", content: "Какое участие потребуется от меня?" }],
    })).resolves.toMatchObject({
      nextInformationNeed: null,
      qualificationMoveDecision: "DEFER",
      text: expect.stringContaining("3–4 часов"),
    });
  });

  it("allows a substantive follow-up to reuse recently explained approved knowledge", async () => {
    const timeFact = PARTNER_KNOWLEDGE_BASE.find((entry) => entry.id === "partner-time")!;
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text: "Если речь о Вашем личном времени, ориентир — около 3–4 часов в день на этапе запуска; точный график зависит от объекта и Вашего участия в просмотрах.",
        nextInformationNeed: null,
        conversationAction: "ANSWER",
        qualificationMoveDecision: "DEFER",
        qualificationMoveRationale: "Уточнил предыдущий ответ о времени.",
        usedKnowledgeEntryIds: [timeFact.id],
      }),
    ]) });
    await expect(generate({
      lead: {} as Lead,
      plan: {
        text: "Спасибо, понял.",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        currentTurnRequiresAnswer: true,
        currentQuestionKind: "CLARIFICATION",
        previouslyExplainedKnowledgeEntryIds: [timeFact.id],
        approvedFacts: [{ id: timeFact.id, category: timeFact.category, answer: timeFact.answer }],
      },
      recentMessages: [
        { direction: "OUTBOUND", content: "При запуске потребуется Ваше личное участие." },
        { direction: "INBOUND", content: "А сколько надо?" },
      ],
    })).resolves.toMatchObject({ text: expect.stringContaining("3–4 часов") });
  });

  it("rejects an affordable-unit range that exceeds the deterministic calculator", async () => {
    const economicsContext = buildApprovedEconomicsContext({
      city: "Москва",
      availableCapital: 400_000,
    });
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text: "При Вашем бюджете можно запустить 2–3 объекта в Москве.",
        nextInformationNeed: null,
        conversationAction: "ANSWER",
      }),
    ]) });
    await expect(generate({
      lead: { city: "Москва", availableCapital: 400_000 } as Lead,
      plan: {
        text: "По утверждённому расчёту при 400 000 ₽ доступны два объекта.",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        currentTurnRequiresAnswer: true,
        economicsContext,
      },
      recentMessages: [{ direction: "INBOUND", content: "Со скольких можно начать?" }],
    })).rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("rejects adding the launch fee a second time to an approved startup total", async () => {
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text: "Один объект в Москве обойдётся примерно в 180 тысяч на аренду, залог и подготовку плюс 50 тысяч за помощь в запуске.",
        nextInformationNeed: null,
        conversationAction: "ANSWER",
      }),
    ]) });
    await expect(generate({
      lead: { city: "Москва", availableCapital: 400_000 } as Lead,
      plan: {
        text: "Ориентир запуска одного объекта в Москве — 180 000 ₽, включая услугу запуска.",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        currentTurnRequiresAnswer: true,
        economicsContext: buildApprovedEconomicsContext({ city: "Москва", availableCapital: 400_000 }),
      },
      recentMessages: [{ direction: "INBOUND", content: "Со скольких объектов начать?" }],
    })).rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("keeps a natural deterministic rejection when only next-step metadata is stray", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Для старта одного объекта по предварительному расчёту нужно около 150 000 ₽, включая помощь с запуском, аренду, залог и подготовку. Названных Вами 100 000 ₽ пока недостаточно; точная смета зависит от квартиры.",
        nextInformationNeed: "GOAL",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    await expect(generate({
      lead: { availableCapital: 100_000 } as Lead,
      plan: {
        text: "Для запуска одного объекта нужно 150 000 ₽.",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        currentTurnRequiresAnswer: false,
        customerFacingDecision: "REJECT",
        allowedNextInformationNeeds: [],
        economicsContext: buildApprovedEconomicsContext({ availableCapital: 100_000 }),
      },
      recentMessages: [{ direction: "INBOUND", content: "У меня 100 тысяч на запуск" }],
    })).resolves.toMatchObject({ nextInformationNeed: null });
    expect(llm.requests[0]?.maxTokens).toBeGreaterThan(480);
  });

  it("does not replace a capital-based rejection with an invented city exclusion", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "При 100 000 ₽ пока не получится: запуск требует около 150 000 ₽, а в вашем городе мы не работаем.",
        nextInformationNeed: null,
      }),
      JSON.stringify({
        text: "Для запуска одного объекта по предварительному расчёту нужно около 150 000 ₽ с учётом услуги, аренды, залога и подготовки. Названных Вами 100 000 ₽ пока недостаточно; возможность работы в городе проверяется отдельно.",
        nextInformationNeed: null,
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const result = await generate({
      lead: { city: "Нижний Новгород", availableCapital: 100_000 } as Lead,
      plan: {
        text: "Для одного объекта нужно 150 000 ₽, названного бюджета пока недостаточно.",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        customerFacingDecision: "REJECT",
        customerFacingDecisionReason: "INSUFFICIENT_LAUNCH_CAPITAL",
        serviceabilityStatus: "NEEDS_REVIEW",
        economicsContext: buildApprovedEconomicsContext({ availableCapital: 100_000, city: "Нижний Новгород" }),
      },
      recentMessages: [{ direction: "INBOUND", content: "Нижний Новгород, 100 тысяч" }],
    });
    expect(result.text).toContain("150 000 ₽");
    expect(result.text).not.toContain("не работаем");
    expect(llm.callCount).toBe(2);
  });

  it("repairs a terminal policy answer that appends an unrelated questionnaire question", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Для одного объекта нужно около 150 000 ₽, Ваших 100 000 ₽ пока недостаточно. Когда Вы планируете запуск?",
        nextInformationNeed: null,
      }),
      JSON.stringify({
        text: "Для одного объекта предварительно нужно около 150 000 ₽, включая помощь с запуском и расходы по квартире. Названных Вами 100 000 ₽ пока недостаточно; если обстоятельства изменятся, можно вернуться к разговору.",
        nextInformationNeed: null,
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const result = await generate({
      lead: { city: "Нижний Новгород", availableCapital: 100_000 } as Lead,
      plan: {
        text: "Для одного объекта нужно 150 000 ₽.",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        customerFacingDecision: "REJECT",
        customerFacingDecisionReason: "INSUFFICIENT_LAUNCH_CAPITAL",
        economicsContext: buildApprovedEconomicsContext({ city: "Нижний Новгород", availableCapital: 100_000 }),
      },
      recentMessages: [{ direction: "INBOUND", content: "Нижний Новгород, 100 тысяч" }],
    });
    expect(result.text).not.toContain("?");
    expect(llm.callCount).toBe(2);
  });

  it("makes approved calculations available without making them the current topic", async () => {
    const llm = new FakeLLMProvider([JSON.stringify({
      text: "Спасибо, понял. Что Вам важнее всего узнать о запуске?",
      nextInformationNeed: null,
      qualificationMoveDecision: "DEFER",
      qualificationMoveRationale: "Пользователь ещё выбирает интересующую тему.",
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Спасибо, понял.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentTurnRequiresAnswer: true,
    };

    await generate({
      lead: { city: "Москва", availableCapital: 300_000 } as Lead,
      plan,
      recentMessages: [{ direction: "INBOUND", content: "Я пока разбираюсь" }],
    });

    const context = JSON.parse(llm.requests[0]!.userMessage);
    expect(context.economicsContext).toBeNull();
    expect(context.availableEconomics.scenarios[0].oneObjectLaunch.totalMin).toBe(180_000);
    expect(context.calculationFacts[0]).toMatchObject({
      oneObjectStartupTotal: 180_000,
      startupTotalIncludesOneTimeLaunchFee: true,
      oneTimeLaunchFee: 50_000,
      maximumAffordableObjects: 1,
      capitalShortfallForOneObject: 0,
      capitalAmountConfirmed: false,
    });
    expect(context).not.toHaveProperty("fallbackDraft");
  });

  it("grounds an unconfirmed low budget with a provisional cost gap without changing qualification", async () => {
    const llm = new FakeLLMProvider([JSON.stringify({
      text: "Для одного объекта предварительный ориентир — 150 000 ₽. Названных 100 000 ₽ пока меньше; это весь доступный бюджет?",
      nextInformationNeed: "ADDITIONAL_EXPENSES",
      conversationAction: "ANSWER",
      qualificationMoveDecision: "ADVANCE",
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    await generate({
      lead: { city: "Нижний Новгород", availableCapital: 100_000, availableCapitalConfirmed: false } as Lead,
      plan: {
        text: "Уточните, есть ли дополнительные средства?",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        allowedNextInformationNeeds: ["ADDITIONAL_EXPENSES"],
      },
      recentMessages: [{ direction: "INBOUND", content: "100 тысяч" }],
    });
    const context = JSON.parse(llm.requests[0]!.userMessage);
    expect(context.calculationFacts[0]).toMatchObject({
      oneObjectStartupTotal: 150_000,
      capitalShortfallForOneObject: 50_000,
      capitalAmountConfirmed: false,
    });
  });

  it("repairs a budget-scope question that omits the approved shortfall", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Это весь бюджет на запуск?",
        nextInformationNeed: "AVAILABLE_CAPITAL",
      }),
      JSON.stringify({
        text: "Для одного объекта предварительный ориентир — 150 000 ₽, включая услугу запуска и расходы по объекту. Вы назвали 100 000 ₽ — это весь доступный бюджет?",
        nextInformationNeed: "AVAILABLE_CAPITAL",
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const result = await generate({
      lead: { city: "Нижний Новгород", availableCapital: 100_000, availableCapitalConfirmed: false } as Lead,
      plan: {
        text: "Это весь бюджет?",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        allowedNextInformationNeeds: ["AVAILABLE_CAPITAL"],
      },
      recentMessages: [{ direction: "INBOUND", content: "100 тысяч на старт" }],
    });
    expect(result.text).toContain("150 000 ₽");
    expect(llm.callCount).toBe(2);
  });

  it("rejects internal qualification identifiers in customer-facing model output", async () => {
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text: "Статус NO_FIT: INSUFFICIENT_LAUNCH_CAPITAL",
        nextInformationNeed: null,
      }),
    ]) });
    await expect(generate({ lead: {} as Lead, plan: offerPlan, recentMessages: [] }))
      .rejects.toThrow("RESPONSE_POLICY_INTERNAL_IDENTIFIER_LEAK");
  });

  it("allows a short confirmation response without forcing the next qualification question", async () => {
    const text = "Понял, этот порядок вложений вам подходит.";
    const llm = new FakeLLMProvider([JSON.stringify({
      text,
      nextInformationNeed: null,
      conversationAction: "ACKNOWLEDGE",
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Какой бюджет в целом готовы выделить на запуск бизнеса?",
      nextInformationNeed: "AVAILABLE_CAPITAL",
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "CONFIRMATION",
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL", "LAUNCH_TIMING"],
      allowedQualificationMoves: [
        { need: "AVAILABLE_CAPITAL", objective: "понять общий бюджет запуска" },
        { need: "LAUNCH_TIMING", objective: "понять срок запуска" },
      ],
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({
        text,
        nextInformationNeed: null,
        conversationAction: "ACKNOWLEDGE",
      });
  });

  it("accepts a substantive answer and natural clarification without forcing a qualification field", async () => {
    const text = "Да, сейчас Вы общаетесь с AI-консультантом. Я помогу разобраться в формате; что для Вас важно узнать сначала?";
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text,
        nextInformationNeed: null,
        conversationAction: "ANSWER",
        qualificationMoveDecision: "NOT_APPLICABLE",
        answerCoverage: "FULL",
      }),
    ]) });
    const plan: ConversationResponsePlan = {
      text: "Какой бюджет готовы вложить?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentTurnRequiresAnswer: true,
      groundedAnswerRequired: true,
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL", "GOAL"],
    };

    await expect(generate({
      lead: {} as Lead,
      plan,
      recentMessages: [{ direction: "INBOUND", content: "Я с ботом разговариваю?" }],
    })).resolves.toMatchObject({ text, nextInformationNeed: null });
  });

  it("accepts a conversational meta-answer without pretending it is a business-fact answer", async () => {
    const text = "Да, сейчас Вы общаетесь с AI-консультантом. Чем я могу Вам помочь разобраться в предложении?";
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text,
        nextInformationNeed: null,
        conversationAction: "ACKNOWLEDGE",
        qualificationMoveDecision: "NOT_APPLICABLE",
        answerCoverage: "FULL",
      }),
    ]) });
    const plan: ConversationResponsePlan = {
      text: "Какой бюджет готовы вложить?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentQuestionKind: "CONVERSATION_META",
      currentTurnRequiresAnswer: true,
      groundedAnswerRequired: false,
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL"],
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ text, nextInformationNeed: null });
  });

  it("allows relevant approved knowledge when explaining why a conversation topic matters", async () => {
    const timeFact = PARTNER_KNOWLEDGE_BASE.find((entry) => entry.id === "partner-time")!;
    const text = "Спрашиваю о времени, чтобы понять, сможете ли Вы участвовать в запуске: ориентир — около 3–4 часов в день. Удобно ли Вам это?";
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text,
        nextInformationNeed: null,
        conversationAction: "ANSWER",
        qualificationMoveDecision: "DEFER",
        qualificationMoveRationale: "Сначала отвечаю на встречный вопрос о смысле шага.",
        usedKnowledgeEntryIds: [timeFact.id],
      }),
    ]) });
    const plan: ConversationResponsePlan = {
      text: "Сможете уделять проекту 3–4 часа в день?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentQuestionKind: "CONVERSATION_META",
      currentTurnRequiresAnswer: true,
      groundedAnswerRequired: false,
      previouslyExplainedKnowledgeEntryIds: ["small-business-entry"],
      approvedFacts: [{ id: timeFact.id, category: timeFact.category, answer: timeFact.answer }],
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ text });
  });

  it("recovers once from a truncated contextual response instead of falling into a scripted question", async () => {
    const llm = new FakeLLMProvider([
      '{"replyAction":"SEND_REPLY","text":"Оборванный ответ',
      JSON.stringify({
        text: "Уточняю сроки, чтобы понять, насколько скоро Вам понадобится помощь с подбором и запуском. Если Вам удобнее, можем пока обсудить сам формат.",
        nextInformationNeed: null,
        conversationAction: "ANSWER",
        qualificationMoveDecision: "DEFER",
        qualificationMoveRationale: "Сначала отвечаю на вопрос о смысле срока.",
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Когда планируете запуск?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentTurnRequiresAnswer: true,
      groundedAnswerRequired: true,
      qualificationProgressExpected: true,
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ nextInformationNeed: null });
    expect(llm.callCount).toBe(2);
    expect(llm.requests[0]?.maxTokens).toBeGreaterThan(480);
  });

  it("recovers once from schema-invalid response metadata without losing a user turn", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({ text: "Ответ есть", conversationAction: "INVALID" }),
      JSON.stringify({
        text: "Лично участвовать в запуске ориентировочно нужно 3–4 часа в день.",
        nextInformationNeed: null,
        conversationAction: "ANSWER",
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const result = await generate({
      lead: {} as Lead,
      plan: {
        text: "Ориентир участия партнёра — около 3–4 часов в день.",
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        currentTurnRequiresAnswer: true,
      },
      recentMessages: [{ direction: "INBOUND", content: "Сколько времени понадобится?" }],
    });
    expect(result.text).toContain("3–4 часа");
    expect(llm.callCount).toBe(2);
  });

  it("does not mistake an approved startup amount for a numerical income claim", async () => {
    const text = "Бюджет помогает понять масштаб и ожидания от дохода. Запуск одного объекта в Москве по предварительному расчёту стоит около 180 000 ₽, включая аренду, залог и подготовку. Какую сумму Вы рассматриваете?";
    const generate = createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
      JSON.stringify({
        text,
        nextInformationNeed: "AVAILABLE_CAPITAL",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        usedKnowledgeEntryIds: ["small-business-entry"],
      }),
    ]) });
    const plan: ConversationResponsePlan = {
      text: "Какой бюджет Вы рассматриваете?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentQuestionKind: "CONVERSATION_META",
      currentTurnRequiresAnswer: true,
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL"],
      approvedFacts: PARTNER_KNOWLEDGE_BASE.map(({ id, category, answer }) => ({ id, category, answer })),
    };

    await expect(generate({ lead: { city: "Москва" } as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ text });
  });

  it("retries a vacuous acknowledgement when active qualification must progress", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Понял.",
        nextInformationNeed: null,
        conversationAction: "ACKNOWLEDGE",
      }),
      JSON.stringify({
        text: "Понял. Когда хотели бы запустить первый объект?",
        nextInformationNeed: "LAUNCH_TIMING",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Срок запуска — уместный следующий шаг после подтверждения бюджета.",
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Когда примерно рассматриваете запуск?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "CONFIRMATION",
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["LAUNCH_TIMING", "GOAL"],
      allowedQualificationMoves: [
        { need: "LAUNCH_TIMING", objective: "понять срок запуска" },
        { need: "GOAL", objective: "понять цель человека" },
      ],
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({
        nextInformationNeed: "LAUNCH_TIMING",
        qualificationMoveDecision: "ADVANCE",
      });
    expect(llm.callCount).toBe(2);
    expect(JSON.parse(llm.requests[1]!.userMessage)).toMatchObject({
      qualificationProgressExpected: true,
      validationFeedback: expect.stringContaining("остановил активную квалификацию"),
    });
  });

  it("lets Claude defer a qualification question for a concrete conversational reason", async () => {
    const llm = new FakeLLMProvider([JSON.stringify({
      text: "Понял, к этому можно вернуться позже.",
      nextInformationNeed: null,
      conversationAction: "ACKNOWLEDGE",
      qualificationMoveDecision: "DEFER",
      qualificationMoveRationale: "Пользователь явно попросил пока не углубляться в тему.",
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Какую цель хотите решить этим бизнесом?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUALIFICATION_INFORMATION",
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["GOAL", "CITY"],
      allowedQualificationMoves: [
        { need: "GOAL", objective: "понять цель человека" },
        { need: "CITY", objective: "узнать город запуска" },
      ],
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({
        nextInformationNeed: null,
        qualificationMoveDecision: "DEFER",
      });
    expect(llm.callCount).toBe(1);
  });

  it("retries when a qualification question replaces an answerable current question", async () => {
    const approvedFact = PARTNER_KNOWLEDGE_BASE.find(
      (entry) => entry.id === "small-business-entry",
    )!;
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Рассматриваете запуск через управляющую компанию?",
        nextInformationNeed: "BUSINESS_MODEL",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Продолжить квалификацию.",
      }),
      JSON.stringify({
        text: "Для Москвы предварительный ориентир расходов на один объект — около 130 000 ₽: аренда, расчётный залог и подготовка. Точная сумма зависит от квартиры и собственника. Какую цель хотите решить этим бизнесом?",
        nextInformationNeed: "GOAL",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Сначала ответил на вопрос о расходах, затем перешёл к цели.",
        usedKnowledgeEntryIds: ["small-business-entry"],
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: approvedFact.answer,
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [approvedFact.id],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentUserQuestions: ["А сколько там примерно?"],
      groundedAnswerRequired: true,
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["BUSINESS_MODEL", "GOAL"],
      allowedQualificationMoves: [
        { need: "BUSINESS_MODEL", objective: "понять готовность к модели" },
        { need: "GOAL", objective: "понять цель человека" },
      ],
      approvedFacts: [{
        id: approvedFact.id,
        category: approvedFact.category,
        answer: approvedFact.answer,
      }],
      economicsContext: buildApprovedEconomicsContext({
        city: "Москва",
        availableCapital: 400_000,
      }),
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({
        text: expect.stringContaining("130 000 ₽"),
        nextInformationNeed: "GOAL",
        conversationAction: "ANSWER",
      });
    expect(llm.callCount).toBe(2);
    expect(JSON.parse(llm.requests[1]!.userMessage).validationFeedback)
      .toContain("пропустил вопрос");
  });

  it("keeps a direct time question anchored to time instead of reviving startup costs", async () => {
    const partnerTime = PARTNER_KNOWLEDGE_BASE.find(
      (entry) => entry.id === "partner-time",
    )!;
    const startupCosts = PARTNER_KNOWLEDGE_BASE.find(
      (entry) => entry.id === "small-business-entry",
    )!;
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Запуск одного объекта в Москве стоит около 180 000 ₽. Готовы участвовать в запуске?",
        nextInformationNeed: "MANAGEMENT_READINESS",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Продолжить квалификацию.",
        answerCoverage: "FULL",
        usedKnowledgeEntryIds: [startupCosts.id],
      }),
      JSON.stringify({
        text: "На старте ориентир — около 3–4 часов в день: на просмотры, договоры и ключевые решения. Такой объём времени Вам подходит?",
        nextInformationNeed: "FREE_TIME",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Ответить про время и естественно уточнить доступность.",
        answerCoverage: "FULL",
        usedKnowledgeEntryIds: [partnerTime.id],
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: partnerTime.answer,
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [partnerTime.id],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentUserQuestions: ["А сколько времени на это надо?"],
      currentTurnRequiresAnswer: true,
      groundedAnswerRequired: true,
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["FREE_TIME", "MANAGEMENT_READINESS"],
      allowedQualificationMoves: [
        { need: "FREE_TIME", objective: "понять доступное для проекта время" },
        { need: "MANAGEMENT_READINESS", objective: "понять готовность участвовать в запуске" },
      ],
      approvedFacts: [partnerTime, startupCosts].map((entry) => ({
        id: entry.id,
        category: entry.category,
        answer: entry.answer,
      })),
    };

    await expect(generate({
      lead: { city: "Москва", availableCapital: 500_000 } as Lead,
      plan,
      recentMessages: [{
        direction: "OUTBOUND",
        content: "Готовы участвовать в запуске: ездить на просмотры, заключать договоры аренды и принимать ключевые решения?",
      }, {
        direction: "INBOUND",
        content: "А сколько времени на это надо?",
      }],
    })).resolves.toMatchObject({
      text: expect.stringContaining("3–4 часов в день"),
      nextInformationNeed: "FREE_TIME",
      conversationAction: "ANSWER",
    });
    expect(llm.callCount).toBe(2);
    expect(JSON.parse(llm.requests[0]!.userMessage)).toMatchObject({
      currentKnowledgeEntryIds: [partnerTime.id],
    });
    expect(JSON.parse(llm.requests[1]!.userMessage).validationFeedback)
      .toContain("пропустил вопрос");
  });

  it("treats a topical phrase as an answer to the previous qualification question", async () => {
    const text = "Понял, хотите зарабатывать на этом бизнесе, а точную цель пока не определили. Был ли у Вас опыт в недвижимости или посуточной аренде?";
    const llm = new FakeLLMProvider([JSON.stringify({
      text,
      nextInformationNeed: "EXPERIENCE",
      conversationAction: "ACKNOWLEDGE",
      qualificationMoveDecision: "ADVANCE",
      qualificationMoveRationale: "Признать ответ о мотивации и перейти к другой уместной теме.",
      answerCoverage: "FULL",
      usedKnowledgeEntryIds: [],
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Был ли у Вас опыт в недвижимости или посуточной аренде?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUALIFICATION_INFORMATION",
      previousQuestionResponse: "UNSURE",
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["EXPERIENCE", "FREE_TIME"],
      allowedQualificationMoves: [
        { need: "EXPERIENCE", objective: "понять релевантный опыт" },
        { need: "FREE_TIME", objective: "понять доступное для проекта время" },
      ],
      approvedFacts: PARTNER_KNOWLEDGE_BASE.map((entry) => ({
        id: entry.id,
        category: entry.category,
        answer: entry.answer,
      })),
    };

    await expect(generate({
      lead: { city: "Москва", availableCapital: 200_000 } as Lead,
      plan,
      recentMessages: [{
        direction: "OUTBOUND",
        content: "Какую главную цель хотите решить этим бизнесом?",
      }, {
        direction: "INBOUND",
        content: "Да я не знаю даже, деньги",
      }],
    })).resolves.toMatchObject({
      text,
      nextInformationNeed: "EXPERIENCE",
      conversationAction: "ACKNOWLEDGE",
    });
    const request = JSON.parse(llm.requests[0]!.userMessage);
    expect(request.currentKnowledgeEntryIds).toEqual([]);
    expect(request.economicsContext).toBeNull();
  });

  it("answers a semantic request even when no literal KB fragment matched", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        text: "Какую цель хотите решить этим бизнесом?",
        nextInformationNeed: "GOAL",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Продолжить квалификацию.",
      }),
      JSON.stringify({
        text: "Это бизнес по посуточной сдаче квартир. Команда помогает подобрать и запустить объект, а после запуска ведёт рекламу, бронирования и работу с гостями. С вашей стороны — участие в запуске и расходы по объекту. Какую цель хотите решить этим бизнесом?",
        nextInformationNeed: "GOAL",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Сначала объяснил суть бизнеса, затем продолжил квалификацию.",
        usedKnowledgeEntryIds: ["offer-overview", "launch-process"],
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const approvedFacts = PARTNER_KNOWLEDGE_BASE.map((entry) => ({
      id: entry.id,
      category: entry.category,
      answer: entry.answer,
    }));
    const plan: ConversationResponsePlan = {
      text: "Какую цель хотите решить этим бизнесом?",
      nextInformationNeed: null,
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "GENERAL_INTEREST",
      currentUserQuestions: [],
      currentTurnRequiresAnswer: true,
      groundedAnswerRequired: true,
      qualificationProgressExpected: true,
      allowedNextInformationNeeds: ["GOAL"],
      allowedQualificationMoves: [{
        need: "GOAL",
        objective: "понять цель человека",
      }],
      approvedFacts,
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({
        text: expect.stringContaining("бизнес по посуточной сдаче квартир"),
        nextInformationNeed: "GOAL",
        conversationAction: "ANSWER",
      });
    expect(llm.callCount).toBe(2);
    expect(JSON.parse(llm.requests[1]!.userMessage).validationFeedback)
      .toContain("пропустил вопрос");
  });

  it("allows a useful optional scheduling question after a post-handoff answer", async () => {
    const text = "Для запуска с вашей стороны нужны бюджет на расходы по объекту, участие в просмотрах и договорах, а также около 3–4 часов в день на ключевые решения. Объявления, бронирования, гостей и клининг ведёт команда. В какой день и примерно во сколько вам удобно принять звонок менеджера?";
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({
        text,
        nextInformationNeed: null,
        conversationAction: "ANSWER",
        qualificationMoveDecision: "NOT_APPLICABLE",
        qualificationMoveRationale: "Ответил на вопрос и необязательно уточнил время связи.",
        usedKnowledgeEntryIds: ["company-responsibilities", "partner-time"],
      })]),
    });
    const plan: ConversationResponsePlan = {
      text: "Понял, учту.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentUserQuestions: ["Что от меня требуется для запуска?"],
      currentTurnRequiresAnswer: true,
      groundedAnswerRequired: true,
      postHandoffContinuation: true,
      qualificationProgressExpected: false,
      approvedFacts: PARTNER_KNOWLEDGE_BASE.map((entry) => ({
        id: entry.id,
        category: entry.category,
        answer: entry.answer,
      })),
    };

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ text, nextInformationNeed: null });
  });

  it("repairs a repeated question and continues with a different qualification topic", async () => {
    const plan: ConversationResponsePlan = {
      text: "Вы правы: срок уже обсуждали. Продолжу с учётом ответа.",
      nextInformationNeed: null,
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "COMPLAINT",
      conversationRepairRequired: true,
      qualificationProgressExpected: true,
      deferredInformationNeeds: ["LAUNCH_TIMING"],
      allowedNextInformationNeeds: ["GOAL"],
      allowedQualificationMoves: [{
        need: "GOAL",
        objective: "понять цель человека",
      }],
    };
    const repaired = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({
        text: "Вы правы, срок вы уже назвали. Какую цель хотите решить этим бизнесом?",
        nextInformationNeed: "GOAL",
        conversationAction: "REPAIR",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Признал повтор и перешёл к другой полезной теме.",
      })]),
    });
    await expect(repaired({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ conversationAction: "REPAIR", nextInformationNeed: "GOAL" });

    const questionnaire = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({
        text: "Какую цель хотите решить этим бизнесом?",
        nextInformationNeed: "LAUNCH_TIMING",
        conversationAction: "REPAIR",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Попытался повторить прежний вопрос.",
      })]),
    });
    await expect(questionnaire({ lead: {} as Lead, plan, recentMessages: [] }))
      .rejects.toThrow("RESPONSE_POLICY_VIOLATION");
  });

  it("rejects informal address and accepts respectful Вы wording", async () => {
    const plan: ConversationResponsePlan = {
      text: "Когда планируете запуск?",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      allowedNextInformationNeeds: ["LAUNCH_TIMING"],
    };
    const generate = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([
        JSON.stringify({
          text: "Когда ты хотел бы начать?",
          nextInformationNeed: "LAUNCH_TIMING",
        }),
        JSON.stringify({
          text: "Когда Вы хотели бы начать?",
          nextInformationNeed: "LAUNCH_TIMING",
        }),
      ]),
    });

    await expect(generate({ lead: {} as Lead, plan, recentMessages: [] }))
      .resolves.toMatchObject({ text: "Когда Вы хотели бы начать?" });
  });

  it("passes covered topics and semantic move objectives without question templates", async () => {
    const llm = new FakeLLMProvider([JSON.stringify({
      text: "Понял.",
      nextInformationNeed: null,
      conversationAction: "ACKNOWLEDGE",
    })]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Какой бюджет готовы выделить?",
      nextInformationNeed: "AVAILABLE_CAPITAL",
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "CONFIRMATION",
      previouslyExplainedKnowledgeEntryIds: ["small-business-entry"],
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL"],
      allowedQualificationMoves: [{
        need: "AVAILABLE_CAPITAL",
        objective: "понять общий бюджет запуска",
      }],
    };

    await generate({ lead: {} as Lead, plan, recentMessages: [] });
    const context = JSON.parse(llm.requests[0]!.userMessage) as {
      allowedQualificationMoves: Array<{ need: string; objective: string }>;
      previouslyExplainedKnowledgeEntryIds: string[];
      currentUserIntent: string;
      allowedNextQuestions?: unknown;
    };
    expect(context).toMatchObject({
      currentUserIntent: "CONFIRMATION",
      previouslyExplainedKnowledgeEntryIds: ["small-business-entry"],
    });
    expect(context.allowedQualificationMoves).toEqual([{
      need: "AVAILABLE_CAPITAL",
      objective: "понять общий бюджет запуска",
    }]);
    expect(context.allowedNextQuestions).toBeUndefined();
  });

  it("regenerates instead of repeating a recently explained knowledge topic", async () => {
    const repeated = "Команда помогает с поиском и запуском объектов, объявлениями, бронированиями, дистанционным заселением, гостями, клинингом, календарями и координацией персонала. Расходы по бизнесу несёт партнёр как владелец своего бизнеса. Какой бюджет готовы выделить?";
    const corrected = "Москва, понял. Какой бюджет в целом Вы готовы выделить на запуск?";
    const llm = new FakeLLMProvider([
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: repeated,
        nextInformationNeed: "AVAILABLE_CAPITAL",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "нужен следующий факт",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: ["company-responsibilities"],
      }),
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: corrected,
        nextInformationNeed: "AVAILABLE_CAPITAL",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "город уже принят, продолжаем без повтора",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: [],
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Какой бюджет в целом Вы готовы выделить на запуск?",
      nextInformationNeed: "AVAILABLE_CAPITAL",
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUALIFICATION_INFORMATION",
      currentTurnRequiresAnswer: false,
      previouslyExplainedKnowledgeEntryIds: ["company-responsibilities"],
      allowedNextInformationNeeds: ["AVAILABLE_CAPITAL"],
      allowedQualificationMoves: [{
        need: "AVAILABLE_CAPITAL",
        objective: "понять доступный капитал на запуск",
      }],
      approvedFacts: [{
        id: "company-responsibilities",
        category: "RESPONSIBILITIES",
        answer: "Команда помогает с запуском и операционной работой.",
      }],
    };

    await expect(generate({
      lead: { city: "Москва" } as Lead,
      plan,
      recentMessages: [{
        direction: "OUTBOUND",
        content: "Команда помогает с поиском и запуском объектов, объявлениями, бронированиями, дистанционным заселением, гостями, клинингом, календарями и координацией персонала. Расходы по бизнесу несёт партнёр как владелец своего бизнеса. В каком городе Вы планируете запускать объекты?",
      }],
    })).resolves.toMatchObject({ text: corrected });
    expect(llm.callCount).toBe(2);
    expect(JSON.parse(llm.requests[1]!.userMessage)).toMatchObject({
      validationFeedback: expect.stringContaining("существенно повторяет недавний ответ"),
    });
  });

  it("regenerates a contextual answer instead of replaying stale economics", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: "Ранее мы уже обсудили ориентир запуска одного объекта — 180 000 ₽. Какую цель вы хотите решить этим бизнесом?",
        nextInformationNeed: "GOAL",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "нужно понять цель партнёра",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: ["small-business-entry"],
      }),
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: "Поэтому я сначала уточняю вашу цель: от неё зависит, на чём лучше сосредоточиться дальше. Какую цель вы хотите решить этим бизнесом?",
        nextInformationNeed: "GOAL",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "нужно понять цель партнёра",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: [],
      }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });
    const plan: ConversationResponsePlan = {
      text: "Какую главную цель хотите решить этим бизнесом?",
      nextInformationNeed: "GOAL",
      asksUserQuestion: true,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: true,
      currentUserIntent: "QUESTION",
      currentUserQuestions: ["А это важно?"],
      currentQuestionKind: "CONVERSATION_META",
      currentTurnRequiresAnswer: true,
      contextualReference: false,
      previouslyExplainedKnowledgeEntryIds: ["small-business-entry", "guarantees-and-economics"],
      economicsContext: buildApprovedEconomicsContext({
        availableCapital: 300_000,
        city: "Москва",
        requestedUnits: 1,
      }),
      allowedNextInformationNeeds: ["GOAL"],
      allowedQualificationMoves: [{
        need: "GOAL",
        objective: "понять цель и мотивацию человека",
      }],
      approvedFacts: PARTNER_KNOWLEDGE_BASE.map(({ id, category, answer }) => ({ id, category, answer })),
    };

    await expect(generate({
      lead: { city: "Москва", availableCapital: 300_000 } as Lead,
      plan,
      recentMessages: [
        { direction: "OUTBOUND", content: "По этому ориентиру запуск одного объекта — 180 000 ₽." },
        { direction: "INBOUND", content: "Хорошо, у меня есть 300 000, я рассматриваю в ближайшую неделю" },
        { direction: "OUTBOUND", content: "Какую главную цель хотите решить этим бизнесом?" },
      ],
    })).resolves.toMatchObject({ nextInformationNeed: "GOAL" });
    expect(llm.callCount).toBe(2);
    expect(JSON.parse(llm.requests[1]!.userMessage)).toMatchObject({
      validationFeedback: expect.stringContaining("смыслу шага разговора"),
    });
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

  it("does not ask for callback time again after the preference was captured", async () => {
    const repeated = "Менеджер свяжется с вами. В какой день и время вам удобно принять звонок?";
    const confirmation = "Спасибо, зафиксировал: завтра в 10 утра по Москве. Менеджер свяжется с вами в это время.";
    const llm = new FakeLLMProvider([
      JSON.stringify({ text: repeated }),
      JSON.stringify({ text: confirmation }),
    ]);
    const generate = createNaturalResponseGenerator({ llmProvider: llm });

    await expect(generate({
      lead: {} as Lead,
      plan: {
        text: confirmation,
        nextInformationNeed: null,
        asksUserQuestion: false,
        knowledgeEntryIds: [],
        unresolvedQuestions: [],
        useNaturalAdaptation: true,
        postHandoffContinuation: true,
        preferredContactTime: "завтра в 10 утра по Москве",
        callbackPreferenceCaptured: true,
      },
      recentMessages: [
        { direction: "OUTBOUND", content: "Напишите, когда вам удобно принять звонок менеджера." },
        { direction: "INBOUND", content: "Завтра в 10 утра по Москве" },
      ],
    })).resolves.toMatchObject({ text: confirmation });
    expect(JSON.parse(llm.requests[1]!.userMessage).validationFeedback)
      .toContain("уже назвал preferredContactTime");
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
