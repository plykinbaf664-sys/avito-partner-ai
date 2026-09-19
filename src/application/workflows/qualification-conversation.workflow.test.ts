import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtractedMessage } from "@/domain/extraction/extracted-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";

import { createMessageExtractor } from "../extraction/extract-message";
import { createIncomingEventProcessor } from "./process-incoming-event";
import { createNaturalResponseGenerator } from "../conversation/generate-natural-response";
import { createCrmService } from "../crm/crm-service";
import { createCrmCsv } from "../crm/csv-export";
import { qualificationLabel, handoffLabel, notificationLabel } from "@/app/crm/crm-format";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";

function reply({
  intent = "QUALIFICATION_INFORMATION",
  facts = {},
  signals = {},
}: {
  intent?: ExtractedMessage["intent"];
  facts?: Partial<ExtractedMessage["facts"]>;
  signals?: Partial<ExtractedMessage["signals"]>;
} = {}) {
  return JSON.stringify({
    intent,
    facts: {
      phoneNumber: "",
      phoneConfirmed: false,
      city: null,
      budget: null,
      budgetConfirmed: false,
      availableCapital: -1,
      availableCapitalConfirmed: false,
      entryBudget: -1,
      additionalLaunchCapital: -1,
      capitalScope: "UNKNOWN",
      additionalExpensesReadiness: "UNKNOWN",
      businessModelReadiness: "UNKNOWN",
      calculationUnits: -1,
      startingUnits: null,
      scalingPotentialUnits: null,
      hasFreeTime: null,
      availableTimeDetails: null,
      businessExperience: null,
      shortTermRentalExperience: null,
      ownsProperty: null,
      desiredIncome: null,
      primaryGoal: "UNKNOWN",
      launchTiming: null,
      managementReadiness: null,
      requiresGuaranteedIncome: null,
      rejectsBusinessModel: null,
      ...facts,
    },
    signals: {
      questions: [],
      objections: [],
      possiblePrimaryFear: null,
      possibleSecondaryFear: null,
      wantsHuman: false,
      ...signals,
    },
    confidence: 0.98,
    uncertainty: [],
  });
}

