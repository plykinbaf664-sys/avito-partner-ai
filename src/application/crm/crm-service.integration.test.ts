import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Lead } from "@/domain/lead/lead";
import type { Conversation } from "@/domain/conversation/conversation";
import type { ManagerNotification } from "@/domain/notification/manager-notification";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { createCrmCsv } from "./csv-export";
import { createCrmService } from "./crm-service";

const now = new Date("2026-09-09T10:00:00.000Z");

function lead(index: number, overrides: Partial<Lead> = {}): Lead {
  return {
    id: `lead-${index}`,
    source: "test",
    externalLeadId: `external-${index}`,
    name: index === 1 ? 'Иван, "тест"' : null,
    contact: null,
    phoneNumber: index === 1 ? "+79991234567" : null,
    phoneConfirmed: index === 1,
    city: index === 1 ? "Химки" : null,
    serviceability: index === 1 ? "SUPPORTED" : "NEEDS_REVIEW",
    budget: null,
    budgetConfirmed: false,
    availableCapital: index === 1 ? 160_000 : null,
    availableCapitalConfirmed: index === 1,
    entryBudget: index === 1 ? 50_000 : null,
    additionalLaunchCapital: index === 1 ? 110_000 : null,
    capitalScope: index === 1 ? "ADDITIONAL_AVAILABLE" : "UNKNOWN",
    additionalExpensesReadiness: index === 1 ? "READY" : "UNKNOWN",
    businessModelReadiness: index === 1 ? "ACCEPTS" : "UNKNOWN",
    segment: index === 1 ? "SMALL_BUSINESS" : "UNDETERMINED",
    segmentConfidence: index === 1 ? 0.9 : 0,
    startingUnits: index === 1 ? 1 : null,
    scalingPotentialUnits: index === 1 ? 5 : null,
    hasFreeTime: null,
    availableTimeDetails: null,
    businessExperience: null,
    shortTermRentalExperience: null,
    ownsProperty: null,
    desiredIncome: null,
    primaryGoal: index === 1 ? "ADDITIONAL_INCOME" : null,
    primaryFear: null,
    secondaryFear: null,
    launchTiming: index === 1 ? "WITHIN_MONTH" : null,
    managementReadiness: index === 1 ? "READY" : null,
    requiresGuaranteedIncome: null,
    rejectsBusinessModel: null,
    questions: [],
    objections: [],
    buyingIntent: null,
    qualificationStatus: index === 1 ? "HOT" : "QUALIFYING",
    qualificationReason: index === 1 ? "SMALL_BUSINESS_READY" : null,
    conversationSummary: null,
    createdAt: new Date(now.getTime() + index),
    updatedAt: new Date(now.getTime() + index),
    handoffAt: index === 1 ? now : null,
    ...overrides,
  };
}

function conversation(leadId: string): Conversation {
  return {
    id: `conversation-${leadId}`,
    leadId,
    state: "QUALIFIED",
    summary: null,
    pendingInformationNeed: null,
    lastInboundAt: now,
    lastOutboundAt: now,
    awaitingUserReply: false,
    qualificationCompleted: true,
    followUpEligibleAt: null,
    followUpCount: 0,
    lastFollowUpAt: null,
    nextInboundSequence: 1,
    lastAppliedInboundSequence: 1,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}

describe("local CRM read model", () => {
  let persistence: SqlitePersistence;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated(
      "file::memory:",
      resolve(process.cwd(), "drizzle"),
    );
  });
  afterEach(() => persistence.close());

  it("lists, searches and paginates leads without loading all conversations", async () => {
    for (let index = 1; index <= 51; index += 1) {
      await persistence.leads.insert(lead(index));
    }
    await persistence.conversations.insert(conversation("lead-1"));
    const notification: ManagerNotification = {
      id: "notification-1",
      leadId: "lead-1",
      conversationId: "conversation-lead-1",
      qualificationStatus: "HOT",
      summary: { phoneNumber: "+79991234567" } as ManagerSummary,
      idempotencyKey: "manager-handoff:lead-1",
      deliveryStatus: "SENT",
      deliveryAttempts: 1,
      deliveryRetryable: false,
      lastDeliveryErrorCode: null,
      externalNotificationId: "42",
      createdAt: now,
      updatedAt: now,
      sentAt: now,
    };
    await persistence.managerNotifications.insertIfAbsent(notification);
    const service = createCrmService(persistence);

    const firstPage = await service.listLeads();
    expect(firstPage.records).toHaveLength(50);
    expect(firstPage).toMatchObject({ total: 51, totalPages: 2 });
    const searched = await service.listLeads({ search: "999123" });
    expect(searched.records).toHaveLength(1);
    expect(searched.records[0]).toMatchObject({
      leadId: "lead-1",
      phoneNumber: "+79991234567",
      qualificationStatus: "HOT",
      managerNotificationStatus: "SENT",
    });
    expect(
      (await service.listLeads({ search: "+7 999 123-45-67" })).records,
    ).toHaveLength(1);
    expect((await service.listLeads({ filter: "hot" })).total).toBe(1);
  });

  it("loads conversation history only for the selected lead", async () => {
    await persistence.leads.insert(lead(1));
    await persistence.conversations.insert(conversation("lead-1"));
    await persistence.messages.insert({
      id: "message-1",
      conversationId: "conversation-lead-1",
      leadId: "lead-1",
      incomingEventId: null,
      externalMessageId: "external-message-1",
      deduplicationKey: null,
      sequence: 1,
      direction: "INBOUND",
      content: "Мой номер +7 999 123-45-67",
      deliveryStatus: null,
      deliveryAttempts: 0,
      deliveryRetryable: null,
      lastDeliveryErrorCode: null,
      sentAt: null,
      createdAt: now,
    });

    const details = await createCrmService(persistence).getLead("lead-1");
    expect(details?.messages).toHaveLength(1);
    expect(details?.messages[0]?.content).toContain("+7 999");
    expect(details?.phoneNumber).toBe("+79991234567");
  });

  it("exports UTF-8 CSV with correct escaping and no internal data", async () => {
    await persistence.leads.insert(lead(1));
    const records = await createCrmService(persistence).exportLeads();
    const csv = createCrmCsv(records);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"Иван, ""тест"""');
    expect(csv).toContain('"+79991234567"');
    expect(csv).not.toContain("systemPrompt");
  });
});
