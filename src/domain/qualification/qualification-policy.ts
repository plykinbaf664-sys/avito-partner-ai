import type { Lead } from "../lead/lead";
import type { QualificationStatus } from "../lead/qualification-status";

export const PARTNER_QUALIFICATION_POLICY = Object.freeze({
  minimumBudget: 150_000,
  noFitBudgetBelow: 100_000,
  priorityPotentialUnits: 5,
});

export const hardBlockingReasonCodes = [
  "INSUFFICIENT_BUDGET",
  "NO_LAUNCH_INTENT",
  "NO_OPERATIONAL_READINESS",
  "UNSUPPORTED_REGION",
  "DECLINED_BY_LEAD",
  "REQUIRES_INCOME_GUARANTEE",
  "INCOMPATIBLE_BUSINESS_MODEL",
] as const;

export type HardBlockingReasonCode =
  (typeof hardBlockingReasonCodes)[number];

export const weakSignalCodes = [
  "BORDERLINE_BUDGET",
  "WEAK_LAUNCH_INTENT",
  "LIMITED_OPERATIONAL_CAPACITY",
] as const;

export type WeakSignalCode = (typeof weakSignalCodes)[number];

export type QualificationReasonCode =
  | HardBlockingReasonCode
  | WeakSignalCode
  | "BUDGET_UNKNOWN"
  | "BUDGET_NOT_CONFIRMED"
  | "LAUNCH_INTENT_UNKNOWN"
  | "OPERATIONAL_READINESS_UNKNOWN"
  | "CITY_UNKNOWN"
  | "REGION_NEEDS_REVIEW"
  | "STARTING_UNITS_UNKNOWN"
  | "GOAL_UNKNOWN"
  | "BASE_REQUIREMENTS_MET"
  | "HOT_READINESS_CONFIRMED"
  | "PRIORITY_SCALE_CONFIRMED"
  | "USER_REQUESTED_HUMAN"
  | "UNKNOWN_BUSINESS_QUESTION";

export const qualificationNextActions = [
  "REJECT_POLITELY",
  "CONTINUE_QUALIFICATION",
  "HANDOFF_TO_MANAGER",
] as const;

export type QualificationNextAction =
  (typeof qualificationNextActions)[number];

export type QualificationFacts = Pick<
  Lead,
  | "city"
  | "serviceability"
  | "budget"
  | "budgetConfirmed"
  | "startingUnits"
  | "scalingPotentialUnits"
  | "hasFreeTime"
  | "launchTiming"
  | "managementReadiness"
  | "buyingIntent"
  | "requiresGuaranteedIncome"
  | "rejectsBusinessModel"
  | "ownsProperty"
  | "businessExperience"
  | "shortTermRentalExperience"
  | "primaryFear"
  | "primaryGoal"
>;

export interface QualificationDecision {
  status: QualificationStatus;
  reason: QualificationReasonCode;
  reasonCodes: QualificationReasonCode[];
  blockingReasons: HardBlockingReasonCode[];
  weakSignals: WeakSignalCode[];
  shouldHandoffToManager: boolean;
  nextAction: QualificationNextAction;
}

