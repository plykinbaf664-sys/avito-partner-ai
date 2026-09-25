import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExtractedFacts,
  ExtractedMessage,
  ExtractedSignals,
} from "@/domain/extraction/extracted-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";
import { FakeManagerNotificationProvider } from "@/integrations/fake/fake-manager-notification-provider";
import { FakeOutboundProvider } from "@/integrations/fake/fake-outbound-provider";
import { createInitialLead } from "../workflows/process-incoming-event";
import {
  createTestChatLabService,
  TEST_CHAT_LAB_SOURCE,
} from "./test-chat-lab-service";

function extractionReply(
  facts: Partial<ExtractedFacts> = {},
  signals: Partial<ExtractedSignals> = {},
  intent: ExtractedMessage["intent"] = "GENERAL_INTEREST",
): string {
  const extraction: ExtractedMessage = {
    intent,
    facts: {
      phoneNumber: "",
      phoneConfirmed: false,
      city: null,
      budget: null,
      budgetConfirmed: false,
      availableCapital: null,
      availableCapitalConfirmed: false,
      entryBudget: null,
      additionalLaunchCapital: null,
      capitalScope: "UNKNOWN",
      additionalExpensesReadiness: "UNKNOWN",
      businessModelReadiness: "UNKNOWN",
      calculationUnits: null,
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
    } satisfies ExtractedSignals,
    confidence: 0.9,
    uncertainty: [],
  };
  return JSON.stringify({
    ...extraction,
    facts: {
      ...extraction.facts,
      availableCapital: extraction.facts.availableCapital ?? -1,
      entryBudget: extraction.facts.entryBudget ?? -1,
      additionalLaunchCapital: extraction.facts.additionalLaunchCapital ?? -1,
      calculationUnits: extraction.facts.calculationUnits ?? -1,
    },
  });
}

function naturalReply(text = "Спасибо, продолжим.", nextInformationNeed: string | null = null): string {
  return JSON.stringify({ replyAction: "SEND_REPLY", text, nextInformationNeed });
}

const at = (hours: number) => new Date(Date.parse("2026-09-18T10:00:00.000Z") + hours * 60 * 60 * 1_000);

