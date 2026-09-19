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
