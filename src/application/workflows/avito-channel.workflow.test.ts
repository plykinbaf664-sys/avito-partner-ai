import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtractMessageResult } from "@/application/extraction/extract-message";
import type { ProviderDeliveryResult } from "@/application/ports/channels";
import type { ExtractedFacts, ExtractedMessage } from "@/domain/extraction/extracted-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import type { AvitoApiClient } from "@/integrations/avito/avito-api-client";
import { AvitoOutboundMessageProvider } from "@/integrations/avito/avito-outbound-message-provider";
import type { TelegramTextSender } from "@/integrations/telegram/telegram-bot-api-client";
import { TelegramManagerNotificationProvider } from "@/integrations/telegram/telegram-manager-notification-provider";

import { createIncomingEventProcessor } from "./process-incoming-event";

function extraction(
  facts: Partial<ExtractedFacts>,
  wantsHuman = false,
): ExtractMessageResult {
  const value: ExtractedMessage = {
    intent: wantsHuman ? "WANTS_HUMAN" : "QUALIFICATION_INFORMATION",
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
      ...facts,
    },
    signals: {
      questions: [],
      objections: [],
      possiblePrimaryFear: null,
      possibleSecondaryFear: null,
      wantsHuman,
    },
    confidence: 0.95,
    uncertainty: [],
  };
  return { extraction: value, llm: { model: "fake", inputTokens: 10, outputTokens: 10 } };
}

class RecordingTelegramSender implements TelegramTextSender {
  readonly calls: Array<{ chatId: string; text: string }> = [];
  async sendMessage(chatId: string, text: string): Promise<ProviderDeliveryResult> {
    this.calls.push({ chatId, text });
    return { status: "SENT", externalId: `telegram-${this.calls.length}` };
  }
}

describe("full local Avito channel workflow", () => {
  let persistence: SqlitePersistence;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:");
  });
  afterEach(() => persistence.close());

  it("persists a multi-turn Avito lead, replies, hands off once, and exposes it to CRM", async () => {
    const now = new Date("2026-09-11T10:00:00.000Z");
    await persistence.telegramManagerRecipients.upsertAuthorized({
      id: "manager-1",
      telegramChatId: "1001",
      telegramUserId: "1001",
      username: null,
      firstName: "Менеджер",
      isActive: true,
      authorizedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const avitoClient = {
      sendTextMessage: vi.fn()
        .mockResolvedValueOnce("avito-out-1")
        .mockResolvedValueOnce("avito-out-2"),
    };
    const telegram = new RecordingTelegramSender();
    const replies = [
      extraction({
        city: "Химки",
        availableCapital: 200_000,
        availableCapitalConfirmed: true,
        capitalScope: "TOTAL_LIMIT",
        additionalExpensesReadiness: "READY",
        businessModelReadiness: "ACCEPTS",
        startingUnits: 1,
        primaryGoal: "ADDITIONAL_INCOME",
        launchTiming: "READY_NOW",
        managementReadiness: "READY",
      }),
      extraction({ phoneNumber: "+79991234567", phoneConfirmed: true }, true),
    ];
    let generated = 0;
    const process = createIncomingEventProcessor({
      persistence,
      extractMessage: async () => replies.shift()!,
      outboundProvider: new AvitoOutboundMessageProvider(
        avitoClient as unknown as AvitoApiClient,
      ),
      managerNotificationProvider: new TelegramManagerNotificationProvider(
        { botToken: "unused" },
        persistence,
        fetch,
        () => now,
        () => `telegram-delivery-${++generated}`,
        telegram,
      ),
      now: () => now,
      generateId: () => `generated-${++generated}`,
    });
    const first = await process({
      source: "AVITO",
      externalEventId: "avito-message-1",
      externalLeadId: "avito-chat-1",
      messageId: "avito-message-1",
      text: "Я из Химок, есть 200 тысяч, хочу начать с одной сейчас",
    });
    const secondInput = {
      source: "AVITO",
      externalEventId: "avito-message-2",
      externalLeadId: "avito-chat-1",
      messageId: "avito-message-2",
      text: "Мой номер +7 999 123-45-67, передайте Дмитрию",
    };
    const second = await process(secondInput);
    await process(secondInput);

    expect(first.leadId).toBe(second.leadId);
    expect(second.shouldHandoffToManager).toBe(true);
    expect(avitoClient.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0]).toMatchObject({ chatId: "1001" });
    const lead = await persistence.leads.findById(second.leadId!);
    expect(lead).toMatchObject({
      source: "AVITO",
      externalLeadId: "avito-chat-1",
      phoneNumber: "+79991234567",
      handoffAt: now,
    });
    await expect(persistence.crm.findLeadSnapshot(second.leadId!)).resolves
      .toMatchObject({ lead: { source: "AVITO", phoneNumber: "+79991234567" } });
    await expect(
      persistence.managerNotifications.findByIdempotencyKey(
        `manager-handoff:${second.leadId}`,
      ),
    ).resolves.toMatchObject({ deliveryStatus: "SENT" });
  });
});

