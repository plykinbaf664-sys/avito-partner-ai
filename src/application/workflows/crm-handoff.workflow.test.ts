import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCrmService } from "@/application/crm/crm-service";
import type { ExtractMessageResult } from "@/application/extraction/extract-message";
import type { ExtractedMessage } from "@/domain/extraction/extracted-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { FakeManagerNotificationProvider } from "@/integrations/fake/fake-manager-notification-provider";
import { createIncomingEventProcessor } from "./process-incoming-event";
import { TelegramManagerNotificationProvider } from "@/integrations/telegram/telegram-manager-notification-provider";
import { createPendingManagerNotificationDelivery } from "@/application/delivery/deliver-pending-manager-notifications";
import type { TelegramTextSender } from "@/integrations/telegram/telegram-bot-api-client";

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
        scalingPotentialUnits: 3,
        hasFreeTime: true,
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

  it("delivers a final Avito handoff to every manager, recovers partial failure, and never repeats the card", async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:");
    const timestamp = new Date("2026-09-15T12:00:00Z");
    for (const chatId of ["101", "202"]) {
      await persistence.telegramManagerRecipients.upsertAuthorized({ id: chatId, telegramChatId: chatId,
        telegramUserId: chatId, username: null, firstName: null, isActive: true,
        authorizedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
    }
    let failSecond = true;
    const sendMessage = vi.fn<TelegramTextSender["sendMessage"]>(async (chatId) => {
      if (chatId === "202" && failSecond) {
        failSecond = false;
        return { status: "FAILED", retryable: true, errorCode: "TELEGRAM_HTTP_503" };
      }
      return { status: "SENT", externalId: `message-${chatId}` };
    });
    const manager = new TelegramManagerNotificationProvider({ botToken: "unused" }, persistence,
      fetch, () => timestamp, undefined, { sendMessage });
    const replies = [extraction({ city: "Химки", availableCapital: 180_000, availableCapitalConfirmed: true,
      entryBudget: 50_000, additionalLaunchCapital: 130_000, capitalScope: "ADDITIONAL_AVAILABLE",
      additionalExpensesReadiness: "READY", businessModelReadiness: "ACCEPTS", startingUnits: 1,
      scalingPotentialUnits: 3, hasFreeTime: true,
      launchTiming: "WITHIN_MONTH", managementReadiness: "READY", primaryGoal: "ADDITIONAL_INCOME" }),
      extraction({ phoneNumber: "89991234567", phoneConfirmed: true }), extraction({})];
    const extractMessage = vi.fn(async () => replies.shift()!);
    const processEvent = createIncomingEventProcessor({ persistence, extractMessage,
      managerNotificationProvider: manager, now: () => timestamp });
    const common = { source: "avito", externalLeadId: "test-avito-chat" };
    const first = await processEvent({ ...common, externalEventId: "a1", messageId: "a1", text: "Готов к запуску" });
    expect(first.suggestedNextInformationNeed).toBe("PHONE_NUMBER");
    expect(sendMessage).not.toHaveBeenCalled();
    const phone = { ...common, externalEventId: "a2", messageId: "a2", text: "89991234567" };
    const second = await processEvent(phone);
    expect(second.shouldHandoffToManager).toBe(true);
    const lead = (await persistence.leads.findById(second.leadId!))!;
    expect(lead.phoneNumber).toBe("+79991234567");
    expect(lead.handoffAt).toEqual(timestamp);
    expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual(["101", "202"]);
    const card = sendMessage.mock.calls[0][1];
    expect(card).toContain("Телефон: +79991234567");
    expect(card).toContain("ID диалога: test-avito-chat");
    expect(card).toContain("Сегмент: малый бизнес");
    expect((await processEvent(phone)).duplicate).toBe(true);
    expect(extractMessage).toHaveBeenCalledTimes(2);
    const deliverPending = createPendingManagerNotificationDelivery({ persistence, provider: manager });
    await deliverPending();
    await deliverPending();
    await processEvent({ ...common, externalEventId: "a3", messageId: "a3", text: "Спасибо" });
    expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual(["101", "202", "202"]);
    expect(extractMessage).toHaveBeenCalledTimes(3);
    const notification = (await persistence.managerNotifications.findByIdempotencyKey(`manager-handoff:${lead.id}`))!;
    expect(notification.deliveryStatus).toBe("SENT");
    for (const recipientId of ["101", "202"]) {
      const delivered = await persistence.telegramManagerDeliveries.findByIdempotencyKey(`${notification.idempotencyKey}:telegram:${recipientId}`);
      expect(delivered).toMatchObject({ deliveryStatus: "SENT", externalMessageId: `message-${recipientId}` });
    }
  });
});
