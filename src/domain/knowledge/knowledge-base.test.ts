import { describe, expect, it } from "vitest";

import type { ExtractedMessage } from "../extraction/extracted-message";
import { answerFromKnowledgeBase } from "./knowledge-base";

function question(text: string, facts: Partial<ExtractedMessage["facts"]> = {}): ExtractedMessage {
  return {
    intent: "QUESTION",
    facts: {
      phoneNumber: null, phoneConfirmed: false, city: null, budget: null,
      budgetConfirmed: false, availableCapital: null,
      availableCapitalConfirmed: false, entryBudget: null,
      additionalLaunchCapital: null, capitalScope: "UNKNOWN",
      additionalExpensesReadiness: "UNKNOWN",
      businessModelReadiness: "UNKNOWN", calculationUnits: null,
      startingUnits: null, scalingPotentialUnits: null, hasFreeTime: null,
      availableTimeDetails: null, businessExperience: null,
      shortTermRentalExperience: null, ownsProperty: null,
      desiredIncome: null, primaryGoal: "UNKNOWN", launchTiming: null,
      managementReadiness: null, requiresGuaranteedIncome: null,
      rejectsBusinessModel: null,
      ...facts,
    },
    signals: { questions: [text], objections: [], possiblePrimaryFear: null,
      possibleSecondaryFear: null, wantsHuman: false },
    confidence: 1,
    uncertainty: [],
  };
}

