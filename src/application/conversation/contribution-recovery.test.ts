import { describe, expect, it } from "vitest";
import { createNaturalResponseGenerator } from "./generate-natural-response";
import { createInitialLead } from "../workflows/process-incoming-event";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";
import { PARTNER_KNOWLEDGE_BASE } from "@/domain/knowledge/knowledge-base";
import type { ConversationResponsePlan } from "@/domain/conversation/conversation-response";

const plan: ConversationResponsePlan = {
  text: "", nextInformationNeed: null, asksUserQuestion: false, useNaturalAdaptation: true,
  knowledgeEntryIds: [], unresolvedQuestions: [], currentUserIntent: "QUALIFICATION_INFORMATION",
  currentQuestionKind: "NONE", previousQuestionResponse: "ANSWERED",
  // Deliberately wrong auxiliary extraction, as seen in production.
  currentTurnRequiresAnswer: true, groundedAnswerRequired: true,
  allowedNextInformationNeeds: ["GOAL"],
  allowedQualificationMoves: [{ need: "GOAL", objective: "Понять цель партнёра" }],
  knownFacts: ["CITY"], qualificationProgressExpected: true,
  approvedFacts: PARTNER_KNOWLEDGE_BASE.map(({ id, category, answer }) => ({ id, category, answer })),
};
const history = [
  { direction: "OUTBOUND" as const, actor: "MANAGER" as const, content: "В каком городе рассматриваете запуск?" },
  { direction: "INBOUND" as const, actor: "USER" as const, content: "Москва" },
];
const contribution = JSON.stringify({ answerText: "По Москве работаем.",
  qualificationQuestion: "Вы рассматриваете это как основной бизнес или дополнительный доход?",
  nextInformationNeed: "GOAL", conversationAction: "DISCOVER", interpretedQuestionKind: "NONE",
  qualificationMoveDecision: "ADVANCE", usedKnowledgeEntryIds: ["supported-cities"] });
const review = (overrides = {}) => JSON.stringify({ answerIsSupported: true,
  answersCurrentRequest: true, optionalQuestionAppropriate: true,
  additionalRequestInAnswer: false, answerWithoutAdditionalRequest: "", feedback: "",
  currentTurnKind: "CONTRIBUTION", ...overrides });

describe("semantic recovery of customer contributions", () => {
  it("provides independent geographic policy to semantic review, even when the plan omits it", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({ answerText: "Возможность запуска в этом городе нужно уточнить.",
        qualificationQuestion: "Какую цель Вы ставите перед запуском?", nextInformationNeed: "GOAL",
        interpretedQuestionKind: "NONE", usedKnowledgeEntryIds: ["supported-cities"] }), review(),
    ]);
    await createNaturalResponseGenerator({ llmProvider: llm })({
      lead: { ...createInitialLead("geography", "TEST", "synthetic", new Date()), city: "Тверь" },
      plan: { ...plan, currentTurnRequiresAnswer: false, groundedAnswerRequired: false },
      recentMessages: [{ direction: "OUTBOUND", actor: "MANAGER", content: "Какой город рассматриваете?" },
        { direction: "INBOUND", actor: "USER", content: "Тверь" }],
    });
    expect(JSON.parse(llm.requests[1].userMessage)).toMatchObject({
      serviceabilityStatus: "NEEDS_REVIEW", currentFacts: { serviceability: "NEEDS_REVIEW" },
    });
  });

  it("lets reviewed conversation understanding override a mistaken mandatory-answer flag", async () => {
    const llm = new FakeLLMProvider([contribution, review()]);
    const result = await createNaturalResponseGenerator({ llmProvider: llm })({
      lead: { ...createInitialLead("contribution", "TEST", "synthetic", new Date()), city: "Москва" },
      plan, recentMessages: history,
    });
    expect(result.nextInformationNeed).toBe("GOAL");
    expect(result.reviewedTurnKind).toBe("CONTRIBUTION");
    expect(result.text).toContain("По Москве работаем.");
    expect(llm.callCount).toBe(2);
  });

  it("repairs unsupported prose for a fact reply without forbidding a useful next step", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({ answerText: "В Москве команда лично ездит с Вами на просмотры.",
        qualificationQuestion: "", interpretedQuestionKind: "BUSINESS_INFORMATION" }),
      review({ answerIsSupported: false, feedback: "Совместные выезды команды не утверждены." }),
      contribution, review(),
    ]);
    const result = await createNaturalResponseGenerator({ llmProvider: llm })({
      lead: { ...createInitialLead("recovery", "TEST", "synthetic", new Date()), city: "Москва" },
      plan, recentMessages: history,
    });
    expect(result.nextInformationNeed).toBe("GOAL");
    expect(result.text).not.toContain("лично ездит");
    const repair = JSON.parse(llm.requests[2].userMessage);
    expect(repair.answerRecovery).toBe(false);
    expect(repair.reviewedTurnKind).toBe("CONTRIBUTION");
    expect(repair.allowedQualificationMoves).toEqual(plan.allowedQualificationMoves);
    expect(repair.currentTurnRequiresAnswer).toBe(false);
    expect(llm.callCount).toBe(4);
  });

  it("still repairs an ignored real request as an answer-only turn even when extraction says otherwise", async () => {
    const llm = new FakeLLMProvider([
      contribution,
      review({ currentTurnKind: "REQUEST", answersCurrentRequest: false,
        feedback: "Клиент спросил про необходимое время, а ответ ушёл в географию." }),
      JSON.stringify({ answerText: "На запуске ориентир — около 3–4 часов в день для просмотров, договоров и решений.",
        qualificationQuestion: "", nextInformationNeed: null, interpretedQuestionKind: "BUSINESS_INFORMATION",
        usedKnowledgeEntryIds: ["partner-time"] }), review({ currentTurnKind: "REQUEST" }),
    ]);
    const result = await createNaturalResponseGenerator({ llmProvider: llm })({
      lead: createInitialLead("request", "TEST", "synthetic", new Date()),
      plan: { ...plan, currentTurnRequiresAnswer: false, groundedAnswerRequired: false },
      recentMessages: [{ direction: "OUTBOUND", actor: "MANAGER", content: "Сколько времени сможете уделять?" },
        { direction: "INBOUND", actor: "USER", content: "А сколько надо?" }],
    });
    expect(result.text).toContain("3–4 часов");
    expect(result.nextInformationNeed).toBeNull();
    expect(JSON.parse(llm.requests[2].userMessage)).toMatchObject({ answerRecovery: true,
      reviewedTurnKind: "REQUEST", allowedQualificationMoves: [], currentTurnRequiresAnswer: true });
  });
});
