import type { ExtractedMessage } from "../../domain/extraction/extracted-message";
import type { Lead, LeadFactPatch } from "../../domain/lead/lead";
import { assessLeadSegment } from "../../domain/lead/lead-segment";
import { evaluateServiceability } from "../../domain/lead/serviceability";
import { normalizePhoneNumber } from "../../domain/lead/phone-number";
import {
  MAX_EXTRACTED_MONEY,
  MAX_STORED_LEAD_SIGNAL_ITEMS,
} from "../security/technical-limits";

function uniqueStrings(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])].slice(
    -MAX_STORED_LEAD_SIGNAL_ITEMS,
  );
}

export function mergeExtractedFacts(
  lead: Lead,
  extraction: ExtractedMessage,
  updatedAt: Date,
): Lead {
  const patch: LeadFactPatch = {};

  if (typeof extraction.facts.phoneNumber === "string") {
    const phoneNumber = normalizePhoneNumber(extraction.facts.phoneNumber);
    if (phoneNumber !== null) {
      patch.phoneNumber = phoneNumber;
      patch.phoneConfirmed = extraction.facts.phoneConfirmed;
    }
  }

  for (const field of [
    "city",
    "availableCapital",
    "entryBudget",
    "additionalLaunchCapital",
    "capitalScope",
    "additionalExpensesReadiness",
    "businessModelReadiness",
    "startingUnits",
    "scalingPotentialUnits",
    "hasFreeTime",
    "availableTimeDetails",
    "businessExperience",
    "shortTermRentalExperience",
    "ownsProperty",
    "desiredIncome",
    "primaryGoal",
    "buyingIntent",
    "launchTiming",
    "managementReadiness",
    "requiresGuaranteedIncome",
    "rejectsBusinessModel",
  ] as const) {
    const value = extraction.facts[field];
    const isUnknownEnum =
      (field === "primaryGoal" ||
        field === "buyingIntent" ||
        field === "launchTiming" ||
        field === "managementReadiness" ||
        field === "capitalScope" ||
        field === "additionalExpensesReadiness" ||
        field === "businessModelReadiness") &&
      value === "UNKNOWN";
    if (value !== null && !isUnknownEnum) {
      Object.assign(patch, { [field]: value });
    }
  }

  if (extraction.facts.budget !== null) {
    patch.budget = extraction.facts.budget;
    patch.budgetConfirmed = extraction.facts.budgetConfirmed === true;
  }
  if (extraction.facts.availableCapital !== null) {
    patch.availableCapital = extraction.facts.availableCapital;
    patch.availableCapitalConfirmed =
      extraction.facts.availableCapitalConfirmed;
    patch.budget = extraction.facts.availableCapital;
    patch.budgetConfirmed = extraction.facts.availableCapitalConfirmed;
  } else if (
    extraction.facts.budget !== null &&
    extraction.facts.entryBudget === null &&
    extraction.facts.capitalScope !== "ENTRY_ONLY"
  ) {
    patch.availableCapital = extraction.facts.budget;
    patch.availableCapitalConfirmed =
      extraction.facts.budgetConfirmed === true;
  }
  if (
    extraction.facts.entryBudget !== null &&
    extraction.facts.entryBudget > 0 &&
    extraction.facts.availableCapital === null &&
    extraction.facts.budget === null
  ) {
    patch.budget = extraction.facts.entryBudget;
    patch.budgetConfirmed = true;
  }
  if (extraction.facts.businessModelReadiness === "REJECTS") {
    patch.rejectsBusinessModel = true;
  }
  if (extraction.signals.possiblePrimaryFear !== null) {
    patch.primaryFear = extraction.signals.possiblePrimaryFear;
  }
  if (extraction.signals.possibleSecondaryFear !== null) {
    patch.secondaryFear = extraction.signals.possibleSecondaryFear;
  }
  // A short uncertainty or "not yet" answer to the immediately preceding
  // discovery question is not a rejection of the business.  Keep the
  // existing intent until the user explicitly declines the opportunity.
  if (
    extraction.intent === "DECLINE" &&
    !["UNSURE", "DECLINED_TO_ANSWER"].includes(
      extraction.signals.previousQuestionResponse ?? "NOT_A_RESPONSE",
    )
  ) {
    patch.buyingIntent = "DECLINED";
  } else if (extraction.signals.wantsHuman) {
    patch.buyingIntent = "WANTS_HUMAN";
  } else if (
    extraction.facts.buyingIntent !== undefined &&
    extraction.facts.buyingIntent !== "UNKNOWN"
  ) {
    patch.buyingIntent = extraction.facts.buyingIntent;
  } else if (
    ["GENERAL_INTEREST", "GREETING"].includes(extraction.intent) &&
    lead.buyingIntent === null
  ) {
    patch.buyingIntent = "EXPLORING";
  }

  let merged = {
    ...lead,
    ...patch,
    questions: uniqueStrings(lead.questions, extraction.signals.questions),
    objections: uniqueStrings(lead.objections, extraction.signals.objections),
    updatedAt,
  };

  const receivedCapitalBreakdown =
    extraction.facts.capitalScope === "ADDITIONAL_AVAILABLE" &&
    (extraction.facts.entryBudget !== null ||
      extraction.facts.additionalLaunchCapital !== null);
  if (
    receivedCapitalBreakdown &&
    merged.entryBudget !== null &&
    merged.additionalLaunchCapital !== null
  ) {
    const derivedAvailableCapital =
      merged.entryBudget + merged.additionalLaunchCapital;
    if (
      Number.isSafeInteger(derivedAvailableCapital) &&
      derivedAvailableCapital <= MAX_EXTRACTED_MONEY
    ) {
      merged = {
        ...merged,
        availableCapital: derivedAvailableCapital,
        availableCapitalConfirmed: true,
        budget: derivedAvailableCapital,
        budgetConfirmed: true,
      };
    }
  }

  // Older extractions could store zero placeholders without a declared scope.
  // Such values are not evidence that the lead has no money; repair them on
  // the next inbound instead of carrying a false financial blocker forward.
  if (merged.capitalScope === "UNKNOWN") {
    merged = {
      ...merged,
      entryBudget: merged.entryBudget === 0 ? null : merged.entryBudget,
      additionalLaunchCapital: merged.additionalLaunchCapital === 0
        ? null
        : merged.additionalLaunchCapital,
      budget: merged.budget === 0 ? null : merged.budget,
      budgetConfirmed: merged.budget === 0 ? false : merged.budgetConfirmed,
      availableCapital: merged.availableCapital === 0 ? null : merged.availableCapital,
      availableCapitalConfirmed: merged.availableCapital === 0
        ? false
        : merged.availableCapitalConfirmed,
    };
  }

  const withServiceability = {
    ...merged,
    serviceability: evaluateServiceability(merged.city),
  };
  const segment = assessLeadSegment(withServiceability);
  return {
    ...withServiceability,
    segment: segment.segment,
    segmentConfidence: segment.confidence,
  };
}