describe("isolated Test Chat Lab workflow", () => {
  let persistence: SqlitePersistence;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:", resolve(process.cwd(), "drizzle"));
  });
  afterEach(() => persistence.close());

  it("shows the open conversation when an older one closed at the same virtual time", async () => {
    const lead = createInitialLead("lead-snapshot", TEST_CHAT_LAB_SOURCE, "session-snapshot", at(0));
    await persistence.leads.insert(lead);
    const base = {
      leadId: lead.id,
      summary: null,
      pendingInformationNeed: null,
      lastInboundAt: at(0),
      lastOutboundAt: null,
      awaitingUserReply: false,
      qualificationCompleted: false,
      followUpEligibleAt: null,
      followUpCount: 0,
      lastFollowUpAt: null,
      nextInboundSequence: 0,
      lastAppliedInboundSequence: 0,
      createdAt: at(0),
      updatedAt: at(0),
    } as const;
    await persistence.conversations.insert({
      ...base,
      id: "closed-snapshot",
      state: "CLOSED",
      closedAt: at(0),
    });
    await persistence.conversations.insert({
      ...base,
      id: "open-snapshot",
      state: "WAITING_GOAL",
      pendingInformationNeed: "GOAL",
      closedAt: null,
    });
    const message = {
      leadId: lead.id,
      incomingEventId: null,
      externalMessageId: null,
      deduplicationKey: null,
      direction: "OUTBOUND" as const,
      actor: "AI" as const,
      deliveryStatus: "SENT" as const,
      deliveryAttempts: 1,
      deliveryRetryable: false,
      lastDeliveryErrorCode: null,
      sentAt: at(0),
      createdAt: at(0),
      sequence: null,
    };
    await persistence.messages.insert({
      ...message,
      id: "old-snapshot-message",
      conversationId: "closed-snapshot",
      content: "Первый эпизод разговора",
    });
    await persistence.messages.insert({
      ...message,
      id: "new-snapshot-message",
      conversationId: "open-snapshot",
      content: "Продолжение разговора",
    });
    const lab = createTestChatLabService({
      persistence,
      llmProvider: new FakeLLMProvider([]),
      outboundProvider: new FakeOutboundProvider(),
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    const snapshot = await lab.snapshot("session-snapshot");

    expect(snapshot.conversation).toMatchObject({ id: "open-snapshot", state: "WAITING_GOAL" });
    expect(snapshot.currentNextStep).toBe("GOAL");
    expect(snapshot.messages.map((entry) => entry.content)).toEqual([
      "Первый эпизод разговора",
      "Продолжение разговора",
    ]);
  });

  it("treats a rapid greeting, city and capital as one turn with one reply", async () => {
    const llm = new FakeLLMProvider([
      extractionReply(),
      extractionReply({ city: "Нижний Новгород" }),
      extractionReply({ city: "Нижний Новгород", availableCapital: 100_000, availableCapitalConfirmed: true }),
    ]);
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: new FakeOutboundProvider(),
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    const result = await lab.runScenario("burst-session", "city-and-insufficient-capital", at(0));
    const userMessages = result.snapshot.messages.filter((message) => message.actor === "USER");
    const aiMessages = result.snapshot.messages.filter((message) => message.actor === "AI");
    expect(userMessages).toHaveLength(3);
    expect(aiMessages).toHaveLength(1);
    expect(result.snapshot.lead).toMatchObject({
      city: "Нижний Новгород",
      availableCapital: 100_000,
    });
    expect(aiMessages[0]?.content).not.toMatch(/какой бюджет|сколько готовы вложить/iu);
  });

  it("keeps Dmitry and client in one history and persists an early phone without qualification questioning", async () => {
    const llm = new FakeLLMProvider([
      extractionReply(),
      JSON.stringify({ replyAction: "NO_REPLY", text: "", nextInformationNeed: null }),
    ]);
    const outbound = new FakeOutboundProvider();
    const notifications = new FakeManagerNotificationProvider();
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: outbound,
      managerNotificationProvider: notifications,
    });

    await lab.managerMessage("session-1", "Оставьте номер, я вам сегодня наберу.", at(0), "manager-1");
    const result = await lab.clientMessage("session-1", "89049163020", at(0), "client-1");
    const lead = await persistence.leads.findByExternalIdentity(TEST_CHAT_LAB_SOURCE, "session-1");
    const conversation = lead ? await persistence.conversations.findOpenByLeadId(lead.id) : null;
    const messages = conversation ? await persistence.messages.listByConversationId(conversation.id) : [];

    expect(result.snapshot.phone).toBe("+79049163020");
    expect(result.snapshot.replyAction).toBe("NO_REPLY");
    expect(result.snapshot.currentNextStep).toBe("MANAGER_DEFINED_NEXT_STEP");
    expect(messages.map((message) => [message.actor, message.content])).toEqual([
      ["MANAGER", "Оставьте номер, я вам сегодня наберу."],
      ["USER", "89049163020"],
    ]);
    expect(lead?.qualificationStatus).not.toBe("HOT");
    expect(outbound.requests).toHaveLength(0);
    expect(notifications.requests).toHaveLength(0);
  });

  it("uses the real follow-up workflow when virtual time advances and sends at most one follow-up", async () => {
    const llm = new FakeLLMProvider([
      extractionReply(),
      naturalReply("Подскажите, в каком городе рассматриваете запуск?", "CITY"),
      naturalReply("Вернусь к нашему вопросу о запуске: актуально обсудить формат?", null),
    ]);
    const outbound = new FakeOutboundProvider();
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: outbound,
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    await lab.clientMessage("session-2", "Хочу разобраться с запуском.", at(0), "client-1");
    const before = await lab.snapshot("session-2");
    expect(before.followUp.eligibleAt).not.toBeNull();

    const after = await lab.advanceTime("session-2", at(2));
    expect(after.followUp?.sent).toBe(1);
    expect(after.snapshot.followUp.followUpCount).toBe(1);
    expect(outbound.requests).toHaveLength(2);

    const second = await lab.advanceTime("session-2", at(4));
    expect(second.followUp?.sent).toBe(0);
    expect(outbound.requests).toHaveLength(2);
  });

  it("does not replay an explained business overview when the client answers with a city", async () => {
    const businessOverview = "Команда помогает подобрать и запустить объект, вести объявления, бронирования и работу с гостями.";
    const llm = new FakeLLMProvider([
      extractionReply({}, {
        questions: ["Расскажите подробнее"],
        requiresSubstantiveAnswer: true,
      }, "QUESTION"),
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: `${businessOverview} В каком городе Вы планируете запуск?`,
        nextInformationNeed: "CITY",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "после ответа естественно уточнить город",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: ["company-responsibilities"],
      }),
      extractionReply({}, {
        questions: ["Расскажите подробнее"],
        previousQuestionResponse: "DECLINED_TO_ANSWER",
        requiresSubstantiveAnswer: true,
      }, "QUESTION"),
      extractionReply({ city: "Москва" }, {
        questions: [],
        previousQuestionResponse: "ANSWERED",
        requiresSubstantiveAnswer: false,
      }, "QUALIFICATION_INFORMATION"),
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: "Москва, понял. Какой бюджет в целом Вы готовы выделить на запуск?",
        nextInformationNeed: "AVAILABLE_CAPITAL",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "город принят, следующий полезный факт — бюджет",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: [],
      }),
    ]);
    const outbound = new FakeOutboundProvider();
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: outbound,
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    await lab.clientMessage("session-repeat", "Расскажите подробнее", at(0), "client-1");
    const result = await lab.clientMessage("session-repeat", "Москва", at(0), "client-2");
    const lead = await persistence.leads.findByExternalIdentity(
      TEST_CHAT_LAB_SOURCE,
      "session-repeat",
    );

    expect(llm.callCount).toBe(5);
    expect(lead?.city).toBe("Москва");
    expect(outbound.requests).toHaveLength(2);
    expect(outbound.requests[1]?.text).toContain("Москва");
    expect(outbound.requests[1]?.text).not.toContain(businessOverview);
    expect(result.snapshot.messages.filter((message) => message.actor === "AI"))
      .toHaveLength(2);
  });
});
