export type StatusPeriodKey = "today" | "week" | "all";

export interface BotStatusPeriod {
  key: StatusPeriodKey;
  since: Date;
  startedDialogs: number;
  activeDialogs: number;
  aiAnsweredDialogs: number;
  transferredLeads: number;
  transferredNewDialogs: number;
}

export interface BotStatusSnapshot {
  generatedAt: Date;
  periods: BotStatusPeriod[];
  awaitingPhone: number;
  pendingHandoffs: number;
  failedHandoffs: number;
  pendingInboundEvents: number;
  failedInboundEvents: number;
}

export interface BotStatusReadRepository {
  snapshot(asOf: Date): Promise<BotStatusSnapshot>;
}

const moscowOffsetMs = 3 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

export function statusPeriods(asOf: Date): Array<{ key: StatusPeriodKey; since: Date }> {
  if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid status date");
  const today = Math.floor((asOf.getTime() + moscowOffsetMs) / dayMs) * dayMs - moscowOffsetMs;
  return [
    { key: "today", since: new Date(today) },
    { key: "week", since: new Date(today - 6 * dayMs) },
    { key: "all", since: new Date(0) },
  ];
}

export function formatBotStatus(snapshot: BotStatusSnapshot): string {
  const titles: Record<StatusPeriodKey, string> = {
    today: "Сегодня", week: "Последние 7 дней", all: "Всё время",
  };
  const generatedAt = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short",
  }).format(snapshot.generatedAt);
  const periods = snapshot.periods.map((period) => {
    const conversion = period.startedDialogs === 0 ? "—" :
      new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(
        100 * period.transferredNewDialogs / period.startedDialogs) + "%";
    return [titles[period.key],
      `Начато диалогов: ${period.startedDialogs}`,
      `С входящими сообщениями: ${period.activeDialogs}`,
      `С ответом AI: ${period.aiAnsweredDialogs}`,
      `Передано в Telegram: ${period.transferredLeads}`,
      `Конверсия новых диалогов: ${conversion} (${period.transferredNewDialogs}/${period.startedDialogs})`,
    ].join("\n");
  });
  return [
    `📊 Статистика Avito\n${generatedAt} МСК`,
    ...periods,
    ["Сейчас",
      `Готовы к передаче, нет телефона: ${snapshot.awaitingPhone}`,
      `Передачи: в очереди ${snapshot.pendingHandoffs}, с ошибкой ${snapshot.failedHandoffs}`,
      `Входящие: в обработке ${snapshot.pendingInboundEvents}, с ошибкой ${snapshot.failedInboundEvents}`,
    ].join("\n"),
    "Диалог = уникальный клиент с первым входящим в сохранённой истории. Передано = карточка доставлена хотя бы одному менеджеру; рассылка и повторы не увеличивают счётчик. Конверсия — доля новых диалогов периода, уже переданных к моменту отчёта. Периоды — календарные дни МСК. Тестовые источники не учитываются.",
  ].join("\n\n");
}