describe("multi-turn qualification conversation", () => {
  let persistence: SqlitePersistence;
  let nextId: number;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated(
      "file::memory:",
      resolve(process.cwd(), "drizzle"),
    );
    nextId = 0;
  });
  afterEach(() => persistence.close());

  function harness(replies: string[]) {
    const llm = new FakeLLMProvider(replies);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      generateId: () => `conversation-test-${++nextId}`,
      now: () => new Date(`2026-09-01T10:${String(nextId).padStart(2, "0")}:00Z`),
    });
    return { llm, processEvent };
  }

  const input = (id: number, text: string) => ({
    source: "conversation-test",
    externalEventId: `event-${id}`,
    externalLeadId: "lead-1",
    messageId: `message-${id}`,
    text,
  });

  it("starts a general-interest conversation with discovery instead of capital", async () => {
    const { processEvent } = harness([
      reply({ intent: "GENERAL_INTEREST" }),
    ]);

    const result = await processEvent(input(0, "Здравствуйте, мне интересно"));

    expect(result.suggestedNextInformationNeed).toBe("CITY");
    expect(result.outboundMessage).toBeTruthy();
    expect(result.outboundMessage).not.toMatch(/какую сумму|капитал|бюджет/iu);
    expect(result.outboundMessage).toContain("?");
    expect((await persistence.conversations.findById(result.conversationId!))?.pendingInformationNeed)
      .toBe("CITY");
  });

  it("lets Claude answer a paraphrased approved business question without a literal KB match", async () => {
    const extractMessage = createMessageExtractor({
      llmProvider: new FakeLLMProvider([reply({
        intent: "QUESTION",
        signals: { questions: ["Бухгалтерию самому вести?"] },
      })]),
    });
    const generateNaturalResponse = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([JSON.stringify({
        text: "Нет, компания предоставляет бухгалтерское сопровождение. Со стороны партнёра остаётся участие в запуске и необходимые договоры. Какую сумму вы готовы выделить на запуск — это общий доступный капитал или только первый этап?",
        answerCoverage: "FULL",
        nextInformationNeed: "AVAILABLE_CAPITAL",
      })]),
    });
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage,
      generateNaturalResponse,
      generateId: () => `semantic-${++nextId}`,
      now: () => new Date(`2026-09-01T10:${String(nextId).padStart(2, "0")}:00Z`),
    });

    const result = await processEvent(input(0, "Бухгалтерию самому вести?"));

    expect(result.outboundMessage).toContain("бухгалтерское сопровождение");
    expect(result.outboundMessage).not.toContain("уточнить у менеджера");
    expect(result.qualificationReason).not.toBe("UNKNOWN_BUSINESS_QUESTION");
  });

  it.each([
    ["Какие условия предлагаете?", ["субаренде", "50 000 ₽", "80 000 ₽", "доход не гарантируется"]],
    ["Как вообще проходит организация бизнеса?", ["подобрать объект", "комплектации", "площадках", "администратор", "горничную", "персональный менеджер", "CRM"]],
    ["Кто занимается гостями?", ["администратор", "гостями"]],
    ["Сколько нужно денег?", ["50 000 ₽", "аренду", "залог", "30 000 ₽", "150 000 ₽", "180 000 ₽"]],
    ["Сколько заработаю?", ["около 20 000 ₽", "Гарантированного дохода нет"]],
    ["Что вообще предлагает компания?", ["субаренде", "команда помогает"]],
    ["Как устроена схема работы?", ["подобрать", "бронирования"]],
    ["Что делает управляющая компания?", ["поиском и запуском", "Расходы"]],
    ["Что делает партнёр?", ["Расходы по бизнесу несёт партнёр"]],
    ["Какие расходы несёт партнёр?", ["аренду", "залог", "подготовку объекта"]],
    ["Что входит в первый этап?", ["50 000 ₽", "помощи в запуске"]],
    ["Какая стоимость первого этапа?", ["50 000 ₽", "30 000 ₽"]],
    ["Кто должен оплатить аренду и залог?", ["Отдельно партнёр оплачивает"]],
    ["Какой ориентир по стартовому бюджету?", ["150 000 ₽", "180 000 ₽"]],
    ["Аренда, залог и комплектация входят?", ["Отдельно партнёр оплачивает"]],
    ["Есть ли гарантии?", ["Гарантированного дохода нет"]],
    ["Кто координирует горничных?", ["администратор", "координирует горничную"]],
    ["Что происходит после запуска?", ["персональный менеджер", "CRM"]],
    ["Как работает CRM?", ["онлайн-режиме", "брони", "площадок"]],
    ["Как партнёр видит брони?", ["CRM", "онлайн-режиме"]],
    ["Можно ли начать с одного объекта?", ["начать можно с одного объекта", "3–5 объектов"]],
    ["Как инвестору смотреть брони?", ["CRM", "онлайн-режиме"]],
    ["Кто будет заниматься гостями моей квартиры?", ["администратор"]],
  ])("answers the approved KB question without a deterministic qualification prompt: %s", async (question, fragments) => {
    const { processEvent } = harness([
      reply({ intent: "QUESTION", signals: { questions: [question] } }),
    ]);
    const result = await processEvent(input(1, question));
    for (const fragment of fragments) expect(result.outboundMessage?.toLocaleLowerCase("ru")).toContain(fragment.toLocaleLowerCase("ru"));
    expect(result.shouldHandoffToManager).toBe(false);
    expect(result.outboundMessage).not.toContain("уточнить у менеджера");
    expect(result.outboundMessage).not.toContain("Передам менеджеру");
    expect(result.outboundMessage!.length).toBeLessThanOrEqual(1_000);
    expect(result.outboundMessage).toBeTruthy();
  });

  it("answers a question without repeating a known budget or forcing the next gap", async () => {
    const { processEvent } = harness([reply({ intent: "QUESTION",
      facts: { availableCapital: 200_000, availableCapitalConfirmed: true },
      signals: { questions: ["Кто занимается гостями?"] } })]);
    const result = await processEvent(input(1, "У меня 200 тысяч. Кто занимается гостями?"));
    expect(result.outboundMessage).toContain("администратор");
    expect(result.shouldHandoffToManager).toBe(false);
    expect(result.suggestedNextInformationNeed).not.toBe("AVAILABLE_CAPITAL");
    expect(result.outboundMessage).not.toContain("Какую сумму");
    expect(result.outboundMessage).toBeTruthy();
  });

  it("answers Moscow availability and service payment before continuing qualification", async () => {
    const question = "В Москве можно по такой схеме работать? Ваши услуги как оплачиваются?";
    const { processEvent } = harness([reply({ intent: "QUESTION",
      signals: { questions: [question] } })]);
    const result = await processEvent(input(1, question));
    expect(result.outboundMessage).toContain("Подтверждённые города");
    expect(result.outboundMessage).toContain("50 000 ₽");
    expect(result.outboundMessage).toContain("юридическое сопровождение");
    expect(result.outboundMessage).not.toContain("Оставьте, пожалуйста, номер");
    expect(result.shouldHandoffToManager).toBe(false);
  });

  it.each([
    ["Кто занимается гостями и какая страховая компания покроет ущерб?", "администратор", "какая страховая компания покроет ущерб"],
    ["Как работает CRM и есть ли API?", "онлайн-режиме", "есть ли API"],
    ["Чем отличается малый бизнес от инвесторского сценария?", "бизнес на субаренде", "инвесторского сценария"],
    ["Сколько заработаю на моей квартире по адресу Ленина, 10?", "20 000 ₽", "моей квартире"],
    ["Какие условия предлагаете и можно ли оплатить в рассрочку?", "80 000 ₽", "можно ли оплатить в рассрочку"],
  ])("answers the known part before escalating the specific gap: %s", async (question, known, unknown) => {
    const { processEvent } = harness([reply({ intent: "QUESTION", facts: { phoneNumber: "+79991234567", phoneConfirmed: true }, signals: { questions: [question] } })]);
    const result = await processEvent(input(1, question));
    expect(result.shouldHandoffToManager).toBe(false);
    expect(result.qualificationReason).toBe("UNKNOWN_BUSINESS_QUESTION");
    expect(result.outboundMessage).toContain(known);
    expect(result.outboundMessage).toContain(unknown);
    expect(result.outboundMessage!.indexOf(known)).toBeLessThan(result.outboundMessage!.indexOf("эту часть лучше уточнить"));
  });

  it("still honors an explicit human request even when the KB answers the question", async () => {
    const { processEvent } = harness([reply({ intent: "QUESTION",
      facts: { phoneNumber: "+79991234567", phoneConfirmed: true },
      signals: { questions: ["Кто занимается гостями?"], wantsHuman: true } })]);
    const result = await processEvent(input(1, "Кто занимается гостями? Хочу поговорить с человеком."));
    expect(result.outboundMessage).toContain("администратор");
    expect(result.shouldHandoffToManager).toBe(false);
    expect(result.qualificationReason).toBe("USER_REQUESTED_HUMAN");
  });

  it("answers from the KB and preserves handoff for an already ready lead", async () => {
    const { processEvent } = harness([reply({ intent: "QUESTION",
      facts: { city: "Химки", phoneNumber: "+79991234567", phoneConfirmed: true,
        availableCapital: 200_000, availableCapitalConfirmed: true,
        startingUnits: 1, launchTiming: "READY_NOW", primaryGoal: "ADDITIONAL_INCOME",
        businessModelReadiness: "ACCEPTS", managementReadiness: "READY" },
      signals: { questions: ["Кто занимается гостями?"] } })]);
    const result = await processEvent(input(1, "Готов начать. Кто занимается гостями?"));
    expect(result.outboundMessage).toContain("администратор");
    expect(result.shouldHandoffToManager).toBe(true);
    expect(result.qualificationReason).toBe("SMALL_BUSINESS_READY");
    expect(result.outboundMessage).not.toContain("Какую сумму");
  });

  it("adapts even a single known answer through the LLM and persists the resulting reply", async () => {
    const adapted = "Гостей ведёт администратор, он же координирует горничную. В каком городе хотите запускаться?";
    const llm = new FakeLLMProvider([JSON.stringify({
      text: adapted,
      nextInformationNeed: "CITY",
    })]);
    const extractMessage = createMessageExtractor({ llmProvider: new FakeLLMProvider([
      reply({ intent: "QUESTION", signals: { questions: ["Кто занимается гостями?"] } }),
    ]) });
    const generate = vi.fn(createNaturalResponseGenerator({ llmProvider: llm }));
    const processEvent = createIncomingEventProcessor({ persistence, extractMessage, generateNaturalResponse: generate });
    const result = await processEvent(input(1, "Кто занимается гостями?"));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].plan.knowledgeEntryIds).toContain("operations-guests");
    expect(result.outboundMessage).toBe(adapted);
    expect(result.shouldHandoffToManager).toBe(false);
    const messages = await persistence.messages.listByConversationId(result.conversationId!);
    expect(messages.find((message) => message.direction === "OUTBOUND")?.content).toBe(adapted);
  });

  it("persists the LLM-selected step only when it is an allowed missing fact", async () => {
    const extractMessage = createMessageExtractor({ llmProvider: new FakeLLMProvider([
      reply({ facts: { availableCapital: 300_000, availableCapitalConfirmed: true } }),
    ]) });
    const generateNaturalResponse = createNaturalResponseGenerator({
      llmProvider: new FakeLLMProvider([
        JSON.stringify({
          text: "Понял. Когда примерно хотите запустить первый объект?",
          nextInformationNeed: "LAUNCH_TIMING",
        }),
      ]),
    });
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage,
      generateNaturalResponse,
    });

    const result = await processEvent(input(1, "300 для начала"));
    const conversation = await persistence.conversations.findById(result.conversationId!);

    expect(result.outboundMessage).toBe("Понял. Когда примерно хотите запустить первый объект?");
    expect(conversation?.pendingInformationNeed).toBe("LAUNCH_TIMING");
    expect(result.outboundMessage).not.toMatch(/общий доступный капитал|отдельный бюджет/iu);
  });

  it.each(["unavailable", "unsafe"])("keeps the KB answer without deterministic questioning when adaptation is %s", async (failure) => {
    const extractMessage = createMessageExtractor({ llmProvider: new FakeLLMProvider([
      reply({ intent: "QUESTION", signals: { questions: ["Какие условия предлагаете?"] } }),
    ]) });
    const generateNaturalResponse = failure === "unsafe"
      ? createNaturalResponseGenerator({ llmProvider: new FakeLLMProvider([
        JSON.stringify({ text: "Услуга — 50 000 ₽, а остальные расходы лучше уточнить у менеджера." }),
      ]) })
      : async () => { throw new Error("LLM_UNAVAILABLE"); };
    const processEvent = createIncomingEventProcessor({ persistence, extractMessage, generateNaturalResponse });
    const result = await processEvent(input(1, "Какие условия предлагаете?"));
    expect(result.shouldHandoffToManager).toBe(false);
    expect(result.outboundMessage).toContain("субаренде");
    expect(result.outboundMessage).toContain("80 000 ₽");
    expect(result.outboundMessage).not.toContain("уточнить у менеджера");
  });

  it("moves a strong investor directly to PRIORITY and prepares a manager summary", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Волгоград",
          phoneNumber: "+7 999 123-45-67",
          phoneConfirmed: true,
          availableCapital: 2_000_000,
          availableCapitalConfirmed: true,
          capitalScope: "TOTAL_LIMIT",
          startingUnits: 8,
          scalingPotentialUnits: 10,
          launchTiming: "READY_NOW",
          primaryGoal: "INVESTMENT",
          managementReadiness: "READY",
        },
      }),
    ]);

    const result = await processEvent(input(1, "Есть 2 миллиона, хочу зайти примерно в 10 квартир, готов начать сейчас. Мой номер +7 999 123-45-67"));

    expect(result).toMatchObject({
      qualificationStatus: "PRIORITY",
      conversationState: "QUALIFIED",
      shouldHandoffToManager: true,
      suggestedNextInformationNeed: null,
      managerSummary: {
        city: "Волгоград",
        segment: "INVESTOR",
        availableCapital: 2_000_000,
        startingUnits: 8,
        scalingPotentialUnits: 10,
        estimatedMonthlyPartnerIncome: 200_000,
        incomeEstimateGuaranteed: false,
        qualificationStatus: "PRIORITY",
      },
    });
    expect(result.outboundMessage).toContain("Спасибо, передал номер менеджеру");
    expect((await persistence.conversations.findById(result.conversationId!))?.qualificationCompleted).toBe(true);
  });

  it("asks for a phone at handoff and completes handoff after receiving it", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Химки",
          availableCapital: 160_000,
          availableCapitalConfirmed: true,
          entryBudget: 50_000,
          additionalLaunchCapital: 110_000,
          capitalScope: "ADDITIONAL_AVAILABLE",
          additionalExpensesReadiness: "READY",
          businessModelReadiness: "ACCEPTS",
          startingUnits: 1,
          scalingPotentialUnits: 3,
          hasFreeTime: true,
          launchTiming: "WITHIN_MONTH",
          primaryGoal: "ADDITIONAL_INCOME",
          managementReadiness: "READY",
        },
      }),
      reply({
        facts: {
          phoneNumber: "8 (999) 123-45-67",
          phoneConfirmed: true,
        },
      }),
    ]);

    const beforePhone = await processEvent(
      input(1, "Хочу запустить один объект в Химках через месяц, на запуск есть 160 тысяч"),
    );
    expect(beforePhone).toMatchObject({
      qualificationStatus: "HOT",
      shouldHandoffToManager: false,
      suggestedNextInformationNeed: "PHONE_NUMBER",
      conversationState: "WAITING_PHONE",
    });
    expect(beforePhone.outboundMessage).toBeTruthy();
    expect(await persistence.managerNotifications.findByIdempotencyKey(`manager-handoff:${beforePhone.leadId}`)).toBeNull();
    expect((await persistence.leads.findById(beforePhone.leadId!))?.handoffAt).toBeNull();
    const crm = createCrmService(persistence);
    const waiting = (await crm.getLead(beforePhone.leadId!))!;
    expect([qualificationLabel(waiting), handoffLabel(waiting), notificationLabel(waiting)])
      .toEqual(["Квалифицирован", "Ожидает телефон", "Не отправлялось"]);
    expect(waiting.phoneNumber ?? "").toBe("");

    const afterPhone = await processEvent(input(2, "Позвоните 89991234567"));
    expect(afterPhone).toMatchObject({
      shouldHandoffToManager: true,
      qualificationStatus: "HOT",
      managerSummary: { phoneNumber: "+79991234567" },
    });
    expect(await persistence.managerNotifications.findByIdempotencyKey(`manager-handoff:${afterPhone.leadId}`))
      .toMatchObject({ deliveryStatus: "PENDING", summary: { phoneNumber: "+79991234567" } });
    expect(afterPhone.outboundMessage ?? "").not.toContain("Оставьте");
    expect((await persistence.leads.findById(afterPhone.leadId!))?.phoneNumber).toBe("+79991234567");
    const handed = (await crm.getLead(afterPhone.leadId!))!;
    expect([qualificationLabel(handed), handoffLabel(handed), notificationLabel(handed)])
      .toEqual(["Горячий", "Передан менеджеру", "Ожидает отправки"]);
    expect((await crm.listLeads({ search: "8 (999) 123-45-67" })).records.map((record) => record.leadId)).toEqual([afterPhone.leadId]);
    expect(createCrmCsv(await crm.exportLeads())).toContain('"+79991234567"');
    expect((await processEvent(input(2, "Позвоните 89991234567"))).duplicate).toBe(true);
  });

  it("answers an economics scenario from approved calculations without a manager fallback", async () => {
    const { processEvent } = harness([reply({
      intent: "QUESTION",
      facts: { availableCapital: 250_000, availableCapitalConfirmed: true },
      signals: { questions: ["У меня 250 тысяч. Со скольких объектов посоветуете начать?"] },
    })]);
    const result = await processEvent(input(1, "У меня 250 тысяч. Со скольких объектов посоветуете начать?"));

    expect(result.outboundMessage).toContain("Региональный ориентир");
    expect(result.outboundMessage).toContain("около 2 объектов");
    expect(result.outboundMessage).toContain("Москва");
    expect(result.outboundMessage).not.toContain("уточнить у менеджера");
    expect(result.shouldHandoffToManager).toBe(false);
  });

  it("answers approved income arithmetic for two objects without escalation", async () => {
    const { processEvent } = harness([reply({
      intent: "QUESTION",
      facts: { calculationUnits: 2 },
      signals: { questions: ["А сколько примерно можно получать с двух объектов?"] },
    })]);
    const result = await processEvent(input(1, "А сколько примерно можно получать с двух объектов?"));

    expect(result.outboundMessage).toContain("40 000 ₽");
    expect(result.outboundMessage).toContain("не гарантия");
    expect(result.outboundMessage).not.toContain("уточнить у менеджера");
    expect(result.shouldHandoffToManager).toBe(false);
  });

  it("keeps the conversation available after handoff for new facts and questions", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Химки",
          availableCapital: 200_000,
          availableCapitalConfirmed: true,
          additionalExpensesReadiness: "READY",
          businessModelReadiness: "ACCEPTS",
          startingUnits: 1,
          scalingPotentialUnits: 3,
          hasFreeTime: true,
          launchTiming: "READY_NOW",
          primaryGoal: "ADDITIONAL_INCOME",
          managementReadiness: "READY",
        },
      }),
      reply({ facts: { phoneNumber: "+79991234567", phoneConfirmed: true } }),
      reply({ facts: { city: "Москва" } }),
    ]);

    const beforePhone = await processEvent(input(10, "Готов начать в Химках, есть 200 тысяч"));
    const afterPhone = await processEvent(input(11, "+79991234567"));
    expect(afterPhone.shouldHandoffToManager).toBe(true);
    const handoffNotification = await persistence.managerNotifications.findByIdempotencyKey(
      `manager-handoff:${beforePhone.leadId}`,
    );

    const afterHandoff = await processEvent(input(12, "Я вообще-то из Москвы"));
    const lead = await persistence.leads.findById(afterHandoff.leadId!);
    expect(lead?.city).toBe("Москва");
    expect(afterHandoff.outboundMessage).toContain("Понял");
    expect(afterHandoff.outboundMessage).not.toContain("Оставьте");
    const afterHandoffNotification = await persistence.managerNotifications.findByIdempotencyKey(
      `manager-handoff:${beforePhone.leadId}`,
    );
    expect(afterHandoffNotification?.id).toBe(handoffNotification?.id);
  });

  it("answers an economics question after handoff without creating another handoff", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Химки",
          availableCapital: 200_000,
          availableCapitalConfirmed: true,
          additionalExpensesReadiness: "READY",
          businessModelReadiness: "ACCEPTS",
          startingUnits: 1,
          scalingPotentialUnits: 3,
          launchTiming: "READY_NOW",
          primaryGoal: "ADDITIONAL_INCOME",
          managementReadiness: "READY",
        },
      }),
      reply({ facts: { phoneNumber: "+79991234567", phoneConfirmed: true } }),
      reply({
        intent: "QUESTION",
        facts: { calculationUnits: 3 },
        signals: { questions: ["А сколько примерно можно зарабатывать с трёх квартир?"] },
      }),
    ]);

    const first = await processEvent(input(20, "Готов начать в Химках, есть 200 тысяч"));
    await processEvent(input(21, "+79991234567"));
    const answer = await processEvent(input(22, "А сколько примерно можно зарабатывать с трёх квартир?"));

    expect(answer.outboundMessage).toContain("60 000 ₽");
    expect(answer.outboundMessage).not.toContain("Передам менеджеру");
    expect((await persistence.managerNotifications.findByIdempotencyKey(`manager-handoff:${first.leadId}`))?.id)
      .toBeDefined();
  });

  it("keeps a phone refusal as a barrier and answers KB questions while waiting", async () => {
    const { processEvent } = harness([
      reply({ facts: { city: "Химки", availableCapital: 180_000, availableCapitalConfirmed: true,
        additionalExpensesReadiness: "READY",
        startingUnits: 1, scalingPotentialUnits: 3, hasFreeTime: true,
        businessModelReadiness: "ACCEPTS", launchTiming: "READY_NOW",
        managementReadiness: "READY", primaryGoal: "ADDITIONAL_INCOME" } }),
      reply({ intent: "OBJECTION", signals: { objections: ["Телефон пока давать не хочу"] } }),
      reply({ intent: "QUESTION", signals: { questions: ["Кто занимается гостями?"] } }),
    ]);
    const first = await processEvent(input(1, "180 тысяч, Химки, хочу запуск малого бизнеса с одного объекта"));
    expect(first).toMatchObject({ segment: "SMALL_BUSINESS", qualificationStatus: "PRIORITY", shouldHandoffToManager: false });
    const refused = await processEvent(input(2, "Телефон пока давать не хочу"));
    expect(refused).toMatchObject({ qualificationStatus: "PRIORITY", suggestedNextInformationNeed: "PHONE_NUMBER", shouldHandoffToManager: false });
    expect(await persistence.leads.findById(first.leadId!)).toMatchObject({ phoneNumber: null,
      objections: ["Телефон пока давать не хочу"], handoffAt: null });
    const answer = await processEvent(input(3, "Кто занимается гостями?"));
    expect(answer.outboundMessage).toContain("администратор");
    expect(answer.outboundMessage).not.toContain("Оставьте");
    expect(answer.shouldHandoffToManager).toBe(false);
    expect(await persistence.managerNotifications.findByIdempotencyKey(`manager-handoff:${first.leadId}`)).toBeNull();
  });

  it("resumes an old premature handoff and refreshes its untouched summary after the phone", async () => {
    const { processEvent } = harness([
      reply({ facts: { city: "Химки", availableCapital: 180_000, availableCapitalConfirmed: true,
        additionalExpensesReadiness: "READY",
        startingUnits: 1, scalingPotentialUnits: 3, hasFreeTime: true,
        businessModelReadiness: "ACCEPTS", launchTiming: "READY_NOW",
        managementReadiness: "READY", primaryGoal: "ADDITIONAL_INCOME" } }),
      reply({ intent: "QUESTION", signals: { questions: ["Кто занимается гостями?"] } }),
      reply({ facts: { phoneNumber: "+79991234567", phoneConfirmed: true } }),
    ]);
    const first = await processEvent(input(1, "Хочу начать"));
    const lead = (await persistence.leads.findById(first.leadId!))!;
    const conversation = (await persistence.conversations.findById(first.conversationId!))!;
    const oldTime = lead.updatedAt;
    await persistence.leads.update({ ...lead, qualificationStatus: "HANDOFF", qualificationReason: "USER_REQUESTED_HUMAN", handoffAt: oldTime });
    await persistence.conversations.update({ ...conversation, state: "HANDOFF", qualificationCompleted: true });
    await persistence.managerNotifications.insertIfAbsent({ id: "legacy-notification", leadId: lead.id,
      conversationId: conversation.id, qualificationStatus: "HANDOFF", summary: { phoneNumber: null } as ManagerSummary,
      idempotencyKey: `manager-handoff:${lead.id}`, deliveryStatus: "PENDING", deliveryAttempts: 0,
      deliveryRetryable: null, lastDeliveryErrorCode: null, externalNotificationId: null,
      createdAt: oldTime, updatedAt: oldTime, sentAt: null });
    const resumed = await processEvent(input(2, "Кто занимается гостями?"));
    expect(resumed).toMatchObject({ qualificationStatus: "PRIORITY", conversationState: "QUALIFYING", shouldHandoffToManager: false });
    expect(resumed.outboundMessage).toContain("администратор");
    expect(resumed.outboundMessage).toBeTruthy();
    const completed = await processEvent(input(3, "+79991234567"));
    expect(completed.shouldHandoffToManager).toBe(true);
    expect(await persistence.managerNotifications.findByIdempotencyKey(`manager-handoff:${lead.id}`))
      .toMatchObject({ id: "legacy-notification", summary: { phoneNumber: "+79991234567" }, deliveryAttempts: 0 });
    expect((await persistence.leads.findById(lead.id))?.handoffAt).toEqual(oldTime);
  });

  it("does not reject a qualified lead who has not shared a phone", async () => {
    const { processEvent } = harness([
      reply({
        intent: "OBJECTION",
        signals: { objections: ["Телефон пока давать не хочу"] },
      }),
    ]);
    const result = await processEvent(input(1, "Телефон пока давать не хочу"));
    expect(result.qualificationStatus).not.toBe("NO_FIT");
  });

  it("keeps the latest explicitly changed budget, city, and phone", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Подольск",
          availableCapital: 120_000,
          availableCapitalConfirmed: true,
          phoneNumber: "+79991234567",
          phoneConfirmed: true,
        },
      }),
      reply({
        facts: {
          city: "Химки",
          availableCapital: 200_000,
          availableCapitalConfirmed: true,
          phoneNumber: "+79997654321",
          phoneConfirmed: true,
        },
      }),
    ]);
    const first = await processEvent(
      input(1, "Я из Подольска, на запуск есть 120 тысяч, номер +79991234567"),
    );
    await processEvent(
      input(2, "Уточню: теперь я в Химках, могу выделить 200 тысяч, номер +79997654321"),
    );
    const lead = await persistence.leads.findById(first.leadId!);
    expect(lead).toMatchObject({
      city: "Химки",
      availableCapital: 200_000,
      phoneNumber: "+79997654321",
    });
  });

  it("answers that owned property is not required and continues qualification", async () => {
    const question = "Своей квартиры нет, это проблема?";
    const { processEvent } = harness([
      reply({
        intent: "QUESTION",
        facts: { ownsProperty: false },
        signals: { questions: [question], possiblePrimaryFear: "FEAR_NO_PROPERTY" },
      }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result.outboundMessage).toContain("Собственная квартира не обязательна");
    expect(result.qualificationStatus).not.toBe("NO_FIT");
  });

  it("treats a general fit question as qualification context, not an unknown handoff", async () => {
    const question = "Подойдёт ли мне этот бизнес?";
    const { processEvent } = harness([
      reply({ intent: "QUESTION", signals: { questions: [question] } }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result.qualificationStatus).toBe("NEEDS_MORE_INFO");
    expect(result.shouldHandoffToManager).toBe(false);
    expect(result.outboundMessage).toContain("ключевых моментов");
  });

  it("answers who handles guests without forcing another qualification topic", async () => {
    const question = "Кто будет заниматься гостями?";
    const { processEvent } = harness([
      reply({ intent: "QUESTION", signals: { questions: [question] } }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result.outboundMessage).toContain("администратор");
  });

  it("explains economics without promising a guaranteed income", async () => {
    const question = "Вы гарантируете 150 тысяч в месяц?";
    const { processEvent } = harness([
      reply({
        intent: "QUESTION",
        facts: { requiresGuaranteedIncome: false },
        signals: { questions: [question] },
      }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result.outboundMessage).toContain("Гарантированного дохода нет");
    expect(result.outboundMessage).toContain("около 20 000 ₽");
    expect(result.outboundMessage).not.toContain("первого этапа");
    expect(result.outboundMessage).not.toContain("около 150 000 ₽");
  });

  it("calculates the income reference for one explicitly named unit", async () => {
    const question = "Сколько можно заработать на одной квартире?";
    const { llm, processEvent } = harness([
      reply({
        intent: "QUESTION",
        facts: { calculationUnits: 1 },
        signals: { questions: [question] },
      }),
    ]);

    const result = await processEvent(input(1, question));

    expect(result.outboundMessage).toContain("около 20 000 ₽ в месяц");
    expect(result.outboundMessage).toContain("ориентир, а не гарантия");
    expect(llm.callCount).toBe(1);
  });

  it("calculates the income reference for ten explicitly named units", async () => {
    const question = "Хочу запустить 10 квартир, сколько это примерно может приносить?";
    const { processEvent } = harness([
      reply({
        intent: "QUESTION",
        facts: {
          calculationUnits: 10,
          startingUnits: 10,
          scalingPotentialUnits: 10,
        },
        signals: { questions: [question] },
      }),
    ]);

    const result = await processEvent(input(1, question));

    expect(result.outboundMessage).toContain("около 200 000 ₽ в месяц");
    expect(result.outboundMessage).toContain("ориентир, а не гарантия");
    expect(result.shouldHandoffToManager).toBe(false);
  });

  it("never derives a unit count from capital alone", async () => {
    const question = "У меня 2 миллиона, сколько я смогу зарабатывать?";
    const { processEvent } = harness([
      reply({
        intent: "QUESTION",
        facts: {
          availableCapital: 2_000_000,
          availableCapitalConfirmed: true,
        },
        signals: { questions: [question] },
      }),
    ]);

    const result = await processEvent(input(1, question));

    expect(result.outboundMessage).toContain(
      "По одному размеру капитала нельзя корректно определить количество объектов",
    );
    expect(result.outboundMessage).toContain("предполагаемое число объектов");
    expect(result.outboundMessage).toContain("около 20 000 ₽ с одного объекта");
    expect(result.outboundMessage).not.toContain("200 000 ₽");
    expect(result.suggestedNextInformationNeed).toBe("STARTING_UNITS");
    expect(result.shouldHandoffToManager).toBe(false);
  });

  it("treats an unspecified 50,000 as first-stage money and asks about other launch costs", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          budget: 50_000,
          budgetConfirmed: true,
          entryBudget: 50_000,
          capitalScope: "ENTRY_ONLY",
        },
      }),
    ]);

    const result = await processEvent(input(1, "У меня есть 50 тысяч"));

    expect(result).toMatchObject({
      segment: "UNDETERMINED",
      qualificationStatus: "BORDERLINE",
      suggestedNextInformationNeed: "ADDITIONAL_EXPENSES",
      shouldHandoffToManager: false,
    });
    expect(result.extraction?.facts).toMatchObject({
      entryBudget: 50_000,
      availableCapital: null,
    });
    expect(result.outboundMessage).toBeTruthy();
    expect(result.outboundMessage).toContain("аренда");
    expect(result.outboundMessage).toContain("залог");
  });

  it("rejects only an explicit refusal to fund required expenses beyond 50,000", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          availableCapital: 50_000,
          availableCapitalConfirmed: true,
          additionalLaunchCapital: 0,
          capitalScope: "TOTAL_LIMIT",
          additionalExpensesReadiness: "NOT_READY",
        },
      }),
    ]);

    const result = await processEvent(
      input(1, "У меня только 50 тысяч на всё и больше вкладывать не готов"),
    );

    expect(result).toMatchObject({
      qualificationStatus: "NO_FIT",
      qualificationReason: "UNWILLING_TO_FUND_REQUIRED_EXPENSES",
      conversationState: "CLOSED",
      shouldHandoffToManager: false,
    });
    expect(result.outboundMessage).toContain("аренду, залог");
    expect(result.outboundMessage).not.toContain("100 000");
  });

  it("merges explicit service and additional capital without another financial question", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          availableCapital: 150_000,
          availableCapitalConfirmed: true,
          entryBudget: 50_000,
          additionalLaunchCapital: 100_000,
          capitalScope: "ADDITIONAL_AVAILABLE",
          additionalExpensesReadiness: "READY",
        },
      }),
    ]);

    const result = await processEvent(
      input(1, "Есть 50 тысяч вам и ещё 100 тысяч на квартиру"),
    );

    expect(result.extraction?.facts).toMatchObject({
      availableCapital: 150_000,
      entryBudget: 50_000,
      additionalLaunchCapital: 100_000,
    });
    expect(result.knownFacts).toContain("ADDITIONAL_EXPENSES");
    expect(result.suggestedNextInformationNeed).not.toBe("ADDITIONAL_EXPENSES");
    expect(result.outboundMessage).not.toContain("отдельный бюджет");
  });

  it("treats a clear 300,000 answer as available capital and leaves the financial topic", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          budget: 300_000,
          budgetConfirmed: true,
          availableCapital: 300_000,
          availableCapitalConfirmed: true,
          capitalScope: "UNKNOWN",
        },
      }),
    ]);

    const result = await processEvent(input(1, "300 для начала"));
    const lead = await persistence.leads.findById(result.leadId!);

    expect(lead).toMatchObject({
      availableCapital: 300_000,
      availableCapitalConfirmed: true,
    });
    expect(result.knownFacts).toEqual(expect.arrayContaining([
      "AVAILABLE_CAPITAL",
      "ADDITIONAL_EXPENSES",
    ]));
    expect(result.suggestedNextInformationNeed).not.toBe("AVAILABLE_CAPITAL");
    expect(result.suggestedNextInformationNeed).not.toBe("ADDITIONAL_EXPENSES");
    expect(result.outboundMessage).not.toContain("отдельный бюджет");
    expect(result.outboundMessage).not.toContain("общий доступный капитал");
  });

  it("extracts capital, timing and starting units together and asks none of them again", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          availableCapital: 300_000,
          availableCapitalConfirmed: true,
          launchTiming: "WITHIN_MONTH",
          startingUnits: 2,
        },
      }),
    ]);

    const result = await processEvent(
      input(1, "Есть 300 тысяч, хочу начать через месяц с двух квартир"),
    );

    expect(result.knownFacts).toEqual(expect.arrayContaining([
      "AVAILABLE_CAPITAL",
      "LAUNCH_TIMING",
      "STARTING_UNITS",
    ]));
    expect(result.suggestedNextInformationNeed).not.toBe("AVAILABLE_CAPITAL");
    expect(result.suggestedNextInformationNeed).not.toBe("LAUNCH_TIMING");
    expect(result.suggestedNextInformationNeed).not.toBe("STARTING_UNITS");
    expect(result.outboundMessage).not.toMatch(/Какую сумму|Когда примерно|Со скольких/iu);
  });

  it("treats 200,000 as strong financial readiness without another financial question", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          availableCapital: 200_000,
          availableCapitalConfirmed: true,
          startingUnits: 1,
          launchTiming: "READY_NOW",
        },
      }),
    ]);

    const result = await processEvent(
      input(1, "У меня 200 тысяч и готов начать сейчас с одной квартиры"),
    );

    expect(result.knownFacts).toContain("ADDITIONAL_EXPENSES");
    expect(result.suggestedNextInformationNeed).not.toBe("ADDITIONAL_EXPENSES");
    expect(result.qualificationStatus).not.toBe("NO_FIT");
  });

  it("answers transparently how much a small-business launch can require", async () => {
    const question = "Сколько вообще надо денег на старт?";
    const { processEvent } = harness([
      reply({ intent: "QUESTION", signals: { questions: [question] } }),
    ]);

    const result = await processEvent(input(1, question));

    expect(result.outboundMessage).toContain("50 000 ₽");
    expect(result.outboundMessage).toContain("при аренде 35 000 ₽");
    expect(result.outboundMessage).toContain("около 150 000 ₽");
    expect(result.outboundMessage).toContain("при аренде 50 000 ₽");
    expect(result.outboundMessage).toContain("около 180 000 ₽");
    expect(result.outboundMessage).toContain("не фиксированная смета");
  });

  it("does not guarantee that 140,000 will cover a launch", async () => {
    const question = "140 тысяч гарантированно хватит?";
    const { processEvent } = harness([
      reply({
        intent: "QUESTION",
        facts: {
          availableCapital: 140_000,
          availableCapitalConfirmed: true,
        },
        signals: { questions: [question] },
      }),
    ]);

    const result = await processEvent(input(1, question));

    expect(result.outboundMessage).toContain("не фиксированная смета");
    expect(result.outboundMessage).toContain("зависит от конкретного объекта");
    expect(result.outboundMessage).not.toContain("гарантированно хватит");
    expect(result.outboundMessage).not.toContain("Гарантированного дохода");
  });

  it("raises financial readiness after additional capital arrives in the next turn", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          entryBudget: 50_000,
          capitalScope: "ENTRY_ONLY",
        },
      }),
      reply({
        facts: {
          additionalLaunchCapital: 100_000,
          capitalScope: "ADDITIONAL_AVAILABLE",
          additionalExpensesReadiness: "READY",
        },
      }),
    ]);

    const first = await processEvent(input(1, "Есть 50 тысяч"));
    const second = await processEvent(
      input(2, "Да, ещё около 100 тысяч могу выделить"),
    );
    const lead = await persistence.leads.findById(second.leadId!);

    expect(first.suggestedNextInformationNeed).toBe("ADDITIONAL_EXPENSES");
    expect(second.suggestedNextInformationNeed).not.toBe("ADDITIONAL_EXPENSES");
    expect(second.knownFacts).toContain("ADDITIONAL_EXPENSES");
    expect(second.outboundMessage).not.toContain("отдельный бюджет");
    expect(lead).toMatchObject({
      availableCapital: 150_000,
      entryBudget: 50_000,
      additionalLaunchCapital: 100_000,
    });
  });

  it("does not repeat management readiness after an explicit positive answer", async () => {
    const statement = "Готов работать с управляющей компанией";
    const { processEvent } = harness([
      reply({
        facts: { managementReadiness: null },
        signals: { objections: [statement] },
      }),
    ]);

    const result = await processEvent(input(1, statement));
    const lead = await persistence.leads.findById(result.leadId!);

    expect(result.knownFacts).toContain("MANAGEMENT_READINESS");
    expect(result.suggestedNextInformationNeed).not.toBe("MANAGEMENT_READINESS");
    expect(lead?.managementReadiness).toBe("READY");
    expect(lead?.objections).toEqual([]);
  });

  it("answers pricing only from the approved knowledge base", async () => {
    const question = "Сколько вы берёте?";
    const { processEvent } = harness([
      reply({ intent: "QUESTION", signals: { questions: [question] } }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result.outboundMessage).toContain("50 000 ₽");
    expect(result.outboundMessage).toContain("личный менеджер");
    expect(result.outboundMessage).toContain("бухгалтерское и юридическое сопровождение");
    expect(result.outboundMessage).not.toContain("уточнить у менеджера");
  });

  it("hands an unknown business question to a manager instead of inventing an answer", async () => {
    const question = "Какая страховая компания покроет ущерб на объекте?";
    const { processEvent } = harness([
      reply({ intent: "QUESTION", facts: { phoneNumber: "+79991234567", phoneConfirmed: true }, signals: { questions: [question] } }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result).toMatchObject({
      qualificationStatus: "NEEDS_MORE_INFO",
      shouldHandoffToManager: false,
      qualificationReason: "UNKNOWN_BUSINESS_QUESTION",
    });
    expect(result.outboundMessage).toContain("лучше уточнить у менеджера");
  });

  it("handles distrust with the approved proof and keeps the dialogue open", async () => {
    const objection = "Не верю в эти цифры";
    const { processEvent } = harness([
      reply({
        intent: "OBJECTION",
        signals: {
          objections: [objection],
          possiblePrimaryFear: "FEAR_DISTRUST_NUMBERS",
        },
      }),
    ]);
    const result = await processEvent(input(1, objection));
    expect(result.outboundMessage).toContain("скриншоты выручки");
    expect(result.outboundMessage).toContain("не гарантия");
    expect(result.nextAction).toBe("CONTINUE_QUALIFICATION");
  });

  it("stops after an explicit decline without another qualification question", async () => {
    const { processEvent } = harness([reply({ intent: "DECLINE" })]);
    const result = await processEvent(input(1, "Не интересно"));
    expect(result).toMatchObject({
      qualificationStatus: "NO_FIT",
      nextAction: "REJECT_POLITELY",
      conversationState: "CLOSED",
    });
    expect(result.outboundMessage).not.toContain("?");
  });

  it("rejects an explicit no-money lead even when extraction misses the typo-heavy phrase", async () => {
    const { processEvent } = harness([reply()]);

    const result = await processEvent(
      input(1, "Я из Пердищ мне и нет денег, хачу бизнис"),
    );

    expect(result.extraction?.facts).toMatchObject({
      budget: 0,
      budgetConfirmed: true,
      availableCapital: 0,
      availableCapitalConfirmed: true,
      capitalScope: "TOTAL_LIMIT",
    });
    expect(result).toMatchObject({
      qualificationStatus: "NO_FIT",
      qualificationReason: "NO_LAUNCH_CAPITAL",
      shouldHandoffToManager: false,
      nextAction: "REJECT_POLITELY",
      conversationState: "CLOSED",
    });
    expect(result.outboundMessage).not.toContain("?");
  });

  it("does not treat limited time as NO_FIT and asks about management readiness", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Химки",
          availableCapital: 300_000,
          availableCapitalConfirmed: true,
          entryBudget: 50_000,
          additionalExpensesReadiness: "READY",
          businessModelReadiness: "ACCEPTS",
          hasFreeTime: false,
          availableTimeDetails: "Работаю, времени мало",
          primaryGoal: "ADDITIONAL_INCOME",
          startingUnits: 2,
          launchTiming: "WITHIN_MONTH",
        },
      }),
    ]);
    const result = await processEvent(input(1, "Я из Химок, есть 300 тысяч, работаю, времени мало"));
    expect(result.qualificationStatus).toBe("BORDERLINE");
    expect(result.qualificationStatus).not.toBe("NO_FIT");
    expect(result.suggestedNextInformationNeed).toBe("MANAGEMENT_READINESS");
  });

  it("does not treat acknowledgement as financial readiness but accepts an explicit contextual confirmation", async () => {
    const question = "Сколько нужно денег?";
    const { llm, processEvent } = harness([
      reply({
        intent: "QUESTION",
        facts: {
          city: "Химки", startingUnits: 1, launchTiming: "WITHIN_MONTH",
          primaryGoal: "MAIN_BUSINESS", businessModelReadiness: "ACCEPTS",
          managementReadiness: "READY", phoneNumber: "+79991234567",
          phoneConfirmed: true,
        },
        signals: { questions: [question] },
      }),
      reply(),
      reply({ facts: { additionalExpensesReadiness: "READY" } }),
    ]);

    const disclosed = await processEvent(input(1, question));
    const acknowledged = await processEvent(input(2, "Понял"));
    const confirmed = await processEvent(input(3, "Да, такой бюджет на запуск мне подходит"));

    expect(disclosed).toMatchObject({ shouldHandoffToManager: false,
      suggestedNextInformationNeed: "AVAILABLE_CAPITAL" });
    expect(acknowledged).toMatchObject({ shouldHandoffToManager: false,
      suggestedNextInformationNeed: "AVAILABLE_CAPITAL" });
    expect(confirmed).toMatchObject({ qualificationStatus: "HOT",
      shouldHandoffToManager: true });
    const confirmationContext = JSON.parse(llm.requests[2]!.userMessage) as {
      CURRENT_MESSAGE: string;
      RECENT_MESSAGES: Array<{ direction: string; content: string }>;
    };
    expect(confirmationContext.CURRENT_MESSAGE).toContain("такой бюджет");
    expect(confirmationContext.RECENT_MESSAGES.some((message) =>
      message.direction === "OUTBOUND" && message.content.includes("150 000 ₽"))).toBe(true);
    expect(await persistence.managerNotifications.findByIdempotencyKey(
      `manager-handoff:${confirmed.leadId}`,
    )).not.toBeNull();
  });

  it("accumulates facts through a full dialogue without repeating known questions", async () => {
    const { llm, processEvent } = harness([
      reply({ intent: "GENERAL_INTEREST" }),
      reply({
        facts: {
          entryBudget: 60_000,
          capitalScope: "ENTRY_ONLY",
        },
      }),
      reply({
        facts: {
          additionalLaunchCapital: 100_000,
          capitalScope: "ADDITIONAL_AVAILABLE",
          additionalExpensesReadiness: "READY",
        },
      }),
      reply({
        facts: {
          startingUnits: 1,
          scalingPotentialUnits: 10,
          primaryGoal: "MAIN_BUSINESS",
        },
      }),
      reply({
        facts: {
          city: "Волгоград",
          launchTiming: "WITHIN_MONTH",
          businessModelReadiness: "ACCEPTS",
        },
      }),
      reply({
        facts: {
          managementReadiness: "READY",
          phoneNumber: "8 (999) 123-45-67",
          phoneConfirmed: true,
        },
      }),
    ]);

    const turns = [
      await processEvent(input(1, "Здравствуйте, интересно, расскажите подробнее")),
      await processEvent(input(2, "Есть около 60 тысяч на первый этап")),
      await processEvent(input(3, "Да, ещё около 100 тысяч могу выделить на квартиру")),
      await processEvent(input(4, "Начну с одной квартиры, потом готов дойти до десяти, цель — основной бизнес")),
      await processEvent(input(5, "Я из Волгограда, старт через месяц, модель субаренды принимаю")),
      await processEvent(input(6, "Да, готов взаимодействовать с управляющей компанией. Позвоните 89991234567")),
    ];

    expect(turns.map((turn) => turn.suggestedNextInformationNeed)).toEqual([
      "CITY",
      "ADDITIONAL_EXPENSES",
      "STARTING_UNITS",
      "LAUNCH_TIMING",
      "MANAGEMENT_READINESS",
      null,
    ]);
    expect(turns[5]).toMatchObject({
      qualificationStatus: "HOT",
      shouldHandoffToManager: true,
      conversationState: "QUALIFIED",
      managerSummary: {
        entryBudget: 60_000,
        additionalLaunchCapital: 100_000,
        launchCostAwareness: "CONFIRMED",
        financialReadiness: "READY",
        financialBarrier: null,
      },
    });
    expect(llm.callCount).toBe(6);
    const allOutbound = turns.map((turn) => turn.outboundMessage).join(" ");
    expect(allOutbound.match(/Какую сумму вы реально готовы выделить/g) ?? []).toHaveLength(0);
  });

  it("switches a promising multi-turn lead to NO_FIT when a hard blocker appears", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Волгоград",
          budget: 500_000,
          budgetConfirmed: true,
          startingUnits: 3,
        },
      }),
      reply({ facts: { launchTiming: "NO_PLANS" } }),
    ]);
    const first = await processEvent(input(1, "Есть 500 тысяч, думаю о трёх объектах"));
    const second = await processEvent(input(2, "Запускаться вообще не планирую"));
    expect(first.qualificationStatus).not.toBe("NO_FIT");
    expect(second).toMatchObject({
      qualificationStatus: "NO_FIT",
      shouldHandoffToManager: false,
      conversationState: "CLOSED",
    });
    expect(second.outboundMessage).not.toContain("?");
  });

  it("updates buying intent as the conversation advances", async () => {
    const { processEvent } = harness([
      reply({ facts: { buyingIntent: "EXPLORING" } }),
      reply({ facts: { buyingIntent: "READY_TO_START", launchTiming: "READY_NOW" } }),
    ]);
    const first = await processEvent(input(1, "Пока изучаю варианты"));
    expect(await persistence.leads.findById(first.leadId!)).toMatchObject({
      buyingIntent: "EXPLORING",
    });
    const second = await processEvent(input(2, "Условия подходят, готов начинать"));
    expect(await persistence.leads.findById(second.leadId!)).toMatchObject({
      buyingIntent: "READY_TO_START",
      launchTiming: "READY_NOW",
    });
  });

  it("keeps limited free time as a manager risk without blocking handoff", async () => {
    const { processEvent } = harness([
      reply({ facts: {
        city: "Химки", availableCapital: 180_000,
        availableCapitalConfirmed: true, capitalScope: "TOTAL_LIMIT",
        additionalExpensesReadiness: "READY", businessModelReadiness: "ACCEPTS",
        startingUnits: 1, scalingPotentialUnits: 3,
        hasFreeTime: false, availableTimeDetails: "Могу уделять только час вечером",
        launchTiming: "WITHIN_MONTH", primaryGoal: "MAIN_BUSINESS",
        managementReadiness: "READY", phoneNumber: "+79991234567",
        phoneConfirmed: true, buyingIntent: "READY_TO_START",
      } }),
    ]);
    const result = await processEvent(input(1, "Есть 180 тысяч, времени только час вечером, но готов начинать"));
    expect(result).toMatchObject({
      shouldHandoffToManager: true,
      managerSummary: {
        availableTime: "Могу уделять только час вечером",
      },
    });
    expect(result.qualificationStatus).not.toBe("NO_FIT");
  });

  it("keeps a multi-turn sales conversation adaptive, repairs complaints, and hands off once", async () => {
    const extractionProvider = new FakeLLMProvider([
      reply({ intent: "GENERAL_INTEREST" }),
      reply({ facts: {
        primaryGoal: "ADDITIONAL_INCOME",
        buyingIntent: "CONSIDERING",
      } }),
      reply({
        intent: "QUESTION",
        facts: { city: "Москва", calculationUnits: 1 },
        signals: { questions: ["Сколько примерно стоит старт?"] },
      }),
      reply({
        intent: "CONFIRMATION",
        facts: {
          availableCapital: 300_000,
          availableCapitalConfirmed: true,
          additionalExpensesReadiness: "READY",
          buyingIntent: "CONDITIONS_ACCEPTED",
        },
      }),
      reply({ facts: {
        startingUnits: 1,
        businessModelReadiness: "ACCEPTS",
        managementReadiness: "READY",
        buyingIntent: "READY_TO_START",
      } }),
      reply({ facts: { launchTiming: "WITHIN_MONTH" } }),
      reply({ intent: "COMPLAINT" }),
      reply({
        intent: "CONFIRMATION",
        facts: {
          hasFreeTime: true,
          availableTimeDetails: "Могу уделять 3–4 часа в день",
        },
      }),
      reply({ facts: {
        phoneNumber: "79629910514",
        phoneConfirmed: true,
      } }),
      reply({
        intent: "QUESTION",
        signals: { questions: ["Кто будет общаться с гостями?"] },
      }),
    ]);
    const responseProvider = new FakeLLMProvider([
      JSON.stringify({
        text: "Здравствуйте! Что вы хотите получить от этого бизнеса?",
        nextInformationNeed: "GOAL",
        conversationAction: "DISCOVER",
      }),
      JSON.stringify({
        text: "Понял, рассматриваете это как дополнительный доход. В каком городе хотите запускаться?",
        nextInformationNeed: "CITY",
        conversationAction: "ACKNOWLEDGE",
      }),
      JSON.stringify({
        text: "Для Москвы ориентир старта одного объекта — около 180 000 ₽, но точная сумма зависит от аренды и условий собственника. Какой бюджет в целом готовы вложить в запуск?",
        nextInformationNeed: "AVAILABLE_CAPITAL",
        conversationAction: "ANSWER",
        usedKnowledgeEntryIds: ["small-business-entry"],
      }),
      JSON.stringify({
        text: "Понял, 300 000 ₽ на запуск. Со скольких объектов хотите начать?",
        nextInformationNeed: "STARTING_UNITS",
        conversationAction: "ACKNOWLEDGE",
      }),
      JSON.stringify({
        text: "Хорошо, начинаете с одного объекта вместе с нашей командой. Когда хотели бы запуститься?",
        nextInformationNeed: "LAUNCH_TIMING",
        conversationAction: "ACKNOWLEDGE",
      }),
      JSON.stringify({
        text: "Понял, ориентируетесь на ближайший месяц. Сможете уделять проекту примерно 3–4 часа в день?",
        nextInformationNeed: "FREE_TIME",
        conversationAction: "DISCOVER",
        usedKnowledgeEntryIds: ["partner-time"],
      }),
      JSON.stringify({
        text: "Да, предыдущий вопрос прозвучал неудачно. Я хотел только понять, сколько времени вам будет комфортно уделять запуску.",
        nextInformationNeed: null,
        conversationAction: "REPAIR",
      }),
      JSON.stringify({
        text: "Отлично, 3–4 часа в день достаточно для участия в запуске. Оставьте номер, чтобы менеджер мог связаться с вами?",
        nextInformationNeed: "PHONE_NUMBER",
        conversationAction: "ACKNOWLEDGE",
        usedKnowledgeEntryIds: ["partner-time"],
      }),
      JSON.stringify({
        text: "Спасибо, номер принял. Менеджер свяжется с вами.",
        nextInformationNeed: null,
        conversationAction: "HANDOFF",
      }),
      JSON.stringify({
        text: "С гостями работает администратор, он же координирует необходимые операционные вопросы.",
        nextInformationNeed: null,
        conversationAction: "ANSWER",
        usedKnowledgeEntryIds: ["operations-guests"],
      }),
    ]);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: extractionProvider }),
      generateNaturalResponse: createNaturalResponseGenerator({
        llmProvider: responseProvider,
      }),
      generateId: () => `adaptive-${++nextId}`,
      now: () => new Date(`2026-09-01T11:${String(nextId).padStart(2, "0")}:00Z`),
    });

    const turns = [
      await processEvent(input(101, "Здравствуйте, мне интересно")),
      await processEvent(input(102, "Хочу дополнительный доход")),
      await processEvent(input(103, "Я из Москвы. Сколько примерно стоит старт?")),
      await processEvent(input(104, "300 тысяч, готов")),
      await processEvent(input(105, "Начну с одной, с вами буду запускаться")),
      await processEvent(input(106, "В течение месяца")),
      await processEvent(input(107, "Ты че несешь?")),
    ];
    const afterComplaint = await persistence.conversations.findById(
      turns[6]!.conversationId!,
    );
    turns.push(
      await processEvent(input(108, "Ладно, могу уделять 3–4 часа в день")),
      await processEvent(input(109, "79629910514")),
      await processEvent(input(110, "Кто будет общаться с гостями?")),
    );

    expect(turns[0]?.suggestedNextInformationNeed).not.toBe("AVAILABLE_CAPITAL");
    expect(turns[3]?.outboundMessage).not.toContain("180 000 ₽");
    expect(turns[4]?.suggestedNextInformationNeed).not.toBe("BUSINESS_MODEL");
    expect(turns[6]?.conversationState).toBe("QUALIFYING");
    expect(afterComplaint?.pendingInformationNeed).toBeNull();
    expect(turns[6]?.outboundMessage).not.toContain("?");
    expect(turns[8]).toMatchObject({
      shouldHandoffToManager: true,
      outboundMessage: "Спасибо, номер принял. Менеджер свяжется с вами.",
    });
    expect(turns[9]?.outboundMessage).toContain("администратор");
    expect(turns[9]?.outboundMessage).not.toContain("номер");
    expect(turns.every((turn) => (turn.outboundMessage?.length ?? 0) < 420)).toBe(true);

    const confirmationContext = JSON.parse(
      responseProvider.requests[3]!.userMessage,
    ) as {
      previouslyExplainedKnowledgeEntryIds: string[];
      economicsContext: unknown;
      recentMessages: Array<{ actor: string; content: string }>;
    };
    expect(confirmationContext.previouslyExplainedKnowledgeEntryIds)
      .toContain("small-business-entry");
    expect(confirmationContext.economicsContext).toBeNull();
    expect(confirmationContext.recentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: "AI", content: expect.stringContaining("180 000 ₽") }),
      expect.objectContaining({ actor: "USER", content: "300 тысяч, готов" }),
    ]));

    const lead = await persistence.leads.findById(turns[9]!.leadId!);
    expect(lead).toMatchObject({
      city: "Москва",
      availableCapital: 300_000,
      startingUnits: 1,
      businessModelReadiness: "ACCEPTS",
      managementReadiness: "READY",
      hasFreeTime: true,
      availableTimeDetails: "Могу уделять 3–4 часа в день",
      phoneNumber: "+79629910514",
    });
    expect(await persistence.managerNotifications.findByIdempotencyKey(
      `manager-handoff:${turns[8]!.leadId}`,
    )).not.toBeNull();
    expect(responseProvider.callCount).toBe(10);
  });

  it("does not let a generic acknowledgement stall an active sales turn", async () => {
    const extractionProvider = new FakeLLMProvider([
      reply({ intent: "GENERAL_INTEREST", facts: { buyingIntent: "EXPLORING" } }),
    ]);
    const responseProvider = new FakeLLMProvider([
      JSON.stringify({
        text: "Понял.",
        nextInformationNeed: null,
        conversationAction: "ACKNOWLEDGE",
      }),
      JSON.stringify({
        text: "Здравствуйте! В каком городе планируете запуск?",
        nextInformationNeed: "CITY",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "Для начала полезно понять регион запуска.",
      }),
    ]);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: extractionProvider }),
      generateNaturalResponse: createNaturalResponseGenerator({
        llmProvider: responseProvider,
      }),
      generateId: () => `progress-${++nextId}`,
      now: () => new Date(`2026-09-01T11:${String(nextId).padStart(2, "0")}:00Z`),
    });

    const result = await processEvent(input(151, "Здравствуйте, мне интересно"));
    const conversation = await persistence.conversations.findById(
      result.conversationId!,
    );

    expect(result.outboundMessage).toContain("город");
    expect(result.outboundMessage).not.toBe("Понял.");
    expect(conversation?.pendingInformationNeed).toBe("CITY");
    expect(responseProvider.callCount).toBe(2);
  });

  it("does not turn an unresolved fact into a repeated question across topics", async () => {
    const extractionProvider = new FakeLLMProvider([
      reply({ intent: "GENERAL_INTEREST", facts: { buyingIntent: "EXPLORING" } }),
      reply({ intent: "QUALIFICATION_INFORMATION", facts: { buyingIntent: "CONSIDERING" } }),
      reply({ facts: { primaryGoal: "ADDITIONAL_INCOME", buyingIntent: "CONSIDERING" } }),
      reply({ intent: "QUALIFICATION_INFORMATION" }),
      reply({
        intent: "QUESTION",
        signals: { questions: ["В каком городе можно запускаться?"] },
      }),
    ]);
    const responseProvider = new FakeLLMProvider([
      JSON.stringify({
        text: "Здравствуйте! В каком городе планируете запуск?",
        nextInformationNeed: "CITY",
      }),
      JSON.stringify({
        text: "Понял, город пока не определили. Какую задачу хотите решить этим бизнесом?",
        nextInformationNeed: "GOAL",
      }),
      JSON.stringify({
        text: "Понял, рассматриваете проект как дополнительный доход. Был ли у вас опыт в недвижимости или посуточной аренде?",
        nextInformationNeed: "EXPERIENCE",
      }),
      JSON.stringify({
        text: "Понял, к вопросу об опыте можно вернуться позже.",
        nextInformationNeed: null,
        qualificationMoveDecision: "DEFER",
        qualificationMoveRationale: "Пользователь пока только присматривается и не готов углублять эту тему.",
      }),
      JSON.stringify({
        text: "Возможность запуска зависит от города, поэтому подскажите, где планируете работать?",
        nextInformationNeed: "CITY",
      }),
    ]);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: extractionProvider }),
      generateNaturalResponse: createNaturalResponseGenerator({
        llmProvider: responseProvider,
      }),
      generateId: () => `global-memory-${++nextId}`,
      now: () => new Date(`2026-09-01T12:${String(nextId).padStart(2, "0")}:00Z`),
    });

    const first = await processEvent(input(201, "Здравствуйте, мне интересно"));
    const second = await processEvent(input(202, "Пока не определился, где запускаться"));
    const third = await processEvent(input(203, "Хочу дополнительный доход"));
    const fourth = await processEvent(input(204, "Пока просто присматриваюсь"));
    const fifth = await processEvent(input(205, "В каком городе можно запускаться?"));

    const conversation = await persistence.conversations.findById(first.conversationId!);
    const lead = await persistence.leads.findById(first.leadId!);
    expect(conversation).toMatchObject({ pendingInformationNeed: "CITY" });
    expect(lead?.city).toBeNull();
    expect(second.outboundMessage).toContain("задачу");
    expect(third.outboundMessage).toContain("опыт");
    expect(fourth.outboundMessage).not.toContain("?");
    expect(fourth.outboundMessage).not.toContain("город");
    expect(fifth.outboundMessage).toContain("город");
    expect(responseProvider.callCount).toBe(5);
  });
});
