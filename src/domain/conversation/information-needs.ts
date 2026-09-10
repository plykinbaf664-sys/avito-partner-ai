import { LAUNCH_COST_REFERENCE } from "../economics/economics-calculator";
import type { Lead } from "../lead/lead";
import { assessFinancialReadiness } from "../qualification/financial-readiness";
import type { ConversationState } from "./conversation-state";

export const informationNeeds = [
  "PHONE_NUMBER",
  "AVAILABLE_CAPITAL",
  "ADDITIONAL_EXPENSES",
  "BUSINESS_MODEL",
  "CITY",
  "LAUNCH_TIMING",
  "FREE_TIME",
  "MANAGEMENT_READINESS",
  "STARTING_UNITS",
  "SCALING_POTENTIAL_UNITS",
  "GOAL",
  "EXPERIENCE",
  "BARRIER",
] as const;

export type InformationNeed = (typeof informationNeeds)[number];

export const optionalInformationNeeds = [
  "FREE_TIME",
  "EXPERIENCE",
  "BARRIER",
  "SCALING_POTENTIAL_UNITS",
] as const satisfies readonly InformationNeed[];

export interface InformationNeedsAssessment {
  knownFacts: InformationNeed[];
  missingCriticalFacts: InformationNeed[];
  missingOptionalFacts: InformationNeed[];
  missingImportantFacts: InformationNeed[];
  suggestedNextInformationNeed: InformationNeed | null;
}

function isKnown(lead: Lead, need: InformationNeed): boolean {
  switch (need) {
    case "AVAILABLE_CAPITAL":
      return (
        lead.entryBudget !== null ||
        (lead.availableCapital !== null && lead.availableCapitalConfirmed) ||
        (lead.budget !== null && lead.budgetConfirmed)
      );
    case "PHONE_NUMBER":
      return lead.phoneNumber !== null && lead.phoneConfirmed;
    case "ADDITIONAL_EXPENSES":
      return ["HIGH", "READY", "INCOMPATIBLE"].includes(
        assessFinancialReadiness(lead).financialReadiness,
      );
    case "BUSINESS_MODEL":
      return lead.businessModelReadiness !== "UNKNOWN";
    case "CITY":
      return lead.city !== null;
    case "LAUNCH_TIMING":
      return lead.launchTiming !== null && lead.launchTiming !== "UNKNOWN";
    case "FREE_TIME":
      return lead.hasFreeTime !== null;
    case "MANAGEMENT_READINESS":
      return (
        lead.managementReadiness !== null &&
        lead.managementReadiness !== "UNKNOWN"
      );
    case "STARTING_UNITS":
      return lead.startingUnits !== null;
    case "SCALING_POTENTIAL_UNITS":
      return lead.scalingPotentialUnits !== null;
    case "GOAL":
      return lead.primaryGoal !== null && lead.primaryGoal !== "UNKNOWN";
    case "EXPERIENCE":
      return (
        lead.businessExperience !== null ||
        lead.shortTermRentalExperience !== null
      );
    case "BARRIER":
      return lead.primaryFear !== null;
  }
}

function criticalInformationNeedsFor(lead: Lead): InformationNeed[] {
  if (lead.segment === "INVESTOR") {
    const needs: InformationNeed[] = [
      "AVAILABLE_CAPITAL",
      "LAUNCH_TIMING",
      "GOAL",
      "MANAGEMENT_READINESS",
      "CITY",
      "PHONE_NUMBER",
    ];
    if (lead.startingUnits === null && lead.scalingPotentialUnits === null) {
      needs.push("STARTING_UNITS");
    }
    return needs;
  }
  if (lead.segment === "SMALL_BUSINESS") {
    return [
      "AVAILABLE_CAPITAL",
      "STARTING_UNITS",
      "LAUNCH_TIMING",
      "CITY",
      "GOAL",
      "BUSINESS_MODEL",
      "ADDITIONAL_EXPENSES",
      "MANAGEMENT_READINESS",
      "PHONE_NUMBER",
    ];
  }
  const needs: InformationNeed[] = [
    "AVAILABLE_CAPITAL",
    "STARTING_UNITS",
    "GOAL",
    "BUSINESS_MODEL",
    "LAUNCH_TIMING",
  ];
  if (
    lead.entryBudget !== null &&
    (lead.availableCapital === null ||
      lead.availableCapital <
        LAUNCH_COST_REFERENCE.baseLaunchReference +
          LAUNCH_COST_REFERENCE.furnishingReserveReference)
  ) {
    needs.push("ADDITIONAL_EXPENSES");
  }
  return needs;
}

