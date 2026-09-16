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
});
