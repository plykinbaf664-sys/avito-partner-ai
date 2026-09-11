import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtractMessageResult } from "@/application/extraction/extract-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";

import { createIncomingEventAcceptor } from "./accept-incoming-event";
import { createIncomingEventProcessor } from "./process-incoming-event";
import { createPendingIncomingEventProcessor } from "./process-pending-incoming-events";

const emptyExtraction: ExtractMessageResult = {
  extraction: {
    intent: "GENERAL_INTEREST",
    facts: {
      phoneNumber: null,
      phoneConfirmed: false,
      city: null,
      budget: null,
      budgetConfirmed: null,
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
      primaryGoal: null,
      launchTiming: null,
      managementReadiness: null,
      requiresGuaranteedIncome: null,
      rejectsBusinessModel: null,
    },
    signals: {
      questions: [],
      objections: [],
      possiblePrimaryFear: null,
      possibleSecondaryFear: null,
      wantsHuman: false,
    },
    confidence: 0.9,
    uncertainty: [],
  },
  llm: { model: "fake", inputTokens: 1, outputTokens: 1 },
};

describe("durable webhook intake recovery", () => {
  let persistence: SqlitePersistence;
  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:");
  });
  afterEach(() => persistence.close());

  it("processes a durably accepted event after the request lifecycle and deduplicates it", async () => {
    let id = 0;
    const input = {
      source: "AVITO",
      externalEventId: "message-1",
      externalLeadId: "chat-1",
      messageId: "message-1",
      text: "Здравствуйте",
      receivedAt: new Date("2026-09-11T10:00:00.000Z"),
    };
    const accept = createIncomingEventAcceptor({
      persistence,
      generateId: () => `accepted-${++id}`,
    });
    expect((await accept(input)).created).toBe(true);
    expect((await accept(input)).created).toBe(false);

    const process = createIncomingEventProcessor({
      persistence,
      extractMessage: async () => emptyExtraction,
      generateId: () => `processed-${++id}`,
    });
    const recover = createPendingIncomingEventProcessor({
      persistence,
      processIncomingEvent: process,
      now: () => new Date("2026-09-11T11:00:00.000Z"),
    });
    await expect(recover()).resolves.toEqual({ processed: 1, failed: 0, skipped: 0 });
    await expect(recover()).resolves.toEqual({ processed: 0, failed: 0, skipped: 0 });

    await expect(
      persistence.incomingEvents.findByIdentity("AVITO", "message-1"),
    ).resolves.toMatchObject({ status: "PROCESSED", processingAttempts: 1 });
    const lead = await persistence.leads.findByExternalIdentity("AVITO", "chat-1");
    const conversation = await persistence.conversations.findOpenByLeadId(lead!.id);
    expect(await persistence.messages.listByConversationId(conversation!.id)).toHaveLength(2);
  });
});