describe("contextual partner knowledge", () => {
  it("answers Moscow availability and service payment from approved facts", () => {
    const answer = answerFromKnowledgeBase(question(
      "В Москве можно по такой схеме работать? Ваши услуги как оплачиваются?",
    ));

    expect(answer.entryIds).toEqual(expect.arrayContaining(["supported-cities", "pricing"]));
    expect(answer.answerFragments.join(" ")).toContain("Подтверждённые города");
    expect(answer.answerFragments.join(" ")).toContain("50 000 ₽");
    expect(answer.answerFragments.join(" ")).toContain("юридическое сопровождение");
  });

  it("answers that a partner can start with one object", () => {
    const answer = answerFromKnowledgeBase(question("Можно начать с одного объекта?"));
    expect(answer.entryIds).toContain("single-unit-start");
    expect(answer.unresolvedQuestions).toEqual([]);
  });

  it("states the approved 3–5 object small-business target without blocking a one-unit start", () => {
    const answer = answerFromKnowledgeBase(question("Сколько объектов лучше запускать и можно ли масштабироваться?"));
    expect(answer.entryIds).toContain("small-business-scale");
    expect(answer.answerFragments.join(" ")).toContain("3–5 объектов");
    expect(answer.answerFragments.join(" ")).toContain("Начать можно с одного");
    expect(answer.unresolvedQuestions).toEqual([]);
  });

  it("resolves what is included from the previously explained budget context", () => {
    const answer = answerFromKnowledgeBase(
      question("А это входит в эту сумму?"),
      { previousEntryIds: ["small-business-entry"] },
    );
    expect(answer.contextualReferenceResolved).toBe(true);
    expect(answer.entryIds).toContain("small-business-entry");
    expect(answer.unresolvedQuestions).toEqual([]);
  });

  it("resolves an elliptical cost question from the previous launch-expense turn", () => {
    const extraction = question("А сколько там примерно?");
    extraction.signals.contextualReference = true;
    extraction.signals.resolvedQuestion =
      "Сколько примерно составят аренда, залог и подготовка одного объекта?";
    const answer = answerFromKnowledgeBase(extraction, {
      recentMessages: [{
        direction: "OUTBOUND",
        content: "Аренда, залог и подготовка оплачиваются отдельно от услуги запуска.",
      }],
      leadFacts: { city: "Москва", availableCapital: 400_000 },
    });

    expect(answer.contextualReferenceResolved).toBe(true);
    expect(answer.entryIds).toContain("small-business-entry");
    expect(answer.answerFragments.join(" ")).toContain("180 000 ₽");
    expect(answer.economicsContext?.scenarios[0]?.rentReference.rentMin)
      .toBe(50_000);
  });

  it("uses the preceding one-object economics context for two objects", () => {
    const answer = answerFromKnowledgeBase(
      question("А если два объекта?", { calculationUnits: 2 }),
      {
        previousEntryIds: ["small-business-entry", "guarantees-and-economics"],
        recentMessages: [{ direction: "OUTBOUND", content:
          "Ориентир по доходу — около 20 000 ₽ с одного объекта, без гарантии." }],
      },
    );
    expect(answer.entryIds).toEqual(["guarantees-and-economics"]);
    expect(answer.answerFragments.join(" ")).toContain("40 000 ₽");
    expect(answer.answerFragments.join(" ")).toContain("не гарантия");
  });

  it("uses the approved reverse economics calculation for a confirmed capital", () => {
    const answer = answerFromKnowledgeBase(
      question("Сколько объектов можно начать при таком бюджете?", {
        availableCapital: 500_000,
        availableCapitalConfirmed: true,
      }),
      {
        rentReference: {
          city: "Регион",
          region: "Тестовый регион",
          rentMin: 35_000,
          rentMax: 35_000,
          updatedAt: "2026-09-01",
          source: "Подтверждённый тестовый ориентир",
        },
      },
    );

    expect(answer.answerFragments.join(" ")).toContain("4 объектов");
    expect(answer.answerFragments.join(" ")).toContain("услуга запуска 50 000 ₽ оплачивается один раз");
  });

  it("answers a 250k object-count question with both approved scenarios when city is unknown", () => {
    const answer = answerFromKnowledgeBase(question(
      "У меня 250 тысяч. Со скольких объектов посоветуете начать?",
      { availableCapital: 250_000, availableCapitalConfirmed: true },
    ));

    expect(answer.unresolvedQuestions).toEqual([]);
    expect(answer.answerFragments.join(" ")).toContain("Региональный ориентир: около 2 объектов, запуск 250 000 ₽");
    expect(answer.answerFragments.join(" ")).toContain("Москва: около 1 объект, запуск 180 000 ₽");
    expect(answer.economicsContext?.scenarios).toHaveLength(2);
  });

  it("uses the approved Moscow scenario without asking a manager", () => {
    const answer = answerFromKnowledgeBase(question(
      "Сколько объектов получится?",
      { city: "Москва", availableCapital: 250_000, availableCapitalConfirmed: true },
    ));

    expect(answer.unresolvedQuestions).toEqual([]);
    expect(answer.answerFragments.join(" ")).toContain("Москва: около 1 объект, запуск 180 000 ₽");
    expect(answer.economicsContext?.scenarios[0]?.rentReference.rentMin).toBe(50_000);
  });

  it("answers income for two objects from the approved reference", () => {
    const answer = answerFromKnowledgeBase(question("А сколько примерно можно получать с двух объектов?"));

    expect(answer.unresolvedQuestions).toEqual([]);
    expect(answer.answerFragments.join(" ")).toContain("около 40 000 ₽ в месяц");
    expect(answer.answerFragments.join(" ")).toContain("не гарантия");
  });

  it("keeps a concrete live-market apartment question for a manager", () => {
    const answer = answerFromKnowledgeBase(question(
      "Сколько сейчас реально стоит аренда конкретной двухкомнатной квартиры на улице Ленина",
    ));

    expect(answer.unresolvedQuestions).toContain(
      "Сколько сейчас реально стоит аренда конкретной двухкомнатной квартиры на улице Ленина",
    );
  });

  it("keeps economics out of unrelated turns and exposes the approved time factor", () => {
    const unrelated = answerFromKnowledgeBase(question("Кто будет общаться с гостями?"));
    const time = answerFromKnowledgeBase(question("Сколько времени нужно уделять проекту?"));

    expect(unrelated.economicsContext).toBeUndefined();
    expect(time.answerFragments.join(" ")).toContain("3–4 часов в день");
  });

  it("answers a time question from the current topic without reviving previous economics", () => {
    const answer = answerFromKnowledgeBase(
      question("А сколько времени на это надо?", {
        city: "Москва",
        availableCapital: 500_000,
        availableCapitalConfirmed: true,
      }),
      {
        previousEntryIds: ["small-business-entry"],
        recentMessages: [{
          direction: "OUTBOUND",
          content: "Готовы участвовать в запуске: ездить на просмотры и заключать договоры?",
        }],
        leadFacts: { city: "Москва", availableCapital: 500_000 },
      },
    );

    expect(answer.entryIds).toEqual(["partner-time"]);
    expect(answer.answerFragments.join(" ")).toContain("3–4 часов в день");
    expect(answer.answerFragments.join(" ")).not.toContain("180 000 ₽");
    expect(answer.economicsContext).toBeUndefined();
    expect(answer.contextualReferenceResolved).toBe(false);
  });

  it.each([
    "Мне самому нужно отвечать гостям?",
    "А объявления кто размещает?",
    "Мне самому искать квартиру?",
    "Бухгалтерию самому вести?",
    "Можно потом увеличить количество квартир?",
  ])("does not treat a paraphrase without a literal KB match as unresolved: %s", (text) => {
    const answer = answerFromKnowledgeBase(question(text));

    expect(answer.unresolvedQuestions).toEqual([]);
    expect(answer.approvedFacts.length).toBeGreaterThan(0);
  });

  it("keeps only the genuinely unknown part of a mixed question", () => {
    const answer = answerFromKnowledgeBase(question(
      "Сколько будет стоить запуск трёх квартир в Москве и какие конкретные квартиры вы найдёте?",
      { city: "Москва", calculationUnits: 3 },
    ));

    expect(answer.unresolvedQuestions).toEqual(["какие конкретные квартиры вы найдёте"]);
    expect(answer.economicsContext?.scenarios[0]?.requestedUnitsLaunch?.totalMin).toBe(440_000);
  });
});
