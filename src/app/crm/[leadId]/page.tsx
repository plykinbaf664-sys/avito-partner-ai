import Link from "next/link";
import { notFound } from "next/navigation";

import { withCrmService } from "@/application/crm/crm-runtime";
import {
  dateTime,
  buyingIntentLabels,
  goalLabels,
  financialLabels,
  launchTimingLabels,
  money,
  notificationLabel,
  segmentLabels,
  qualificationLabel,
  handoffLabel,
  informationNeedLabels,
} from "../crm-format";
import { requireCrmPageAccess } from "../require-crm-page-access";

export const dynamic = "force-dynamic";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-900 p-3">
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-sm">{value ?? ""}</dd>
    </div>
  );
}

export default async function CrmLeadPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  await requireCrmPageAccess();
  const { leadId } = await params;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(leadId)) notFound();
  const record = await withCrmService((service) => service.getLead(leadId));
  if (!record) notFound();
  const summary = record.managerSummary;

  return (
    <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <Link href="/crm" className="text-sm text-blue-300 hover:underline">← Все лиды</Link>
          <h1 className="mt-3 text-2xl font-semibold">Карточка лида</h1>
          <p className="mt-1 text-sm text-slate-500">ID: {record.leadId}</p>
        </header>

        <section>
          <h2 className="mb-3 text-lg font-medium">Основные данные</h2>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Источник" value={record.source} />
            <Field label="ID диалога в канале" value={record.externalLeadId} />
            <Field label="Имя" value={record.name ?? ""} />
            <Field label="Телефон" value={record.phoneNumber ?? ""} />
            <Field label="Сегмент" value={segmentLabels[record.segment]} />
            <Field label="Уверенность сегмента" value={`${Math.round(record.segmentConfidence * 100)}%`} />
            <Field label="Город" value={record.city ?? ""} />
            <Field label="Доступный капитал" value={money(record.availableCapital)} />
            <Field label="Первый этап" value={money(record.entryBudget)} />
            <Field label="Дополнительный капитал" value={money(record.additionalLaunchCapital)} />
            <Field label="Стартовый объём" value={record.startingUnits ?? ""} />
            <Field label="Потенциал масштаба" value={record.scalingPotentialUnits ?? ""} />
            <Field label="Срок запуска" value={record.launchTiming ? launchTimingLabels[record.launchTiming] ?? record.launchTiming : ""} />
            <Field label="Цель" value={record.goal ? goalLabels[record.goal] ?? record.goal : ""} />
            <Field label="Желаемый доход" value={money(record.desiredIncome)} />
            <Field label="Свободное время" value={record.availableTimeDetails ?? (record.hasFreeTime === true ? "Есть несколько часов в день" : record.hasFreeTime === false ? "Ограничено" : "")} />
            <Field label="Финансовая готовность" value={financialLabels[record.financialReadiness] ?? record.financialReadiness} />
            <Field label="Намерение" value={record.buyingIntent ? buyingIntentLabels[record.buyingIntent] ?? record.buyingIntent : ""} />
            <Field label="Последняя активность" value={dateTime(record.lastActivityAt)} />
          </dl>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Квалификация и передача</h2>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Квалификация" value={qualificationLabel(record)} />
            <Field label="Причина" value={record.qualificationReason ?? ""} />
            <Field label="Осталось выяснить" value={record.missingCriticalFacts.map((need) => informationNeedLabels[need] ?? need).join(", ")} />
            <Field label="Состояние диалога" value={record.conversationState ?? ""} />
            <Field label="Handoff" value={handoffLabel(record)} />
            <Field label="Дата передачи" value={dateTime(record.handoffAt)} />
            <Field label="Telegram" value={notificationLabel(record)} />
            <Field label="Ошибка доставки" value={record.managerNotificationErrorCode ?? ""} />
            <Field label="Барьеры" value={record.barriers.join(", ")} />
            <Field label="Возражения" value={record.objections.join("\n")} />
            <Field label="Вопросы" value={record.lead.questions.join("\n")} />
          </dl>
        </section>

        {summary ? (
          <section>
            <h2 className="mb-3 text-lg font-medium">Резюме для менеджера</h2>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Почему квалифицирован" value={summary.qualificationRationale} />
              <Field label="Следующий шаг" value={summary.recommendedNextStep} />
              <Field label="Reason codes" value={summary.reasonCodes.join(", ")} />
              <Field label="Что уже объяснено" value={summary.explainedKnowledge.join(", ")} />
            </dl>
          </section>
        ) : null}

        <section>
          <h2 className="mb-3 text-lg font-medium">Последние сообщения</h2>
          <div className="space-y-3">
            {record.messages.map((message) => (
              <article key={message.id} className={`max-w-3xl rounded-xl p-4 ${message.direction === "INBOUND" ? "bg-slate-800" : "ml-auto bg-blue-950"}`}>
                <div className="mb-2 flex justify-between gap-4 text-xs text-slate-400">
                  <span>{message.actor === "MANAGER" ? "\u0414\u043c\u0438\u0442\u0440\u0438\u0439" : message.actor === "AI" ? "AI" : "\u041b\u0438\u0434"}</span>
                  <span>{dateTime(message.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{message.content}</p>
              </article>
            ))}
            {record.messages.length === 0 ? <p className="text-slate-500">Сообщений нет</p> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
