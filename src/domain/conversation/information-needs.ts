import type { Lead } from "../lead/lead";
import { assessFinancialReadiness } from "../qualification/financial-readiness";
import { hasConfirmedPhone } from "../qualification/qualification-policy";
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
  allowedNextInformationNeeds: InformationNeed[];
  suggestedNextInformationNeed: InformationNeed | null;
}

/**
 * A new lead needs a conversational discovery move before the qualification
 * gaps become useful prompts.  This is deliberately based on the persisted
 * state, rather than on the wording of one message.
 */
export function isFreshDiscoveryLead(lead: Lead): boolean {
  return (
    lead.segment === "UNDETERMINED" &&
    lead.city === null &&
    lead.businessExperience === null &&
    lead.shortTermRentalExperience === null &&
    lead.primaryGoal === null &&
    lead.availableCapital === null &&
    lead.entryBudget === null &&
    lead.startingUnits === null &&
    lead.launchTiming === null &&
    lead.buyingIntent === "EXPLORING"
  );
}

function isKnown(lead: Lead, need: InformationNeed): boolean {
  switch (need) {
    case "AVAILABLE_CAPITAL":
      return (
        lead.entryBudget !== null ||
        (lead.availableCapital !== null && lead.availableCapitalConfirmed) ||
        (lead.budget !== null && lead.budgetConfirmed) ||
        assessFinancialReadiness(lead).financialReadiness === "READY"
      );
    case "PHONE_NUMBER":
      return hasConfirmedPhone(lead);
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
      "ADDITIONAL_EXPENSES",
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
      "ADDITIONAL_EXPENSES",
      "MANAGEMENT_READINESS",
      "PHONE_NUMBER",
    ];
  }
  const needs: InformationNeed[] = [
    "AVAILABLE_CAPITAL",
    "STARTING_UNITS",
    "GOAL",
    "LAUNCH_TIMING",
  ];
  if (
    lead.entryBudget !== null &&
    !isKnown(lead, "ADDITIONAL_EXPENSES")
  ) {
    needs.push("ADDITIONAL_EXPENSES");
  }
  if (
    !hasConfirmedPhone(lead) &&
    ["PHONE_UNKNOWN", "USER_REQUESTED_HUMAN", "UNKNOWN_BUSINESS_QUESTION"].includes(
      lead.qualificationReason ?? "",
    )
  ) {
    needs.push("PHONE_NUMBER");
  }
  return needs;
}

export function assessInformationNeeds(
  lead: Lead,
  options: { excludedNextInformationNeeds?: readonly InformationNeed[] } = {},
): InformationNeedsAssessment {
  const knownFacts = informationNeeds.filter((need) => isKnown(lead, need));
  const criticalInformationNeeds = criticalInformationNeedsFor(lead);
  const missingCriticalFacts = criticalInformationNeeds.filter(
    (need) => !knownFacts.includes(need),
  );
  const missingOptionalFacts = optionalInformationNeeds.filter(
    (need) => !knownFacts.includes(need) && !missingCriticalFacts.includes(need),
  );
  const excluded = new Set(options.excludedNextInformationNeeds ?? []);
  const allowedNextInformationNeeds = selectAllowedInformationNeeds(
    lead,
    missingCriticalFacts,
    missingOptionalFacts,
  ).filter((need) => !excluded.has(need));
  const suggestedNextInformationNeed = selectNextInformationNeed(
    lead,
    allowedNextInformationNeeds,
    missingCriticalFacts,
    missingOptionalFacts,
  );
  return {
    knownFacts,
    missingCriticalFacts,
    missingOptionalFacts,
    missingImportantFacts: [...missingCriticalFacts, ...missingOptionalFacts],
    allowedNextInformationNeeds,
    suggestedNextInformationNeed,
  };
}

function selectAllowedInformationNeeds(
  lead: Lead,
  missingCriticalFacts: InformationNeed[],
  missingOptionalFacts: InformationNeed[],
): InformationNeed[] {
  // Phone is the final bridge to handoff, never an early discovery shortcut.
  // Qualification exposes PHONE_UNKNOWN only after mandatory criteria pass.
  const phoneMayBeRequested =
    lead.qualificationReason === "PHONE_UNKNOWN" ||
    ["HOT", "PRIORITY"].includes(lead.qualificationStatus);
  if (
    phoneMayBeRequested &&
    ["PHONE_UNKNOWN", "UNKNOWN_BUSINESS_QUESTION", "USER_REQUESTED_HUMAN"].includes(
      lead.qualificationReason ?? "",
    )
  ) {
    return ["PHONE_NUMBER"];
  }
  const conversationalCriticalFacts = missingCriticalFacts.filter(
    (need) => need !== "PHONE_NUMBER" || phoneMayBeRequested,
  );
  if (isFreshDiscoveryLead(lead)) {
    // Keep the business requirements deterministic, but give the conversation
    // brain a human discovery choice.  Capital remains a valid gap; it is no
    // longer forced to be the opening question.
    return [
      ...new Set([
        ...(lead.city === null ? ["CITY" as const] : []),
        ...(missingOptionalFacts.includes("EXPERIENCE")
          ? ["EXPERIENCE" as const]
          : []),
        ...conversationalCriticalFacts,
      ]),
    ];
  }
  if (conversationalCriticalFacts.length === 0) return [...missingOptionalFacts];
  if (
    conversationalCriticalFacts.length === 1 &&
    conversationalCriticalFacts[0] === "PHONE_NUMBER"
  ) {
    return [
      ...missingOptionalFacts,
      "PHONE_NUMBER",
    ];
  }
  // Critical facts define qualification eligibility, not a questionnaire
  // order.  The conversation brain may choose a softer missing discovery
  // topic when it better fits the current user turn.  Phone remains absent
  // until deterministic policy makes it a real critical need.
  return [
    ...new Set([
      ...(lead.city === null ? ["CITY" as const] : []),
      ...conversationalCriticalFacts,
      ...missingOptionalFacts,
    ]),
  ];
}

function selectNextInformationNeed(
  lead: Lead,
  candidates: InformationNeed[],
  missingCriticalFacts: InformationNeed[],
  missingOptionalFacts: InformationNeed[],
): InformationNeed | null {
  if (candidates.length === 0) return null;

  // Keep a stable policy suggestion for observability/CRM only. The workflow
  // exposes the complete candidate set to the conversation brain and never
  // turns this value into an outbound question by itself.
  if (
    missingCriticalFacts.length === 1 &&
    missingCriticalFacts[0] === "PHONE_NUMBER"
  ) {
    if (candidates.length === 1 && candidates[0] === "PHONE_NUMBER") {
      return "PHONE_NUMBER";
    }
    if (missingOptionalFacts.includes("SCALING_POTENTIAL_UNITS")) {
      return "SCALING_POTENTIAL_UNITS";
    }
    if (missingOptionalFacts.includes("FREE_TIME")) return "FREE_TIME";
  }

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

  if (isFreshDiscoveryLead(lead)) {
    scores.CITY = 140;
    scores.EXPERIENCE = 130;
    scores.AVAILABLE_CAPITAL = 70;
    scores.STARTING_UNITS = 65;
  }

  if (
    !hasConfirmedPhone(lead) &&
    ["PHONE_UNKNOWN", "USER_REQUESTED_HUMAN", "UNKNOWN_BUSINESS_QUESTION"].includes(
      lead.qualificationReason ?? "",
    )
  ) {
    scores.PHONE_NUMBER = 110;
  }

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