export function assessInformationNeeds(
  lead: Lead,
): InformationNeedsAssessment {
  const knownFacts = informationNeeds.filter((need) => isKnown(lead, need));
  const criticalInformationNeeds = criticalInformationNeedsFor(lead);
  const missingCriticalFacts = criticalInformationNeeds.filter(
    (need) => !knownFacts.includes(need),
  );
  const missingOptionalFacts = optionalInformationNeeds.filter(
    (need) => !knownFacts.includes(need) && !missingCriticalFacts.includes(need),
  );
  const suggestedNextInformationNeed = selectNextInformationNeed(
    lead,
    missingCriticalFacts,
    missingOptionalFacts,
  );
  return {
    knownFacts,
    missingCriticalFacts,
    missingOptionalFacts,
    missingImportantFacts: [...missingCriticalFacts, ...missingOptionalFacts],
    suggestedNextInformationNeed,
  };
}

function selectNextInformationNeed(
  lead: Lead,
  missingCriticalFacts: InformationNeed[],
  missingOptionalFacts: InformationNeed[],
): InformationNeed | null {
  const candidates =
    missingCriticalFacts.length > 0 ? missingCriticalFacts : missingOptionalFacts;
  if (candidates.length === 0) return null;

  const scores: Record<InformationNeed, number> = {
    PHONE_NUMBER: 65,
    AVAILABLE_CAPITAL: 100,
    STARTING_UNITS: 95,
    LAUNCH_TIMING: 90,
    ADDITIONAL_EXPENSES: 85,
    BUSINESS_MODEL: 82,
    CITY: 80,
    GOAL: 75,
    MANAGEMENT_READINESS: 70,
    SCALING_POTENTIAL_UNITS: 40,
    FREE_TIME: 35,
    EXPERIENCE: 30,
    BARRIER: 25,
  };

  if (lead.segment === "INVESTOR") {
    scores.STARTING_UNITS += 20;
    scores.SCALING_POTENTIAL_UNITS += 45;
    scores.MANAGEMENT_READINESS += 10;
    scores.ADDITIONAL_EXPENSES -= 50;
  }
  if (
    lead.segment === "SMALL_BUSINESS" &&
    lead.capitalScope === "TOTAL_LIMIT" &&
    lead.additionalExpensesReadiness !== "READY"
  ) {
    scores.ADDITIONAL_EXPENSES += 35;
  }
  if (
    lead.entryBudget !== null &&
    !isKnown(lead, "ADDITIONAL_EXPENSES")
  ) {
    scores.ADDITIONAL_EXPENSES += 35;
  }
  if (lead.primaryFear !== null) scores.BARRIER -= 20;

  return [...candidates].sort((left, right) => scores[right] - scores[left])[0] ?? null;
}

export function stateForInformationNeed(
  need: InformationNeed | null,
): ConversationState {
  switch (need) {
    case "AVAILABLE_CAPITAL":
    case "ADDITIONAL_EXPENSES":
      return "WAITING_BUDGET";
    case "PHONE_NUMBER":
      return "WAITING_PHONE";
    case "CITY":
      return "WAITING_CITY";
    case "LAUNCH_TIMING":
      return "WAITING_LAUNCH_TIMING";
    case "FREE_TIME":
    case "MANAGEMENT_READINESS":
      return "WAITING_TIME";
    case "GOAL":
      return "WAITING_GOAL";
    case "EXPERIENCE":
      return "WAITING_EXPERIENCE";
    case "BARRIER":
      return "WAITING_BARRIER";
    case "BUSINESS_MODEL":
    case "STARTING_UNITS":
    case "SCALING_POTENTIAL_UNITS":
      return "QUALIFYING";
    case null:
      return "QUALIFIED";
  }
}