export interface QualificationContext {
  wantsHuman?: boolean;
  unknownBusinessQuestion?: boolean;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function evaluateQualification(
  facts: QualificationFacts,
  context: QualificationContext = {},
): QualificationDecision {
  const blockingReasons: HardBlockingReasonCode[] = [];

  if (facts.buyingIntent === "DECLINED") {
    blockingReasons.push("DECLINED_BY_LEAD");
  }
  if (
    facts.budget !== null &&
    facts.budgetConfirmed &&
    facts.budget < PARTNER_QUALIFICATION_POLICY.noFitBudgetBelow
  ) {
    blockingReasons.push("INSUFFICIENT_BUDGET");
  }
  if (facts.launchTiming === "NO_PLANS") {
    blockingReasons.push("NO_LAUNCH_INTENT");
  }
  if (facts.managementReadiness === "NOT_READY") {
    blockingReasons.push("NO_OPERATIONAL_READINESS");
  }
  if (facts.serviceability === "UNSUPPORTED") {
    blockingReasons.push("UNSUPPORTED_REGION");
  }
  if (facts.requiresGuaranteedIncome === true) {
    blockingReasons.push("REQUIRES_INCOME_GUARANTEE");
  }
  if (facts.rejectsBusinessModel === true) {
    blockingReasons.push("INCOMPATIBLE_BUSINESS_MODEL");
  }

  if (blockingReasons.length > 0) {
    return {
      status: "NO_FIT",
      reason: blockingReasons[0],
      reasonCodes: unique(blockingReasons),
      blockingReasons: unique(blockingReasons),
      weakSignals: [],
      shouldHandoffToManager: false,
      nextAction: "REJECT_POLITELY",
    };
  }

  if (context.wantsHuman || context.unknownBusinessQuestion) {
    const reason = context.wantsHuman
      ? "USER_REQUESTED_HUMAN"
      : "UNKNOWN_BUSINESS_QUESTION";
    return {
      status: "HANDOFF",
      reason,
      reasonCodes: [reason],
      blockingReasons: [],
      weakSignals: [],
      shouldHandoffToManager: true,
      nextAction: "HANDOFF_TO_MANAGER",
    };
  }

  const weakSignals: WeakSignalCode[] = [];
  if (
    facts.budget !== null &&
    facts.budgetConfirmed &&
    facts.budget >= PARTNER_QUALIFICATION_POLICY.noFitBudgetBelow &&
    facts.budget < PARTNER_QUALIFICATION_POLICY.minimumBudget
  ) {
    weakSignals.push("BORDERLINE_BUDGET");
  }
  if (facts.launchTiming === "LATER") {
    weakSignals.push("WEAK_LAUNCH_INTENT");
  }
  if (
    facts.hasFreeTime === false ||
    facts.managementReadiness === "LIMITED"
  ) {
    weakSignals.push("LIMITED_OPERATIONAL_CAPACITY");
  }

  const informationGaps: QualificationReasonCode[] = [];
  if (facts.budget === null) informationGaps.push("BUDGET_UNKNOWN");
  else if (!facts.budgetConfirmed) {
    informationGaps.push("BUDGET_NOT_CONFIRMED");
  }
  if (facts.launchTiming === null || facts.launchTiming === "UNKNOWN") {
    informationGaps.push("LAUNCH_INTENT_UNKNOWN");
  }
  if (
    facts.managementReadiness === null ||
    facts.managementReadiness === "UNKNOWN"
  ) {
    informationGaps.push("OPERATIONAL_READINESS_UNKNOWN");
  }
  if (facts.city === null) informationGaps.push("CITY_UNKNOWN");
  if (facts.startingUnits === null) {
    informationGaps.push("STARTING_UNITS_UNKNOWN");
  }
  if (facts.primaryGoal === null || facts.primaryGoal === "UNKNOWN") {
    informationGaps.push("GOAL_UNKNOWN");
  }

  if (informationGaps.length > 0) {
    return {
      status: weakSignals.length > 0 ? "BORDERLINE" : "NEEDS_MORE_INFO",
      reason: weakSignals[0] ?? informationGaps[0],
      reasonCodes: unique([...weakSignals, ...informationGaps]),
      blockingReasons: [],
      weakSignals: unique(weakSignals),
      shouldHandoffToManager: false,
      nextAction: "CONTINUE_QUALIFICATION",
    };
  }

  const hasPriorityScale =
    (facts.startingUnits !== null &&
      facts.startingUnits >= PARTNER_QUALIFICATION_POLICY.priorityPotentialUnits) ||
    (facts.scalingPotentialUnits !== null &&
      facts.scalingPotentialUnits >=
        PARTNER_QUALIFICATION_POLICY.priorityPotentialUnits);
  if (weakSignals.length > 0) {
    const borderlineBudgetHasEnoughGrounds =
      !weakSignals.includes("BORDERLINE_BUDGET") ||
      hasPriorityScale ||
      ((facts.launchTiming === "READY_NOW" ||
        facts.launchTiming === "WITHIN_MONTH") &&
        facts.managementReadiness === "READY");
    if (!borderlineBudgetHasEnoughGrounds) {
      return {
        status: "BORDERLINE",
        reason: weakSignals[0],
        reasonCodes: unique(weakSignals),
        blockingReasons: [],
        weakSignals: unique(weakSignals),
        shouldHandoffToManager: false,
        nextAction: "CONTINUE_QUALIFICATION",
      };
    }
    return {
      status: "WARM",
      reason: weakSignals[0],
      reasonCodes: unique(["BASE_REQUIREMENTS_MET", ...weakSignals]),
      blockingReasons: [],
      weakSignals: unique(weakSignals),
      shouldHandoffToManager: true,
      nextAction: "HANDOFF_TO_MANAGER",
    };
  }
  if (facts.serviceability === "NEEDS_REVIEW") {
    return {
      status: "WARM",
      reason: "REGION_NEEDS_REVIEW",
      reasonCodes: ["BASE_REQUIREMENTS_MET", "REGION_NEEDS_REVIEW"],
      blockingReasons: [],
      weakSignals: [],
      shouldHandoffToManager: true,
      nextAction: "HANDOFF_TO_MANAGER",
    };
  }
  if (hasPriorityScale) {
    return {
      status: "PRIORITY",
      reason: "PRIORITY_SCALE_CONFIRMED",
      reasonCodes: ["BASE_REQUIREMENTS_MET", "PRIORITY_SCALE_CONFIRMED"],
      blockingReasons: [],
      weakSignals: [],
      shouldHandoffToManager: true,
      nextAction: "HANDOFF_TO_MANAGER",
    };
  }

  if (facts.startingUnits !== null && facts.startingUnits > 0) {
    return {
      status: "HOT",
      reason: "HOT_READINESS_CONFIRMED",
      reasonCodes: ["BASE_REQUIREMENTS_MET", "HOT_READINESS_CONFIRMED"],
      blockingReasons: [],
      weakSignals: [],
      shouldHandoffToManager: true,
      nextAction: "HANDOFF_TO_MANAGER",
    };
  }

  return {
    status: "QUALIFIED",
    reason: "BASE_REQUIREMENTS_MET",
    reasonCodes: ["BASE_REQUIREMENTS_MET"],
    blockingReasons: [],
    weakSignals: [],
    shouldHandoffToManager: true,
    nextAction: "HANDOFF_TO_MANAGER",
  };
}
