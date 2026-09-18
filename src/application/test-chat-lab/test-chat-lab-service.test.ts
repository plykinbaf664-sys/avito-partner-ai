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
import {
  createTestChatLabService,
  TEST_CHAT_LAB_SOURCE,
} from "./test-chat-lab-service";

function extractionReply(facts: Partial<ExtractedFacts> = {}): string {
  const extraction: ExtractedMessage = {
    intent: "GENERAL_INTEREST",
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
});
