import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createManagerNotificationDelivery } from "@/application/delivery/deliver-manager-notification";
import type {
  ManagerNotificationRequest,
  ProviderDeliveryResult,
} from "@/application/ports/channels";
import { createTelegramManagerUpdateProcessor } from "@/application/workflows/process-telegram-manager-update";
import type { Conversation } from "@/domain/conversation/conversation";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";
import type { Lead } from "@/domain/lead/lead";
import type { ManagerNotification } from "@/domain/notification/manager-notification";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";

import type { TelegramTextSender } from "./telegram-bot-api-client";
import {
  formatTelegramManagerCard,
  TelegramManagerNotificationProvider,
} from "./telegram-manager-notification-provider";

const timestamp = new Date("2026-09-10T10:00:00.000Z");

function request(
  notificationId = "notification-1",
  overrides: Partial<ManagerSummary> = {},
): ManagerNotificationRequest {
  return {
    notificationId,
    leadId: "lead-1",
    conversationId: "conversation-1",
    qualificationStatus: "HOT",
    idempotencyKey: `manager-handoff:${notificationId}`,
    createdAt: timestamp,
    summary: {
      name: "Александр <script>",
      phoneNumber: "+79991234567",
      segment: "SMALL_BUSINESS",
      city: "Химки",
      availableCapital: 160_000,
      startingUnits: 1,
      scalingPotentialUnits: 5,
      launchTiming: "WITHIN_MONTH",
      goal: "ADDITIONAL_INCOME",
      financialReadiness: "HIGH",
      primaryBarrier: null,
      secondaryBarrier: null,
      objections: [],
      questions: [],
      recommendedNextStep: "Связаться и обсудить запуск.",
      ...overrides,
    } as ManagerSummary,
  };
}

class RecordingSender implements TelegramTextSender {
  readonly calls: Array<{ chatId: string; text: string }> = [];

  constructor(
    private readonly response: (
      chatId: string,
      attempt: number,
    ) => ProviderDeliveryResult = (_chatId, attempt) => ({
      status: "SENT",
      externalId: String(attempt),
    }),
  ) {}

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<ProviderDeliveryResult> {
    this.calls.push({ chatId, text });
    return this.response(chatId, this.calls.length);
  }
}

async function seedNotification(
  persistence: SqlitePersistence,
  notificationRequest: ManagerNotificationRequest,
): Promise<void> {
  if (!(await persistence.leads.findById("lead-1"))) {
    const lead: Lead = {
      id: "lead-1",
      source: "test",
      externalLeadId: "external-lead-1",
      name: null,
      contact: null,
      phoneNumber: null,
      phoneConfirmed: false,
      city: null,
      serviceability: "NEEDS_REVIEW",
      budget: null,
      budgetConfirmed: false,
      availableCapital: null,
      availableCapitalConfirmed: false,
      entryBudget: null,
      additionalLaunchCapital: null,
      capitalScope: "UNKNOWN",
      additionalExpensesReadiness: "UNKNOWN",
      businessModelReadiness: "UNKNOWN",
      segment: "UNDETERMINED",
      segmentConfidence: 0,
      startingUnits: null,
      scalingPotentialUnits: null,
      hasFreeTime: null,
      availableTimeDetails: null,
      businessExperience: null,
      shortTermRentalExperience: null,
      ownsProperty: null,
      desiredIncome: null,
      primaryGoal: null,
      primaryFear: null,
      secondaryFear: null,
      launchTiming: null,
      managementReadiness: null,
      requiresGuaranteedIncome: null,
      rejectsBusinessModel: null,
      questions: [],
      objections: [],
      buyingIntent: null,
      qualificationStatus: "HOT",
      qualificationReason: null,
      conversationSummary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      handoffAt: timestamp,
    };
    const conversation: Conversation = {
      id: "conversation-1",
      leadId: lead.id,
      state: "QUALIFIED",
      summary: null,
      pendingInformationNeed: null,
      lastInboundAt: timestamp,
      lastOutboundAt: timestamp,
      awaitingUserReply: false,
      qualificationCompleted: true,
      followUpEligibleAt: null,
      followUpCount: 0,
      lastFollowUpAt: null,
      nextInboundSequence: 1,
      lastAppliedInboundSequence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    };
    await persistence.leads.insert(lead);
    await persistence.conversations.insert(conversation);
  }
  const notification: ManagerNotification = {
    id: notificationRequest.notificationId,
    leadId: notificationRequest.leadId,
    conversationId: notificationRequest.conversationId,
    qualificationStatus: notificationRequest.qualificationStatus,
    summary: notificationRequest.summary,
    idempotencyKey: notificationRequest.idempotencyKey,
    deliveryStatus: "PENDING",
    deliveryAttempts: 0,
    deliveryRetryable: null,
    lastDeliveryErrorCode: null,
    externalNotificationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    sentAt: null,
  };
  await persistence.managerNotifications.insertIfAbsent(notification);
}

function update(updateId: number, chatId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      text,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, username: `manager${chatId}`, first_name: "Manager" },
    },
  };
}

