import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtractedMessage } from "@/domain/extraction/extracted-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";

import { createMessageExtractor } from "../extraction/extract-message";
import { createIncomingEventProcessor } from "./process-incoming-event";

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
    expect(result.outboundMessage).toContain("Основные данные собраны");
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
      shouldHandoffToManager: false,
      suggestedNextInformationNeed: "PHONE_NUMBER",
      conversationState: "WAITING_PHONE",
    });
    expect(beforePhone.outboundMessage).toContain("номер телефона");

    const afterPhone = await processEvent(input(2, "Позвоните 89991234567"));
    expect(afterPhone).toMatchObject({
      shouldHandoffToManager: true,
      qualificationStatus: "HOT",
      managerSummary: { phoneNumber: "+79991234567" },
    });
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
    expect(result.outboundMessage).toContain("бюджет");
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
    expect(result.outboundMessage).toContain("бюджет");
  });

  it("answers who handles guests before asking the next useful question", async () => {
    const question = "Кто будет заниматься гостями?";
    const { processEvent } = harness([
      reply({ intent: "QUESTION", signals: { questions: [question] } }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result.outboundMessage).toContain("администратор");
    expect(result.outboundMessage).toContain("Какую сумму");
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
      qualificationStatus: "NEEDS_MORE_INFO",
      suggestedNextInformationNeed: "ADDITIONAL_EXPENSES",
      shouldHandoffToManager: false,
    });
    expect(result.extraction?.facts).toMatchObject({
      entryBudget: 50_000,
      availableCapital: null,
    });
    expect(result.outboundMessage).toContain("аренда, залог");
    expect(result.outboundMessage).toContain("отдельный бюджет");
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
    expect(result.outboundMessage).toContain("35 000 ₽ на аренду");
    expect(result.outboundMessage).toContain("35 000 ₽ на залог");
    expect(result.outboundMessage).toContain("120 000 ₽");
    expect(result.outboundMessage).toContain("20 000 ₽");
    expect(result.outboundMessage).toContain("зависит от конкретного объекта");
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
    expect(result.outboundMessage).toContain("100% от стоимости объекта");
    expect(result.outboundMessage).toContain("500 ₽");
    expect(result.outboundMessage).toContain("100 ₽ в сутки");
    expect(result.outboundMessage).toContain("лучше отдельно уточнить у менеджера");
  });

  it("hands an unknown business question to a manager instead of inventing an answer", async () => {
    const question = "Какая страховая компания покроет ущерб на объекте?";
    const { processEvent } = harness([
      reply({ intent: "QUESTION", signals: { questions: [question] } }),
    ]);
    const result = await processEvent(input(1, question));
    expect(result).toMatchObject({
      qualificationStatus: "HANDOFF",
      shouldHandoffToManager: true,
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
      "AVAILABLE_CAPITAL",
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
        financialReadiness: "HIGH",
        financialBarrier: null,
      },
    });
    expect(llm.callCount).toBe(6);
    const allOutbound = turns.map((turn) => turn.outboundMessage).join(" ");
    expect(allOutbound.match(/Какую сумму вы реально готовы выделить/g)).toHaveLength(1);
  });

  it("switches a promising multi-turn lead to NO_FIT when a hard blocker appears", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Волгоград",
          budget: 300_000,
          budgetConfirmed: true,
          startingUnits: 3,
        },
      }),
      reply({ facts: { launchTiming: "NO_PLANS" } }),
    ]);
    const first = await processEvent(input(1, "Есть 300 тысяч, думаю о трёх объектах"));
    const second = await processEvent(input(2, "Запускаться вообще не планирую"));
    expect(first.qualificationStatus).not.toBe("NO_FIT");
    expect(second).toMatchObject({
      qualificationStatus: "NO_FIT",
      shouldHandoffToManager: false,
      conversationState: "CLOSED",
    });
    expect(second.outboundMessage).not.toContain("?");
  });
});
