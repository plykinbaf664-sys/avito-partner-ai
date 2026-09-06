import type { ExtractedMessage } from "../../domain/extraction/extracted-message";
import type { Lead, LeadFactPatch } from "../../domain/lead/lead";
import { evaluateServiceability } from "../../domain/lead/serviceability";

function uniqueStrings(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

export function mergeExtractedFacts(
  lead: Lead,
  extraction: ExtractedMessage,
  updatedAt: Date,
): Lead {
  const patch: LeadFactPatch = {};

  for (const field of [
    "city",
    "startingUnits",
    "scalingPotentialUnits",
    "hasFreeTime",
    "availableTimeDetails",
    "businessExperience",
    "shortTermRentalExperience",
    "ownsProperty",
    "desiredIncome",
    "primaryGoal",
    "launchTiming",
    "managementReadiness",
    "requiresGuaranteedIncome",
    "rejectsBusinessModel",
  ] as const) {
    const value = extraction.facts[field];
    const isUnknownEnum =
      (field === "primaryGoal" ||
        field === "launchTiming" ||
        field === "managementReadiness") &&
      value === "UNKNOWN";
    if (value !== null && !isUnknownEnum) {
      Object.assign(patch, { [field]: value });
    }
  }

  if (extraction.facts.budget !== null) {
    patch.budget = extraction.facts.budget;
    patch.budgetConfirmed = extraction.facts.budgetConfirmed === true;
  }
  if (extraction.signals.possiblePrimaryFear !== null) {
    patch.primaryFear = extraction.signals.possiblePrimaryFear;
  }
  if (extraction.signals.possibleSecondaryFear !== null) {
    patch.secondaryFear = extraction.signals.possibleSecondaryFear;
  }
  if (extraction.intent === "DECLINE") {
    patch.buyingIntent = "DECLINED";
  }

  const merged = {
    ...lead,
    ...patch,
    questions: uniqueStrings(lead.questions, extraction.signals.questions),
    objections: uniqueStrings(lead.objections, extraction.signals.objections),
    updatedAt,
  };

  return {
    ...merged,
    serviceability: evaluateServiceability(merged.city),
  };
}