describe("Telegram manager notifications", () => {
  let persistence: SqlitePersistence;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:");
  });
  afterEach(() => persistence.close());

  it("registers two managers, deduplicates cards, and honors /stop", async () => {
    const sender = new RecordingSender();
    const processUpdate = createTelegramManagerUpdateProcessor({
      persistence,
      sender,
      inviteCode: "valid_invite_code_123",
      now: () => timestamp,
      generateId: (() => {
        let id = 0;
        return () => `recipient-${++id}`;
      })(),
    });
    await processUpdate(update(1, 101, "/start"));
    await processUpdate(update(2, 101, "valid_invite_code_123"));
    await processUpdate(update(3, 202, "/start"));
    await processUpdate(update(4, 202, "valid_invite_code_123"));

    const provider = new TelegramManagerNotificationProvider(
      { botToken: "unused" },
      persistence,
      fetch,
      () => timestamp,
      (() => {
        let id = 0;
        return () => `delivery-${++id}`;
      })(),
      sender,
    );
    const first = request("notification-1");
    await seedNotification(persistence, first);
    await expect(provider.notify(first)).resolves.toMatchObject({ status: "SENT" });
    await expect(provider.notify(first)).resolves.toMatchObject({ status: "SENT" });

    await processUpdate(update(5, 202, "/stop"));
    const second = request("notification-2");
    await seedNotification(persistence, second);
    await expect(provider.notify(second)).resolves.toMatchObject({ status: "SENT" });

    const cards = sender.calls.filter(({ text }) => text.startsWith("🔥"));
    expect(cards.map(({ chatId }) => chatId)).toEqual(["101", "202", "101"]);
    await expect(
      persistence.telegramManagerRecipients.listActive(),
    ).resolves.toHaveLength(1);
  });

  it("does not register a wrong invite code and deduplicates Telegram updates", async () => {
    const sender = new RecordingSender();
    const processUpdate = createTelegramManagerUpdateProcessor({
      persistence,
      sender,
      inviteCode: "valid_invite_code_123",
      now: () => timestamp,
      generateId: () => "recipient-1",
    });
    await expect(processUpdate(update(10, 303, "/start"))).resolves.toBe(
      "INVITE_REQUESTED",
    );
    await expect(processUpdate(update(11, 303, "wrong"))).resolves.toBe(
      "INVALID_INVITE",
    );
    await expect(processUpdate(update(12, 303, "/status"))).resolves.toBe(
      "STATUS",
    );
    await expect(processUpdate(update(12, 303, "/status"))).resolves.toBe(
      "DUPLICATE",
    );
    await expect(
      persistence.telegramManagerRecipients.listActive(),
    ).resolves.toHaveLength(0);
    expect(sender.calls).toHaveLength(3);
    expect(sender.calls[2]?.text).toContain("выключены");
  });

  it("retries only the failed recipient", async () => {
    for (const chatId of ["101", "202"]) {
      await persistence.telegramManagerRecipients.upsertAuthorized({
        id: `recipient-${chatId}`,
        telegramChatId: chatId,
        telegramUserId: chatId,
        username: null,
        firstName: null,
        isActive: true,
        authorizedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    let bAttempts = 0;
    const sender = new RecordingSender((chatId, attempt) => {
      if (chatId === "202" && ++bAttempts === 1) {
        return {
          status: "FAILED",
          retryable: true,
          errorCode: "TELEGRAM_HTTP_503",
        };
      }
      return { status: "SENT", externalId: String(attempt) };
    });
    const provider = new TelegramManagerNotificationProvider(
      { botToken: "unused" },
      persistence,
      fetch,
      () => timestamp,
      (() => {
        let id = 0;
        return () => `delivery-${++id}`;
      })(),
      sender,
    );
    const notification = request();
    await seedNotification(persistence, notification);

    await expect(provider.notify(notification)).resolves.toMatchObject({
      status: "FAILED",
      retryable: true,
    });
    await expect(provider.notify(notification)).resolves.toMatchObject({
      status: "SENT",
    });
    expect(sender.calls.map(({ chatId }) => chatId)).toEqual(["101", "202", "202"]);
  });

  it("does not consume attempts when no manager is active", async () => {
    const notificationRequest = request();
    await seedNotification(persistence, notificationRequest);
    const provider = new TelegramManagerNotificationProvider(
      { botToken: "unused" },
      persistence,
      fetch,
      () => timestamp,
      () => "delivery-id",
      new RecordingSender(),
    );
    const delivered = await createManagerNotificationDelivery({
      persistence,
      provider,
      now: () => timestamp,
    })(notificationRequest.notificationId);
    expect(delivered).toMatchObject({
      deliveryStatus: "FAILED",
      deliveryAttempts: 0,
      deliveryRetryable: true,
      lastDeliveryErrorCode: "TELEGRAM_NO_ACTIVE_RECIPIENTS",
    });
  });

  it("does not send an old HOT notification to a manager authorized later", async () => {
    const notificationRequest = request();
    await seedNotification(persistence, notificationRequest);
    await persistence.telegramManagerRecipients.upsertAuthorized({
      id: "recipient-new",
      telegramChatId: "404",
      telegramUserId: "404",
      username: null,
      firstName: null,
      isActive: true,
      authorizedAt: new Date(timestamp.getTime() + 1_000),
      createdAt: new Date(timestamp.getTime() + 1_000),
      updatedAt: new Date(timestamp.getTime() + 1_000),
    });
    const sender = new RecordingSender();
    const provider = new TelegramManagerNotificationProvider(
      { botToken: "unused" },
      persistence,
      fetch,
      () => new Date(timestamp.getTime() + 2_000),
      () => "delivery-id",
      sender,
    );

    await expect(provider.notify(notificationRequest)).resolves.toMatchObject({
      status: "FAILED",
      attempted: false,
      errorCode: "TELEGRAM_NO_ACTIVE_RECIPIENTS",
    });
    expect(sender.calls).toHaveLength(0);
  });

  it("omits empty fields and uses safe plain text", () => {
    const card = formatTelegramManagerCard(
      request("notification-1", { city: null, scalingPotentialUnits: null }),
    );
    expect(card).not.toContain("Город:");
    expect(card).not.toContain("Потенциал:");
    expect(card).toContain("Александр <script>");
    expect(card.length).toBeLessThanOrEqual(3_500);
  });
});
