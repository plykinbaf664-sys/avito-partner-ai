import { MAX_EXTERNAL_DELIVERY_ATTEMPTS } from "@/application/delivery/retry-policy";
import type {
  ManagerNotificationProvider,
  ManagerNotificationRequest,
  ProviderDeliveryResult,
} from "@/application/ports/channels";
import type { Persistence } from "@/application/ports/repositories";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";
import type { TelegramManagerDelivery } from "@/domain/notification/telegram-manager-delivery";
import { generateId, type IdGenerator } from "@/shared/id";

import {
  TelegramBotApiClient,
  type TelegramTextSender,
} from "./telegram-bot-api-client";

export interface TelegramManagerNotificationConfig {
  botToken: string;
  timeoutMs?: number;
  deliveryClaimTimeoutMs?: number;
}

function compact(value: unknown, maxLength = 500): string {
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function addLine(lines: string[], label: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  lines.push(`${label}: ${compact(value)}`);
}

function formatMoney(value: number | null): string | null {
  return value === null
    ? null
    : `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
}

const segmentLabels: Record<string, string> = {
  SMALL_BUSINESS: "малый бизнес",
  INVESTOR: "инвестор",
  UNDETERMINED: "не определён",
};

export function formatTelegramManagerCard(
  request: ManagerNotificationRequest,
): string {
  const { summary } = request;
  const lines = ["🔥 Горячий лид"];
  addLine(lines, "Имя", summary.name);
  addLine(lines, "Телефон", summary.phoneNumber);
  lines.push("");
  addLine(lines, "Сегмент", segmentLabels[summary.segment] ?? summary.segment);
  addLine(lines, "Город", summary.city);
  addLine(lines, "Капитал", formatMoney(summary.availableCapital));
  addLine(
    lines,
    "Старт",
    summary.startingUnits === null ? null : `${summary.startingUnits} объект(а)`,
  );
  addLine(
    lines,
    "Потенциал",
    summary.scalingPotentialUnits === null
      ? null
      : `до ${summary.scalingPotentialUnits} объект(ов)`,
  );
  addLine(lines, "Срок", summary.launchTiming);
  addLine(lines, "Финансовая готовность", summary.financialReadiness);
  addLine(lines, "Статус", request.qualificationStatus);
  addLine(lines, "Кратко", compactManagerSummary(summary));
  addLine(lines, "Следующий шаг", summary.recommendedNextStep);
  return lines.join("\n").slice(0, 3_500);
}

function compactManagerSummary(summary: ManagerSummary): string | null {
  const values = [
    summary.goal,
    summary.primaryBarrier,
    summary.secondaryBarrier,
    ...summary.objections.slice(0, 2),
    ...summary.questions.slice(0, 2),
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join("; ") : null;
}

interface RecipientDeliveryResult {
  sent: boolean;
  retryable: boolean;
  errorCode: string | null;
}

export class TelegramManagerNotificationProvider
  implements ManagerNotificationProvider
{
  private readonly sender: TelegramTextSender;
  private readonly claimTimeoutMs: number;

  constructor(
    private readonly config: TelegramManagerNotificationConfig,
    private readonly persistence: Persistence,
    fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly idGenerator: IdGenerator = generateId,
    sender?: TelegramTextSender,
  ) {
    this.sender =
      sender ??
      new TelegramBotApiClient(config.botToken, config.timeoutMs, fetcher);
    this.claimTimeoutMs = config.deliveryClaimTimeoutMs ?? 5 * 60_000;
  }

  async notify(
    notification: ManagerNotificationRequest,
  ): Promise<ProviderDeliveryResult> {
    const recipients = (
      await this.persistence.telegramManagerRecipients.listActive()
    ).filter(
      (recipient) => recipient.authorizedAt.getTime() <= notification.createdAt.getTime(),
    );
    if (recipients.length === 0) {
      return {
        status: "FAILED",
        retryable: true,
        attempted: false,
        errorCode: "TELEGRAM_NO_ACTIVE_RECIPIENTS",
      };
    }

    const text = formatTelegramManagerCard(notification);
    const results = await Promise.all(
      recipients.map(async (recipient) => {
        const current =
          await this.persistence.telegramManagerRecipients.findByChatId(
            recipient.telegramChatId,
          );
        if (!current?.isActive) {
          return { sent: true, retryable: false, errorCode: null };
        }
        return this.deliverToRecipient(
          notification,
          recipient.id,
          recipient.telegramChatId,
          text,
        );
      }),
    );

    if (results.every((result) => result.sent)) {
      return { status: "SENT", externalId: null };
    }
    const retryable = results.some((result) => !result.sent && result.retryable);
    return {
      status: "FAILED",
      retryable,
      errorCode:
        results.find((result) => !result.sent)?.errorCode ??
        "TELEGRAM_RECIPIENT_DELIVERY_FAILED",
    };
  }

  private async deliverToRecipient(
    notification: ManagerNotificationRequest,
    recipientId: string,
    chatId: string,
    text: string,
  ): Promise<RecipientDeliveryResult> {
    const idempotencyKey = `${notification.idempotencyKey}:telegram:${recipientId}`;
    const timestamp = this.now();
    const initial: TelegramManagerDelivery = {
      id: this.idGenerator(),
      managerNotificationId: notification.notificationId,
      recipientId,
      idempotencyKey,
      deliveryStatus: "PENDING",
      deliveryAttempts: 0,
      deliveryRetryable: null,
      lastDeliveryErrorCode: null,
      externalMessageId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      sentAt: null,
    };
    await this.persistence.telegramManagerDeliveries.insertIfAbsent(initial);
    const stored =
      await this.persistence.telegramManagerDeliveries.findByIdempotencyKey(
        idempotencyKey,
      );
    if (!stored) {
      return {
        sent: false,
        retryable: true,
        errorCode: "TELEGRAM_DELIVERY_STATE_MISSING",
      };
    }
    if (stored.deliveryStatus === "SENT") {
      return { sent: true, retryable: false, errorCode: null };
    }
    if (
      stored.deliveryAttempts >= MAX_EXTERNAL_DELIVERY_ATTEMPTS ||
      (stored.deliveryStatus === "FAILED" && stored.deliveryRetryable === false)
    ) {
      return {
        sent: false,
        retryable: false,
        errorCode: stored.lastDeliveryErrorCode ?? "TELEGRAM_RETRY_EXHAUSTED",
      };
    }

    const claimed = await this.persistence.telegramManagerDeliveries.tryClaim(
      stored.id,
      stored.deliveryAttempts,
      timestamp,
      new Date(timestamp.getTime() - this.claimTimeoutMs),
    );
    if (!claimed) {
      const latest =
        await this.persistence.telegramManagerDeliveries.findByIdempotencyKey(
          idempotencyKey,
        );
      return latest?.deliveryStatus === "SENT"
        ? { sent: true, retryable: false, errorCode: null }
        : {
            sent: false,
            retryable: true,
            errorCode: "TELEGRAM_DELIVERY_IN_PROGRESS",
          };
    }

    const result = await this.sender.sendMessage(chatId, text);
    const completedAt = this.now();
    const updated: TelegramManagerDelivery =
      result.status === "SENT"
        ? {
            ...stored,
            deliveryStatus: "SENT",
            deliveryAttempts: stored.deliveryAttempts + 1,
            deliveryRetryable: false,
            lastDeliveryErrorCode: null,
            externalMessageId: result.externalId,
            updatedAt: completedAt,
            sentAt: completedAt,
          }
        : {
            ...stored,
            deliveryStatus: "FAILED",
            deliveryAttempts: stored.deliveryAttempts + 1,
            deliveryRetryable:
              result.retryable &&
              stored.deliveryAttempts + 1 < MAX_EXTERNAL_DELIVERY_ATTEMPTS,
            lastDeliveryErrorCode: result.errorCode,
            updatedAt: completedAt,
          };
    await this.persistence.telegramManagerDeliveries.update(updated);
    return result.status === "SENT"
      ? { sent: true, retryable: false, errorCode: null }
      : {
          sent: false,
          retryable: updated.deliveryRetryable === true,
          errorCode: result.errorCode,
        };
  }
}
