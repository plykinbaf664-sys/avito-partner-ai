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
      city: null,
      budget: null,
      budgetConfirmed: false,
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

  it("moves a strong complete lead to PRIORITY and prepares a manager summary", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Волгоград",
          budget: 500_000,
          budgetConfirmed: true,
          startingUnits: 5,
          scalingPotentialUnits: 5,
          launchTiming: "READY_NOW",
          primaryGoal: "MAIN_BUSINESS",
          managementReadiness: "READY",
        },
      }),
    ]);

    const result = await processEvent(input(1, "Есть 500 тысяч, хочу 5 объектов и готов начать сейчас"));

    expect(result).toMatchObject({
      qualificationStatus: "PRIORITY",
      conversationState: "QUALIFIED",
      shouldHandoffToManager: true,
      suggestedNextInformationNeed: null,
      managerSummary: {
        city: "Волгоград",
        budget: 500_000,
        startingUnits: 5,
        scalingPotentialUnits: 5,
        qualificationStatus: "PRIORITY",
      },
    });
    expect(result.outboundMessage).toContain("Основные данные собраны");
    expect((await persistence.conversations.findById(result.conversationId!))?.qualificationCompleted).toBe(true);
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
    expect(result.outboundMessage).toContain("Какой бюджет");
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
    expect(result.outboundMessage).toContain("Московской области");
    expect(result.outboundMessage).toContain("около 150 000 ₽");
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

  it("does not treat limited time as NO_FIT and asks about management readiness", async () => {
    const { processEvent } = harness([
      reply({
        facts: {
          city: "Химки",
          budget: 300_000,
          budgetConfirmed: true,
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
      reply({ facts: { budget: 300_000, budgetConfirmed: true } }),
      reply({ facts: { city: "Волгоград", launchTiming: "WITHIN_MONTH" } }),
      reply({
        facts: {
          startingUnits: 1,
          scalingPotentialUnits: 5,
          primaryGoal: "MAIN_BUSINESS",
        },
      }),
      reply({ facts: { managementReadiness: "READY" } }),
    ]);

    const turns = [
      await processEvent(input(1, "Здравствуйте, интересно, расскажите подробнее")),
      await processEvent(input(2, "Могу выделить 300 тысяч")),
      await processEvent(input(3, "Я из Волгограда, старт через месяц")),
      await processEvent(input(4, "Хочу основной бизнес и масштаб до пяти объектов")),
      await processEvent(input(5, "Да, готов взаимодействовать")),
    ];

    expect(turns.map((turn) => turn.suggestedNextInformationNeed).slice(0, 4)).toEqual([
      "BUDGET",
      "LAUNCH_TIMING",
      "STARTING_UNITS",
      "MANAGEMENT_READINESS",
    ]);
    expect(turns[4]).toMatchObject({
      qualificationStatus: "PRIORITY",
      shouldHandoffToManager: true,
      conversationState: "QUALIFIED",
    });
    expect(llm.callCount).toBe(5);
    const allOutbound = turns.map((turn) => turn.outboundMessage).join(" ");
    expect(allOutbound.match(/Какой бюджет/g)).toHaveLength(1);
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
