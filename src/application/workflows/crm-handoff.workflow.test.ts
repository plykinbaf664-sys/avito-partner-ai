import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCrmService } from "@/application/crm/crm-service";
import type { ExtractMessageResult } from "@/application/extraction/extract-message";
import type { ExtractedMessage } from "@/domain/extraction/extracted-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { FakeManagerNotificationProvider } from "@/integrations/fake/fake-manager-notification-provider";
import { createIncomingEventProcessor } from "./process-incoming-event";

function extraction(
  facts: Partial<ExtractedMessage["facts"]>,
): ExtractMessageResult {
  return {
    extraction: {
      intent: "QUALIFICATION_INFORMATION",
      facts: {
        phoneNumber: null,
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
      },
      confidence: 0.98,
      uncertainty: [],
    },
    llm: { model: "fake", inputTokens: 10, outputTokens: 10 },
  };
}

describe("local CRM handoff workflow", () => {
  let persistence: SqlitePersistence | null = null;
  afterEach(() => persistence?.close());

  it("captures a phone, notifies once, and exposes the same lead in CRM", async () => {
    persistence = await SqlitePersistence.createMigrated(
      "file::memory:",
      resolve(process.cwd(), "drizzle"),
    );
    const manager = new FakeManagerNotificationProvider();
    const replies = [
      extraction({
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
        managementReadiness: "READY",
        primaryGoal: "ADDITIONAL_INCOME",
      }),
      extraction({ phoneNumber: "8 (999) 123-45-67", phoneConfirmed: true }),
    ];
    let id = 0;
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: async () => replies.shift()!,
      managerNotificationProvider: manager,
      generateId: () => `e2e-${++id}`,
      now: () => new Date("2026-09-09T12:00:00.000Z"),
    });
    const common = { source: "e2e", externalLeadId: "lead-1" };

    const first = await processEvent({
      ...common,
      externalEventId: "event-1",
      messageId: "message-1",
      text: "Готов запускать один объект в Химках",
    });
    expect(first.suggestedNextInformationNeed).toBe("PHONE_NUMBER");

    const secondInput = {
      ...common,
      externalEventId: "event-2",
      messageId: "message-2",
      text: "Мой номер 89991234567",
    };
    const second = await processEvent(secondInput);
    expect(second.shouldHandoffToManager).toBe(true);
    expect(manager.requests).toHaveLength(1);

    const crm = await createCrmService(persistence).getLead(second.leadId!);
    expect(crm).toMatchObject({
      phoneNumber: "+79991234567",
      qualificationStatus: "HOT",
      managerNotificationStatus: "SENT",
    });
    expect(crm?.managerSummary?.phoneNumber).toBe("+79991234567");

    const duplicate = await processEvent(secondInput);
    expect(duplicate.duplicate).toBe(true);
    expect(manager.requests).toHaveLength(1);
  });
});

