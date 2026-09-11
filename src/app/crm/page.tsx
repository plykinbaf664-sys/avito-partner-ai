import Link from "next/link";

import { crmLeadFilters, type CrmLeadFilter } from "@/application/crm/crm-record";
import { withCrmService } from "@/application/crm/crm-runtime";
import {
  dateTime,
  buyingIntentLabels,
  financialLabels,
  launchTimingLabels,
  money,
  notificationLabel,
  segmentLabels,
  statusLabels,
} from "./crm-format";
import { requireCrmPageAccess } from "./require-crm-page-access";

export const dynamic = "force-dynamic";

const filterLabels: Record<CrmLeadFilter, string> = {
  all: "Все",
  hot: "Горячие",
  qualified: "Квалифицированные",
  handoff: "Переданные",
  active: "Требуют ответа",
  no_fit: "Не подходят",
};

function filterValue(value: string | undefined): CrmLeadFilter {
  return crmLeadFilters.includes(value as CrmLeadFilter)
    ? (value as CrmLeadFilter)
    : "all";
}

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; search?: string; page?: string }>;
}) {
  await requireCrmPageAccess();
  const params = await searchParams;
  const filter = filterValue(params.filter);
  const search = params.search?.slice(0, 100) ?? "";
  const page = Number.parseInt(params.page ?? "1", 10) || 1;
  const result = await withCrmService((service) =>
    service.listLeads({ filter, search, page }),
  );
  const pageHref = (targetPage: number) => {
    const query = new URLSearchParams({ filter, page: String(targetPage) });
    if (search) query.set("search", search);
    return `/crm?${query}`;
  };

  return (
    <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Лиды партнёрской программы</h1>
            <p className="mt-1 text-sm text-slate-400">Всего: {result.total}</p>
          </div>
          <a
            href="/api/crm/export.csv"
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800"
          >
            Скачать CSV
          </a>
        </header>

        <form className="flex flex-wrap gap-2" method="get">
          <select
            name="filter"
            defaultValue={filter}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
          >
            {crmLeadFilters.map((value) => (
              <option key={value} value={value}>{filterLabels[value]}</option>
            ))}
          </select>
          <input
            name="search"
            defaultValue={search}
            maxLength={100}
            placeholder="Телефон, имя или город"
            className="min-w-72 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
          />
          <button className="rounded-lg bg-blue-600 px-4 py-2 hover:bg-blue-500">
            Найти
          </button>
        </form>

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[1500px] text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase text-slate-400">
              <tr>
                {[
                  "Источник",
                  "Последняя активность", "Имя", "Телефон", "Сегмент", "Город",
                  "Капитал", "Старт", "Потенциал", "Срок", "Квалификация",
                  "Финансы", "Намерение", "Handoff", "Telegram",
                ].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {result.records.map((lead) => (
                <tr key={lead.leadId} className="bg-slate-950 hover:bg-slate-900/70">
                  <td className="px-3 py-3">{lead.source}</td>
                  <td className="px-3 py-3"><Link className="text-blue-300 hover:underline" href={`/crm/${encodeURIComponent(lead.leadId)}`}>{dateTime(lead.lastActivityAt)}</Link></td>
                  <td className="px-3 py-3">{lead.name ?? ""}</td>
                  <td className="px-3 py-3">{lead.phoneNumber ?? ""}</td>
                  <td className="px-3 py-3">{segmentLabels[lead.segment]}</td>
                  <td className="px-3 py-3">{lead.city ?? ""}</td>
                  <td className="px-3 py-3">{money(lead.availableCapital)}</td>
                  <td className="px-3 py-3">{lead.startingUnits ?? ""}</td>
                  <td className="px-3 py-3">{lead.scalingPotentialUnits ?? ""}</td>
                  <td className="px-3 py-3">{lead.launchTiming ? launchTimingLabels[lead.launchTiming] ?? lead.launchTiming : ""}</td>
                  <td className="px-3 py-3">{statusLabels[lead.qualificationStatus] ?? lead.qualificationStatus}</td>
                  <td className="px-3 py-3">{financialLabels[lead.financialReadiness] ?? lead.financialReadiness}</td>
                  <td className="px-3 py-3">{lead.buyingIntent ? buyingIntentLabels[lead.buyingIntent] ?? lead.buyingIntent : ""}</td>
                  <td className="px-3 py-3">{lead.handoffAt ? "Передан" : ""}</td>
                  <td className="px-3 py-3">{notificationLabel(lead)}</td>
                </tr>
              ))}
              {result.records.length === 0 ? (
                <tr><td colSpan={15} className="px-4 py-10 text-center text-slate-500">Лиды не найдены</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <nav className="flex items-center justify-between text-sm">
          <span>Страница {result.page} из {result.totalPages}</span>
          <div className="flex gap-2">
            {result.page > 1 ? <Link className="rounded border border-slate-700 px-3 py-2" href={pageHref(result.page - 1)}>Назад</Link> : null}
            {result.page < result.totalPages ? <Link className="rounded border border-slate-700 px-3 py-2" href={pageHref(result.page + 1)}>Дальше</Link> : null}
          </div>
        </nav>
      </div>
    </main>
  );
}
