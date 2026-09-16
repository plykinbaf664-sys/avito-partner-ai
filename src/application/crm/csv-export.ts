import type { CrmLeadRecord } from "./crm-record";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function createCrmCsv(records: CrmLeadRecord[]): string {
  const headers = [
    "leadId",
    "source",
    "externalLeadId",
    "lastActivityAt",
    "name",
    "phoneNumber",
    "segment",
    "city",
    "availableCapital",
    "entryBudget",
    "additionalLaunchCapital",
    "startingUnits",
    "scalingPotentialUnits",
    "hasFreeTime",
    "availableTimeDetails",
    "goal",
    "desiredIncome",
    "launchTiming",
    "qualificationStatus",
    "qualificationReason",
    "missingCriticalFacts",
    "buyingIntent",
    "financialReadiness",
    "handoffAt",
    "managerNotificationStatus",
    "objections",
    "barriers",
  ];
  const rows = records.map((record) => [
    record.leadId,
    record.source,
    record.externalLeadId,
    record.lastActivityAt,
    record.name,
    record.phoneNumber,
    record.segment,
    record.city,
    record.availableCapital,
    record.entryBudget,
    record.additionalLaunchCapital,
    record.startingUnits,
    record.scalingPotentialUnits,
    record.hasFreeTime,
    record.availableTimeDetails,
    record.goal,
    record.desiredIncome,
    record.launchTiming,
    record.qualificationStatus,
    record.qualificationReason,
    record.missingCriticalFacts.join("; "),
    record.buyingIntent,
    record.financialReadiness,
    record.handoffAt,
    record.managerNotificationStatus,
    record.objections.join("; "),
    record.barriers.join("; "),
  ]);
  return `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}
