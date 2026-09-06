import type { ConversationState } from "./conversation-state";
import type { Lead } from "../lead/lead";

export const informationNeeds = [
  "CITY",
  "BUDGET",
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

export const criticalInformationNeeds = [
  "BUDGET",
  "LAUNCH_TIMING",
  "CITY",
  "STARTING_UNITS",
  "GOAL",
  "MANAGEMENT_READINESS",
] as const satisfies readonly InformationNeed[];

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
    case "CITY":
      return lead.city !== null;
    case "BUDGET":
      return lead.budget !== null && lead.budgetConfirmed;
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

export function assessInformationNeeds(
  lead: Lead,
): InformationNeedsAssessment {
  const knownFacts = informationNeeds.filter((need) => isKnown(lead, need));
  const missingCriticalFacts = criticalInformationNeeds.filter(
    (need) => !knownFacts.includes(need),
  );
  const missingOptionalFacts = optionalInformationNeeds.filter(
    (need) => !knownFacts.includes(need),
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
    BUDGET: 100,
    LAUNCH_TIMING: 90,
    CITY: 80,
    STARTING_UNITS: 75,
    SCALING_POTENTIAL_UNITS: 20,
    GOAL: 70,
    MANAGEMENT_READINESS: 65,
    FREE_TIME: 35,
    EXPERIENCE: 30,
    BARRIER: 25,
  };

  if (
    lead.budget !== null &&
    lead.budgetConfirmed &&
    lead.budget < 150_000
  ) {
    scores.MANAGEMENT_READINESS += 20;
    scores.STARTING_UNITS += 15;
  }
  if (lead.serviceability === "NEEDS_REVIEW" && lead.city !== null) {
    scores.STARTING_UNITS += 10;
  }
  if (
    (lead.startingUnits !== null && lead.startingUnits >= 5) ||
    (lead.scalingPotentialUnits !== null && lead.scalingPotentialUnits >= 5)
  ) {
    scores.MANAGEMENT_READINESS += 20;
    scores.GOAL += 10;
  }
  if (lead.primaryFear !== null) {
    scores.BARRIER -= 20;
  }

  return [...candidates].sort((left, right) => scores[right] - scores[left])[0] ?? null;
}

export function stateForInformationNeed(
  need: InformationNeed | null,
): ConversationState {
  switch (need) {
    case "CITY":
      return "WAITING_CITY";
    case "BUDGET":
      return "WAITING_BUDGET";
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
    case "STARTING_UNITS":
    case "SCALING_POTENTIAL_UNITS":
      return "QUALIFYING";
    case null:
      return "QUALIFIED";
  }
}
