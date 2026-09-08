"use client";

import { useRef, useState, type FormEvent } from "react";

import type {
  InboundErrorResponse,
  InboundSuccessResponse,
} from "../api/inbound/route-handler";
import type { ProcessIncomingEventResult } from "../../application/workflows/process-incoming-event";

const initialMessage =
  "Я из Волгограда, есть 500 тысяч, хочу начать через месяц с пяти квартир и готов участвовать в управлении.";

const enumLabels: Record<string, string> = {
  READY_NOW: "Готов начать сейчас",
  WITHIN_MONTH: "В течение месяца",
  WITHIN_THREE_MONTHS: "В течение трёх месяцев",
  LATER: "Позже",
  NO_PLANS: "Пока не планирует запуск",
  UNKNOWN: "Не выяснено",
  READY: "Готов участвовать",
  LIMITED: "Готов участвовать ограниченно",
  NOT_READY: "Не готов участвовать",
  SUPPORTED: "Поддерживаемый город",
  NEEDS_REVIEW: "Требует уточнения",
  UNSUPPORTED: "Пока не работаем",
  PRIORITY: "Приоритетный лид",
  HOT: "Горячий лид",
  QUALIFIED: "Подходит",
  BORDERLINE: "Пограничный лид",
  NEEDS_MORE_INFO: "Нужно уточнить данные",
  WARM: "Потенциально подходит",
  QUALIFYING: "Квалификация продолжается",
  NURTURE: "Пока не проходит по условиям",
  NO_FIT: "Не прошёл квалификацию",
  HANDOFF: "Передача менеджеру",
  CLOSED: "Закрыт",
  NEW: "Новый",
  ADDITIONAL_INCOME: "Дополнительный доход",
  MAIN_BUSINESS: "Основной бизнес",
  LEAVE_EMPLOYMENT: "Уйти из найма",
  INVESTMENT: "Инвестиционный доход",
  SCALE_EXISTING_BUSINESS: "Масштабировать существующий бизнес",
  USE_OWN_PROPERTY: "Зарабатывать на своей недвижимости",
  RECOVER_PREVIOUS_FAILURE: "Попробовать снова после неудачного опыта",
  FEAR_LOSE_MONEY: "Страх потерять деньги",
  FEAR_LOW_DEMAND: "Сомнение в достаточном спросе",
  FEAR_NO_PROPERTY: "Отсутствие подходящей недвижимости",
  FEAR_OPERATIONAL_LOAD: "Опасение высокой операционной нагрузки",
  FEAR_GUEST_PROBLEMS: "Опасение проблем с гостями",
  FEAR_LEGAL: "Юридические опасения",
  FEAR_NO_EXPERIENCE: "Недостаток опыта",
  FEAR_DISTRUST_NUMBERS: "Недоверие к финансовым расчётам",
  FEAR_PLATFORM_DEPENDENCY: "Опасение зависимости от площадок",
  FEAR_PREVIOUS_FAILURE: "Опасение повторить прошлую неудачу",
  OTHER: "Другое сомнение",
  CITY: "Город",
  AVAILABLE_CAPITAL: "Доступный капитал",
  ADDITIONAL_EXPENSES: "Готовность к расходам по объекту",
  BUSINESS_MODEL: "Готовность работать по модели субаренды",
  LAUNCH_TIMING: "Срок запуска",
  FREE_TIME: "Возможность уделять время",
  MANAGEMENT_READINESS: "Готовность участвовать в процессе",
  STARTING_UNITS: "Число объектов на старте",
  SCALING_POTENTIAL_UNITS: "Потенциал масштабирования",
  GOAL: "Цель человека",
  EXPERIENCE: "Опыт",
  BARRIER: "Основное сомнение / барьер",
  SMALL_BUSINESS: "Малый бизнес",
  INVESTOR: "Инвестор",
  UNDETERMINED: "Сегмент пока не определён",
  NO_LAUNCH_INTENT: "Нет намерения запускаться",
  NO_MANAGEMENT_INTERACTION: "Нет готовности взаимодействовать с управляющей компанией",
  DECLINED_BY_LEAD: "Лид отказался",
  REQUIRES_INCOME_GUARANTEE: "Обязательное требование гарантированного дохода",
  INCOMPATIBLE_BUSINESS_MODEL: "Ожидания не соответствуют модели бизнеса",
  UNWILLING_TO_FUND_REQUIRED_EXPENSES:
    "Нет готовности финансировать обязательные расходы запуска",
  ENTRY_CAPITAL_BELOW_REFERENCE: "Стартовый капитал ниже рабочего ориентира",
  ADDITIONAL_CAPITAL_UNCLEAR: "Не выяснен контекст дополнительных расходов",
  WEAK_LAUNCH_INTENT: "Слабая готовность к запуску",
  LIMITED_OPERATIONAL_CAPACITY: "Ограниченная возможность участвовать",
  CAPITAL_UNKNOWN: "Доступный капитал не выяснен",
  CAPITAL_NOT_CONFIRMED: "Доступный капитал требует подтверждения",
  SEGMENT_UNDETERMINED: "Сегмент пока не определён",
  LAUNCH_INTENT_UNKNOWN: "Нужно уточнить намерение запускаться",
  OPERATIONAL_READINESS_UNKNOWN: "Нужно уточнить готовность участвовать",
  CITY_UNKNOWN: "Город не выяснен",
  REGION_NEEDS_REVIEW: "Нужно уточнить возможность работы в регионе",
  STARTING_UNITS_UNKNOWN: "Стартовое число объектов не выяснено",
  INVESTOR_SCALE_UNKNOWN: "Масштаб инвестора не выяснен",
  GOAL_UNKNOWN: "Цель не выяснена",
  BUSINESS_MODEL_READINESS_UNKNOWN: "Отношение к бизнес-модели не выяснено",
  ADDITIONAL_EXPENSES_CONTEXT_UNKNOWN: "Контекст расходов по объекту не выяснен",
  SMALL_BUSINESS_READY: "Ключевые данные малого бизнеса собраны",
  INVESTOR_READY: "Ключевые данные инвестора собраны",
  INVESTOR_SCALE_CONFIRMED: "Подтверждены капитал и масштаб инвестора",
  USER_REQUESTED_HUMAN: "Человек запросил менеджера",
};

