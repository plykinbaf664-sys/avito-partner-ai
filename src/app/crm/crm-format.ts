import type { CrmLeadRecord } from "@/application/crm/crm-record";

export const statusLabels: Record<string, string> = {
  NEW: "Новый",
  QUALIFYING: "Квалификация",
  NEEDS_MORE_INFO: "Требуется информация",
  BORDERLINE: "Пограничный",
  WARM: "Тёплый",
  HOT: "Горячий",
  PRIORITY: "Приоритетный",
  QUALIFIED: "Квалифицирован",
  HANDOFF: "Требуется информация",
  NO_FIT: "Не подходит",
  CLOSED: "Закрыт",
  NURTURE: "Отложен",
};

export const segmentLabels: Record<string, string> = {
  SMALL_BUSINESS: "Малый бизнес",
  INVESTOR: "Инвестор",
  UNDETERMINED: "Не определён",
};

export const notificationLabels: Record<string, string> = {
  PENDING: "Ожидает отправки",
  SENT: "Отправлено",
  FAILED: "Ошибка",
};

export const financialLabels: Record<string, string> = {
  HIGH: "Высокая",
  READY: "Готов",
  BORDERLINE: "Требует уточнения",
  INCOMPATIBLE: "Не совместима с моделью",
  UNKNOWN: "Не выяснена",
};

export const launchTimingLabels: Record<string, string> = {
  READY_NOW: "Готов сейчас",
  WITHIN_MONTH: "В течение месяца",
  WITHIN_THREE_MONTHS: "В течение трёх месяцев",
  LATER: "Позже",
  NO_PLANS: "Запуск не планирует",
  UNKNOWN: "Не выяснен",
};

export const buyingIntentLabels: Record<string, string> = {
  DECLINED: "Отказался",
  GENERAL_INTEREST: "Интересуется запуском",
  WANTS_HUMAN: "Просит связаться",
};

export function qualificationLabel(record: CrmLeadRecord): string {
  return record.waitingForPhone && ["HOT", "PRIORITY", "QUALIFIED"].includes(record.qualificationStatus)
    ? "Квалифицирован" : statusLabels[record.qualificationStatus] ?? record.qualificationStatus;
}

export function handoffLabel(record: CrmLeadRecord): string {
  if (record.handoffAt && !record.shouldHandoffToManager) return "Передан ранее без телефона";
  if (record.shouldHandoffToManager) return "Передан менеджеру";
  return record.waitingForPhone ? "Ожидает телефон" : "Не передан";
}

export function notificationLabel(record: CrmLeadRecord): string {
  return record.managerNotificationStatus
    ? notificationLabels[record.managerNotificationStatus]
    : "Не отправлялось";
}

export function money(value: number | null): string {
  return value === null ? "" : `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
}

export function dateTime(value: Date | null): string {
  return value
    ? new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Europe/Moscow",
      }).format(value)
    : "";
}
