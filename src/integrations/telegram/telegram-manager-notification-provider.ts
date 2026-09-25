import { MAX_EXTERNAL_DELIVERY_ATTEMPTS } from "@/application/delivery/retry-policy";
import type {
  ManagerNotificationProvider,
  ManagerNotificationRequest,
  ProviderDeliveryResult,
} from "@/application/ports/channels";
import type { Persistence } from "@/application/ports/repositories";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";
import type { Lead } from "@/domain/lead/lead";
import { hasConfirmedPhone } from "@/domain/qualification/qualification-policy";
import { silentLogger, type StructuredLogger } from "@/application/observability/structured-logger";
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
  logger?: StructuredLogger;
}

function compact(value: unknown, maxLength = 500): string {
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function addLine(lines: string[], label: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  lines.push(`${label}: ${compact(value, 240)}`);
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

const timingLabels: Record<string, string> = {
  READY_NOW: "готов сейчас", WITHIN_MONTH: "в течение месяца",
  WITHIN_THREE_MONTHS: "в течение трёх месяцев", LATER: "позже",
  NO_PLANS: "запуск не планирует", UNKNOWN: "Не указано",
};
const goalLabels: Record<string, string> = {
  EARN_INCOME: "зарабатывать (формат дохода не уточнён)", ADDITIONAL_INCOME: "дополнительный доход", MAIN_BUSINESS: "основной бизнес",
  LEAVE_EMPLOYMENT: "уйти из найма", INVESTMENT: "инвестиции",
  SCALE_EXISTING_BUSINESS: "масштабирование бизнеса", USE_OWN_PROPERTY: "использовать свою недвижимость",
  RECOVER_PREVIOUS_FAILURE: "новый запуск после неудачного опыта", UNKNOWN: "Не указано",
};
const qualificationLabels: Record<string, string> = {
  QUALIFIED: "квалифицирован", PRIORITY: "приоритетный", HOT: "горячий",
  WARM: "тёплый", BORDERLINE: "пограничный", NURTURE: "отложенный",
};
const financialReadinessLabels: Record<string, string> = {
  HIGH: "высокая", READY: "подтверждена", BORDERLINE: "пограничная",
  INCOMPATIBLE: "не соответствует", UNKNOWN: "не выяснена",
};
const buyingIntentLabels: Record<string, string> = {
  GENERAL_INTEREST: "общий интерес", EXPLORING: "изучает",
  CONSIDERING: "рассматривает", CONDITIONS_ACCEPTED: "условия подходят",
  READY_TO_START: "готов начинать", WANTS_NEXT_STEP: "хочет следующий шаг",
  WANTS_HUMAN: "хочет поговорить с человеком", DECLINED: "отказался",
  UNKNOWN: "не выяснено",
};
const financialBarrierLabels: Record<string, string> = {
  ADDITIONAL_LAUNCH_CAPITAL_UNKNOWN: "не подтверждён полный капитал запуска",
  UNWILLING_TO_FUND_REQUIRED_EXPENSES: "не готов финансировать расходы объекта",
  CAPITAL_BELOW_LAUNCH_RANGE: "капитал ниже расчётного диапазона запуска",
};
const barrierLabels: Record<string, string> = {
  FEAR_LOSE_MONEY: "опасается потерять деньги", FEAR_LOW_DEMAND: "сомневается в спросе",
  FEAR_NO_PROPERTY: "сложно найти объект", FEAR_OPERATIONAL_LOAD: "опасается операционной нагрузки",
  FEAR_GUEST_PROBLEMS: "опасается проблем с гостями", FEAR_LEGAL: "юридические опасения",
  FEAR_NO_EXPERIENCE: "не хватает опыта", FEAR_DISTRUST_NUMBERS: "сомневается в расчётах",
  FEAR_PLATFORM_DEPENDENCY: "опасается зависимости от площадок", FEAR_PREVIOUS_FAILURE: "был неудачный опыт",
};

export function formatTelegramManagerCard(
  request: ManagerNotificationRequest,
  origin?: Pick<Lead, "source" | "externalLeadId">,
): string {
  const { summary } = request;
  const lines = ["🔥 Новый квалифицированный лид"];
  addLine(lines, "Имя", summary.name);
  addLine(lines, "Телефон", summary.phoneNumber);
  lines.push("");
  addLine(lines, "Статус", qualificationLabels[summary.qualificationStatus] ?? summary.qualificationStatus);
  addLine(lines, "Сегмент", segmentLabels[summary.segment] ?? "Не указано");
  addLine(lines, "Город", summary.city);
  addLine(lines, "Капитал", formatMoney(summary.availableCapital));
  addLine(lines, "Финансовая готовность", financialReadinessLabels[summary.financialReadiness] ?? "не выяснена");
  addLine(
    lines,
    "Стартовый объём",
    summary.startingUnits === null ? null : `${summary.startingUnits} объект(а)`,
  );
  addLine(
    lines,
    "Потенциал масштабирования",
    summary.scalingPotentialUnits === null
      ? null
      : `до ${summary.scalingPotentialUnits} объект(ов)`,
  );
  addLine(lines, "Срок запуска", timingLabels[summary.launchTiming ?? "UNKNOWN"] ?? "Не указано");
  addLine(lines, "Цель", goalLabels[summary.goal ?? "UNKNOWN"] ?? "Не указано");
  addLine(lines, "Желаемый доход", formatMoney(summary.desiredIncome));
  addLine(lines, "Намерение", buyingIntentLabels[summary.buyingIntent ?? "UNKNOWN"] ?? "не выяснено");
  addLine(lines, "Доступное время", summary.availableTime);
  addLine(lines, "Ключевые факты", compactManagerSummary(summary));
  const concerns = [
    ...summary.questions, ...summary.objections,
    barrierLabels[summary.primaryBarrier ?? ""], barrierLabels[summary.secondaryBarrier ?? ""],
    financialBarrierLabels[summary.financialBarrier ?? ""],
  ].filter(Boolean);
  addLine(lines, "Вопросы / возражения", [...new Set(concerns)].slice(0, 4).join("; "));
  addLine(lines, "Почему квалифицирован", summary.qualificationRationale);
  addLine(lines, "Следующий шаг", summary.recommendedNextStep);
  addLine(lines, "Источник", origin?.source.toLowerCase() === "avito" ? "Avito" : origin?.source ?? "Не указано");
  addLine(lines, "ID диалога", origin?.externalLeadId ?? "Не указано");
  return lines.join("\n").slice(0, 3_500);
}

function compactManagerSummary(summary: ManagerSummary): string | null {
  const values = [
    summary.businessModelReadiness === "ACCEPTS" ? "модель бизнеса принимает" : null,
    summary.additionalExpensesReadiness === "READY" ? "готов к дополнительным расходам" : null,
    summary.businessExperience ? `опыт: ${compact(summary.businessExperience, 70)}` : null,
    summary.shortTermRentalExperience ? `опыт посуточной аренды: ${compact(summary.shortTermRentalExperience, 70)}` : null,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join("; ") : null;
}

interface RecipientDeliveryResult {
  sent: boolean;
  retryable: boolean;
  errorCode: string | null;
  attempted?: boolean;
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
    // Read the authoritative Lead, including for notifications queued before the
    // phone-before-handoff policy was introduced. Never trust an old summary phone.
    const lead = await this.persistence.leads.findById(notification.leadId);
    if (!lead?.handoffAt || lead.qualificationStatus === "NO_FIT" ||
        notification.qualificationStatus === "NO_FIT" || !hasConfirmedPhone(lead)) {
      return { status: "FAILED", retryable: false, attempted: false,
        errorCode: "TELEGRAM_HANDOFF_NOT_ELIGIBLE" };
    }
    const recipients = (
      await this.persistence.telegramManagerRecipients.listActive()
    ).filter(
      (recipient) => recipient.authorizedAt.getTime() <= notification.createdAt.getTime(),
    );
    if (recipients.length === 0) {
      return {
        status: "FAILED",
        retryable: false,
        attempted: false,
        errorCode: "TELEGRAM_NO_ACTIVE_RECIPIENTS",
      };
    }

    const text = formatTelegramManagerCard({ ...notification,
      summary: { ...notification.summary, phoneNumber: lead.phoneNumber } }, lead);
    const settled = await Promise.allSettled(
      recipients.map(async (recipient) => {
        const current =
          await this.persistence.telegramManagerRecipients.findByChatId(
            recipient.telegramChatId,
          );
        if (!current?.isActive || current.authorizedAt > notification.createdAt) {
          return { sent: true, retryable: false, errorCode: null, attempted: false };
        }
        return this.deliverToRecipient(
          notification,
          recipient.id,
          recipient.telegramChatId,
          text,
        );
      }),
    );
    const results: RecipientDeliveryResult[] = settled.map((result) => result.status === "fulfilled"
      ? result.value : { sent: false, retryable: true, errorCode: "TELEGRAM_RECIPIENT_DELIVERY_FAILED" });

    if (results.every((result) => result.sent)) {
      return { status: "SENT", externalId: null };
    }
    const retryable = results.some((result) => !result.sent && result.retryable);
    return {
      status: "FAILED",
      retryable,
      attempted: results.some((result) => result.attempted !== false),
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
      return { sent: true, retryable: false, errorCode: null, attempted: false };
    }
    if (
      stored.deliveryAttempts >= MAX_EXTERNAL_DELIVERY_ATTEMPTS ||
      (stored.deliveryStatus === "FAILED" && stored.deliveryRetryable === false)
    ) {
      return {
        sent: false,
        retryable: false,
        errorCode: stored.lastDeliveryErrorCode ?? "TELEGRAM_RETRY_EXHAUSTED",
        attempted: false,
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
        ? { sent: true, retryable: false, errorCode: null, attempted: false }
        : {
            sent: false,
            retryable: true,
            errorCode: "TELEGRAM_DELIVERY_IN_PROGRESS",
            attempted: false,
          };
    }

    let result: ProviderDeliveryResult;
    try {
      result = await this.sender.sendMessage(chatId, text);
    } catch {
      result = { status: "FAILED", retryable: true, errorCode: "TELEGRAM_SENDER_ERROR" };
    }
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
    const logger = this.config.logger ?? silentLogger;
    logger[result.status === "SENT" ? "info" : "error"](
      result.status === "SENT" ? "telegram_manager_delivery.sent" : "telegram_manager_delivery.failed",
      { notificationId: notification.notificationId, leadId: notification.leadId, recipientId,
        providerMessageId: updated.externalMessageId, attempts: updated.deliveryAttempts,
        errorCode: updated.lastDeliveryErrorCode, retryable: updated.deliveryRetryable,
        latencyMs: completedAt.getTime() - timestamp.getTime() },
    );
    return result.status === "SENT"
      ? { sent: true, retryable: false, errorCode: null }
      : {
          sent: false,
          retryable: updated.deliveryRetryable === true,
          errorCode: result.errorCode,
        };
  }
}