const nextStepLabels: Record<string, string> = {
  CITY: "Следующий шаг: уточнить город, в котором человек планирует запуск.",
  AVAILABLE_CAPITAL: "Следующий шаг: уточнить доступный капитал и контекст суммы.",
  ADDITIONAL_EXPENSES: "Следующий шаг: уточнить готовность учитывать расходы по объекту.",
  BUSINESS_MODEL: "Следующий шаг: уточнить готовность работать в модели субаренды.",
  LAUNCH_TIMING: "Следующий шаг: выяснить желаемый срок запуска бизнеса.",
  FREE_TIME:
    "Следующий шаг: выяснить, сколько времени человек готов уделять запуску и взаимодействию с управляющей компанией.",
  MANAGEMENT_READINESS:
    "Следующий шаг: выяснить готовность человека участвовать в запуске и управлении.",
  STARTING_UNITS: "Следующий шаг: выяснить число объектов на старте.",
  SCALING_POTENTIAL_UNITS: "Следующий шаг: выяснить потенциал масштабирования.",
  GOAL:
    "Следующий шаг: выяснить цель человека — зачем он рассматривает этот бизнес и какой результат хочет получить.",
  EXPERIENCE:
    "Следующий шаг: уточнить опыт человека в бизнесе и посуточной аренде.",
  BARRIER:
    "Следующий шаг: выяснить главное сомнение или препятствие, которое мешает человеку начать.",
};

const apiErrorLabels: Record<string, string> = {
  INVALID_JSON: "Не удалось прочитать отправленные данные.",
  INVALID_INPUT: "Сообщение не прошло проверку. Обновите страницу и попробуйте снова.",
  LLM_UNAVAILABLE: "ИИ-модель временно недоступна. Попробуйте ещё раз.",
  PROCESSING_FAILED: "Не удалось обработать сообщение. Попробуйте ещё раз.",
};

interface DemoInboundRequest {
  source: "demo-ui";
  externalEventId: string;
  externalLeadId: string;
  messageId: string;
  text: string;
}

