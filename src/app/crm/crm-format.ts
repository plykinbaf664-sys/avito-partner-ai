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
  EXPLORING: "Изучает",
  CONSIDERING: "Рассматривает",
  CONDITIONS_ACCEPTED: "Условия подходят",
  READY_TO_START: "Готов начинать",
  WANTS_NEXT_STEP: "Хочет следующий шаг",
  WANTS_HUMAN: "Просит связаться",
  UNKNOWN: "Не выяснено",
};

export const goalLabels: Record<string, string> = {
  EARN_INCOME: "Зарабатывать (формат дохода не уточнён)",
  ADDITIONAL_INCOME: "Дополнительный доход",
  MAIN_BUSINESS: "Основной бизнес",
  LEAVE_EMPLOYMENT: "Уйти из найма",
  INVESTMENT: "Инвестиционный сценарий",
  SCALE_EXISTING_BUSINESS: "Масштабировать бизнес",
  USE_OWN_PROPERTY: "Использовать свою недвижимость",
  RECOVER_PREVIOUS_FAILURE: "Перезапустить после неудачного опыта",
  UNKNOWN: "Не выяснена",
};

export const informationNeedLabels: Record<string, string> = {
  PHONE_NUMBER: "телефон", AVAILABLE_CAPITAL: "финансовая готовность",
  ADDITIONAL_EXPENSES: "готовность к расходам", BUSINESS_MODEL: "готовность к модели",
  CITY: "город", LAUNCH_TIMING: "срок запуска", FREE_TIME: "свободное время",
  MANAGEMENT_READINESS: "готовность взаимодействовать", STARTING_UNITS: "стартовый объём",
  SCALING_POTENTIAL_UNITS: "потенциал масштаба", GOAL: "цель",
  EXPERIENCE: "опыт", BARRIER: "барьер",
};

export function qualificationLabel(record: CrmLeadRecord): string {
  return record.waitingForPhone && ["HOT", "PRIORITY", "QUALIFIED"].includes(record.qualificationStatus)
    ? "Квалифицирован" : statusLabels[record.qualificationStatus] ?? record.qualificationStatus;
}

export function handoffLabel(record: CrmLeadRecord): string {
  if (record.handoffAt && !record.handoffQualificationComplete) return "Передан ранее до завершения квалификации";
  if (record.shouldHandoffToManager) return "Передан менеджеру";
  return record.waitingForPhone ? "Ожидает телефон" : "Не передан";
}

export function notificationLabel(record: CrmLeadRecord): string {
  if (record.managerNotificationStatus && !record.handoffQualificationComplete) {
    return record.managerNotificationStatus === "SENT"
      ? "Отправлено ранее до завершения квалификации"
      : "Создано ранее до завершения квалификации";
  }
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