class ServerConnectionError extends Error {}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function sendInboundRequest(body: DemoInboundRequest): Promise<{
  response: Response;
  payload: InboundSuccessResponse | InboundErrorResponse;
}> {
  const retryDelays = [0, 750, 1_500];
  let lastError: unknown;

  for (const delay of retryDelays) {
    if (delay > 0) await wait(delay);

    try {
      const response = await fetch("/api/inbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const contentType = response.headers.get("content-type") ?? "";

      if (!contentType.includes("application/json")) {
        throw new ServerConnectionError("Server returned a non-JSON response");
      }

      return {
        response,
        payload: (await response.json()) as
          | InboundSuccessResponse
          | InboundErrorResponse,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new ServerConnectionError("Server connection failed", {
    cause: lastError,
  });
}

function displayEnum(value: string | null | undefined): string {
  if (!value) return "Не выяснено";
  return enumLabels[value] ?? "Не выяснено";
}

function displayValue(value: string | number | null | undefined): string {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "UNKNOWN"
  ) {
    return "Не выяснено";
  }
  return String(value);
}

function displayBudget(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Не выяснен";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function displayGoal(value: string | null | undefined): string {
  if (!value || value === "UNKNOWN") return "Не выяснена";
  return enumLabels[value] ?? "Не выяснена";
}

function displayBoolean(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "Не выяснено";
  return value ? "Да" : "Нет";
}

function displayExperience(
  businessExperience: string | null | undefined,
  rentalExperience: string | null | undefined,
): string {
  const values = [businessExperience, rentalExperience].filter(
    (value): value is string => Boolean(value) && value !== "UNKNOWN",
  );
  return values.length > 0 ? values.join("; ") : "Не выяснен";
}

function displayDuration(milliseconds: number): string {
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(milliseconds / 1_000)} сек.`;
}

function displayNextStep(
  value: string | null,
  nextAction: ProcessIncomingEventResult["nextAction"],
): string {
  if (nextAction === "REJECT_POLITELY") {
    return "Следующий шаг: корректно завершить квалификацию без передачи менеджеру.";
  }
  if (nextAction === "HANDOFF_TO_MANAGER") {
    return "Следующий шаг: передать подготовленный контекст менеджеру.";
  }
  if (!value) return "Основные сведения собраны. Следующий шаг пока не требуется.";
  return nextStepLabels[value] ?? "Следующий шаг требует уточнения.";
}

function StatusBadge({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone: "blue" | "green";
}) {
  const color =
    tone === "green"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-indigo-200 bg-indigo-50 text-indigo-800";

  return (
    <div
      className={`min-w-0 max-w-full rounded-2xl border px-3 py-3 sm:px-4 ${color}`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] opacity-65">
        {label}
      </div>
      <div className="mt-1 whitespace-normal text-sm font-semibold leading-5 [overflow-wrap:anywhere]">
        {displayEnum(value)}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  const missing = value.startsWith("Не выяснен");
  return (
    <div className="min-w-0 max-w-full border-b border-slate-100 py-3 last:border-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd
        className={`mt-1 whitespace-normal text-sm font-medium leading-5 [overflow-wrap:anywhere] ${missing ? "text-slate-400" : "text-slate-900"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function StringList({
  values,
  emptyText,
}: {
  values: string[];
  emptyText: string;
}) {
  if (values.length === 0) {
    return <p className="text-sm text-slate-400">{emptyText}</p>;
  }

  return (
    <ul className="min-w-0 max-w-full space-y-2">
      {values.map((value) => (
        <li
          key={value}
          className="min-w-0 max-w-full whitespace-normal rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-5 text-slate-700 [overflow-wrap:anywhere]"
        >
          {value}
        </li>
      ))}
    </ul>
  );
}

function FactChips({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <span className="text-sm text-slate-400">Нет</span>;
  }

  return (
    <div className="flex min-w-0 max-w-full flex-wrap gap-2">
      {values.map((value) => (
        <span
          key={value}
          className="min-w-0 max-w-full whitespace-normal rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 [overflow-wrap:anywhere]"
        >
          {displayEnum(value)}
        </span>
      ))}
    </div>
  );
}

function ResultPanel({ result }: { result: ProcessIncomingEventResult }) {
  const facts = result.extraction?.facts;
  const signals = result.extraction?.signals;
  const barriers = [
    ...(signals?.objections ?? []),
    ...(signals?.possiblePrimaryFear
      ? [displayEnum(signals.possiblePrimaryFear)]
      : []),
    ...(signals?.possibleSecondaryFear
      ? [displayEnum(signals.possibleSecondaryFear)]
      : []),
  ];

  return (
    <section
      aria-live="polite"
      className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-35px_rgba(15,23,42,0.35)] sm:rounded-3xl sm:p-7"
    >
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">
            Результат обработки
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            Профиль входящего партнёра
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            ИИ-модель: Claude · Время обработки:{" "}
            {displayDuration(result.metrics.totalProcessingLatencyMs)}
          </p>
        </div>
        <div className="grid min-w-0 w-full max-w-full grid-cols-1 gap-2 sm:w-auto sm:min-w-72 sm:grid-cols-2">
          <StatusBadge
            label="География"
            value={result.serviceability}
            tone="green"
          />
          <StatusBadge
            label="Квалификация"
            value={result.qualificationStatus}
            tone="blue"
          />
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <span className="font-semibold text-slate-900">Причина: </span>
        {displayEnum(result.qualificationReason)}
      </div>

      <div className="mt-5 grid min-w-0 gap-5 sm:mt-6 sm:gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="min-w-0 rounded-2xl border border-slate-200 px-3 sm:px-4">
          <dl>
            <Fact label="Город" value={displayValue(facts?.city)} />
            <Fact label="Бюджет" value={displayBudget(facts?.budget)} />
            <Fact
              label="Потенциальное число объектов"
              value={displayValue(
                facts?.startingUnits ?? facts?.scalingPotentialUnits,
              )}
            />
            <Fact
              label="Срок запуска"
              value={displayEnum(facts?.launchTiming)}
            />
            <Fact
              label="Цель человека"
              value={displayGoal(facts?.primaryGoal)}
            />
            <Fact
              label="Возможность уделять время"
              value={displayBoolean(facts?.hasFreeTime)}
            />
            <Fact
              label="Готовность участвовать в процессе"
              value={displayEnum(facts?.managementReadiness)}
            />
            <Fact
              label="Опыт"
              value={displayExperience(
                facts?.businessExperience,
                facts?.shortTermRentalExperience,
              )}
            />
            <Fact
              label="Основное сомнение / барьер"
              value={displayEnum(signals?.possiblePrimaryFear)}
            />
          </dl>
        </div>

        <div className="grid min-w-0 max-w-full grid-cols-1 gap-4 md:grid-cols-2">
          <div className="min-w-0 max-w-full rounded-2xl border border-slate-200 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-900">Вопросы</h3>
            <StringList
              values={signals?.questions ?? []}
              emptyText="Вопросов не обнаружено"
            />
          </div>
          <div className="min-w-0 max-w-full rounded-2xl border border-slate-200 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-900">
              Возражения и барьеры
            </h3>
            <StringList values={barriers} emptyText="Барьеров не обнаружено" />
          </div>
        </div>
      </div>

      <div className="mt-5 grid min-w-0 gap-4 border-t border-slate-100 pt-5 sm:mt-6 sm:pt-6 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">
            Известные факты
          </h3>
          <FactChips values={result.knownFacts} />
        </div>
        <div className="min-w-0">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">
            Важные недостающие факты
          </h3>
          <FactChips values={result.missingImportantFacts} />
        </div>
      </div>

      <div className="mt-5 min-w-0 rounded-2xl bg-slate-950 px-4 py-4 text-white sm:mt-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {result.nextAction === "REJECT_POLITELY"
            ? "Рекомендуемое действие"
            : "Следующая информационная потребность"}
        </p>
        <p className="mt-1 break-words text-sm font-semibold leading-6">
          {displayNextStep(
            result.suggestedNextInformationNeed,
            result.nextAction,
          )}
        </p>
      </div>
    </section>
  );
}

export function DemoClient() {
  const [message, setMessage] = useState(initialMessage);
  const [result, setResult] = useState<ProcessIncomingEventResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const externalLeadId = useRef<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || isSubmitting) return;

    externalLeadId.current ??= `demo-lead-${crypto.randomUUID()}`;
    setIsSubmitting(true);
    setError(null);

    try {
      const uniqueId = crypto.randomUUID();
      const { response, payload } = await sendInboundRequest({
          source: "demo-ui",
          externalEventId: `demo-event-${uniqueId}`,
          externalLeadId: externalLeadId.current,
          messageId: `demo-message-${uniqueId}`,
          text,
      });

      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.ok
            ? "Не удалось обработать сообщение."
            : (apiErrorLabels[payload.error.code] ??
              "Не удалось обработать сообщение. Попробуйте ещё раз."),
        );
      }
      setResult(payload.result);
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.message.startsWith("Не ")
          ? requestError.message
          : "Не удалось связаться с локальным сервером.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-clip bg-[radial-gradient(circle_at_top_left,#eef2ff_0,transparent_35%),linear-gradient(180deg,#f8fafc_0%,#f1f5f9_100%)] px-3 py-6 text-slate-900 sm:px-6 sm:py-10 lg:py-14">
      <div className="mx-auto w-full min-w-0 max-w-6xl">
        <header className="min-w-0 max-w-3xl">
          <div className="inline-flex max-w-full items-center gap-2 whitespace-normal rounded-full border border-indigo-200 bg-white/80 px-3 py-1 text-xs font-semibold text-indigo-700 shadow-sm backdrop-blur [overflow-wrap:anywhere]">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Локальная демонстрация
          </div>
          <h1 className="mt-4 text-2xl font-semibold leading-tight tracking-[-0.035em] text-slate-950 sm:mt-5 sm:text-4xl">
            ИИ-квалификация партнёра
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base sm:leading-7">
            Отправьте сообщение так, как его написал бы потенциальный партнёр.
            Система извлечёт факты, обновит профиль и применит текущие
            правила квалификации.
          </p>
        </header>

        <div className="mt-6 grid w-full min-w-0 max-w-full grid-cols-1 items-start gap-4 sm:mt-8 sm:gap-6 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <section className="w-full min-w-0 max-w-full rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-35px_rgba(15,23,42,0.35)] sm:rounded-3xl sm:p-7 lg:sticky lg:top-6">
            <form className="w-full min-w-0 max-w-full" onSubmit={handleSubmit}>
              <label
                htmlFor="partner-message"
                className="text-sm font-semibold text-slate-900"
              >
                Сообщение партнёра
              </label>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Следующее сообщение на этой странице обновит профиль того же
                тестового партнёра.
              </p>
              <textarea
                id="partner-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={7}
                maxLength={20_000}
                className="mt-4 block min-h-40 w-full min-w-0 max-w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-base leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100 sm:min-h-52 sm:px-4 sm:text-sm"
                placeholder="Например: Я из Волгограда, есть 500 тысяч..."
              />
              <button
                type="submit"
                disabled={isSubmitting || message.trim().length === 0}
                className="mt-4 inline-flex min-h-12 w-full min-w-0 max-w-full items-center justify-center rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-slate-300 sm:px-5"
              >
                {isSubmitting ? "Обрабатываем…" : "Отправить"}
              </button>
            </form>

            {error ? (
              <div
                role="alert"
                className="mt-4 min-w-0 max-w-full whitespace-normal rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-5 text-rose-700 [overflow-wrap:anywhere]"
              >
                {error}
              </div>
            ) : null}
          </section>

          {result ? (
            <ResultPanel result={result} />
          ) : (
            <section className="flex min-h-72 w-full min-w-0 max-w-full items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 p-5 text-center backdrop-blur sm:min-h-96 sm:rounded-3xl sm:p-8">
              <div className="min-w-0 max-w-sm">
                <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl text-indigo-600">
                  ↗
                </div>
                <h2 className="mt-4 text-base font-semibold text-slate-800">
                  Результат появится здесь
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Сервер вернёт только извлечённые данные и результаты текущей
                  обработки — без клиентской бизнес-логики.
                </p>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
