import type { Lead } from "../lead/lead";
import type { QualificationStatus } from "../lead/qualification-status";
import { SEGMENTATION_REFERENCE } from "../lead/lead-segment";
import { assessFinancialReadiness } from "./financial-readiness";

export const PARTNER_QUALIFICATION_POLICY = Object.freeze({
  smallBusinessEntryCapitalReference:
    SEGMENTATION_REFERENCE.smallBusinessEntryCapital,
  investorCapitalReference: SEGMENTATION_REFERENCE.investorCapital,
  investorScaleReference: SEGMENTATION_REFERENCE.investorScaleUnits,
});

export const hardBlockingReasonCodes = [
  "NO_LAUNCH_CAPITAL",
  "NO_LAUNCH_INTENT",
  "NO_MANAGEMENT_INTERACTION",
  "DECLINED_BY_LEAD",
  "REQUIRES_INCOME_GUARANTEE",
  "INCOMPATIBLE_BUSINESS_MODEL",
  "UNWILLING_TO_FUND_REQUIRED_EXPENSES",
] as const;

export type HardBlockingReasonCode =
  (typeof hardBlockingReasonCodes)[number];

export const weakSignalCodes = [
  "ENTRY_CAPITAL_BELOW_REFERENCE",
  "ADDITIONAL_CAPITAL_UNCLEAR",
  "WEAK_LAUNCH_INTENT",
  "LIMITED_OPERATIONAL_CAPACITY",
  "REGION_NEEDS_REVIEW",
] as const;

export type WeakSignalCode = (typeof weakSignalCodes)[number];

export type QualificationReasonCode =
  | HardBlockingReasonCode
  | WeakSignalCode
  | "CAPITAL_UNKNOWN"
  | "CAPITAL_NOT_CONFIRMED"
  | "SEGMENT_UNDETERMINED"
  | "LAUNCH_INTENT_UNKNOWN"
  | "OPERATIONAL_READINESS_UNKNOWN"
  | "CITY_UNKNOWN"
  | "STARTING_UNITS_UNKNOWN"
  | "INVESTOR_SCALE_UNKNOWN"
  | "GOAL_UNKNOWN"
  | "BUSINESS_MODEL_READINESS_UNKNOWN"
  | "ADDITIONAL_EXPENSES_CONTEXT_UNKNOWN"
  | "PHONE_UNKNOWN"
  | "SMALL_BUSINESS_READY"
  | "INVESTOR_READY"
  | "INVESTOR_SCALE_CONFIRMED"
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
  | "phoneNumber"
  | "phoneConfirmed"
  | "segment"
  | "segmentConfidence"
  | "city"
  | "serviceability"
  | "budget"
  | "budgetConfirmed"
  | "availableCapital"
  | "availableCapitalConfirmed"
  | "entryBudget"
  | "additionalLaunchCapital"
  | "capitalScope"
  | "additionalExpensesReadiness"
  | "businessModelReadiness"
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

function capitalFacts(facts: QualificationFacts) {
  const legacyCapital =
    facts.budget !== null && facts.budgetConfirmed ? facts.budget : null;
  return {
    availableCapital: facts.availableCapital ?? legacyCapital,
    entryCapital:
      facts.entryBudget ?? facts.availableCapital ?? legacyCapital,
  };
}

export function evaluateQualification(
  facts: QualificationFacts,
  context: QualificationContext = {},
): QualificationDecision {
  const financialAssessment = assessFinancialReadiness(facts);
  const blockingReasons: HardBlockingReasonCode[] = [];
  const confirmedNoLaunchCapital =
    (facts.availableCapital === 0 && facts.availableCapitalConfirmed) ||
    (facts.availableCapital === null &&
      facts.budget === 0 &&
      facts.budgetConfirmed);
  if (facts.buyingIntent === "DECLINED") {
    blockingReasons.push("DECLINED_BY_LEAD");
  }
  if (facts.launchTiming === "NO_PLANS") {
    blockingReasons.push("NO_LAUNCH_INTENT");
  }
  if (confirmedNoLaunchCapital) {
    blockingReasons.push("NO_LAUNCH_CAPITAL");
  }
  if (facts.managementReadiness === "NOT_READY") {
    blockingReasons.push("NO_MANAGEMENT_INTERACTION");
  }
  if (facts.requiresGuaranteedIncome === true) {
    blockingReasons.push("REQUIRES_INCOME_GUARANTEE");
  }
  if (
    facts.rejectsBusinessModel === true ||
    facts.businessModelReadiness === "REJECTS"
  ) {
    blockingReasons.push("INCOMPATIBLE_BUSINESS_MODEL");
  }
  if (
    financialAssessment.financialBarrier ===
    "UNWILLING_TO_FUND_REQUIRED_EXPENSES"
  ) {
    blockingReasons.push("UNWILLING_TO_FUND_REQUIRED_EXPENSES");
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

  const { availableCapital, entryCapital } = capitalFacts(facts);
  const weakSignals: WeakSignalCode[] = [];
  if (
    facts.segment === "SMALL_BUSINESS" &&
    entryCapital !== null &&
    entryCapital < PARTNER_QUALIFICATION_POLICY.smallBusinessEntryCapitalReference
  ) {
    weakSignals.push("ENTRY_CAPITAL_BELOW_REFERENCE");
  }
  if (
    facts.segment === "SMALL_BUSINESS" &&
    financialAssessment.financialReadiness === "BORDERLINE"
  ) {
    weakSignals.push("ADDITIONAL_CAPITAL_UNCLEAR");
  }
  if (facts.launchTiming === "LATER") {
    weakSignals.push("WEAK_LAUNCH_INTENT");
  }
  if (facts.hasFreeTime === false || facts.managementReadiness === "LIMITED") {
    weakSignals.push("LIMITED_OPERATIONAL_CAPACITY");
  }
  if (facts.city !== null && facts.serviceability === "NEEDS_REVIEW") {
    weakSignals.push("REGION_NEEDS_REVIEW");
  }

  const informationGaps: QualificationReasonCode[] = [];
  if (availableCapital === null && facts.entryBudget === null) {
    informationGaps.push("CAPITAL_UNKNOWN");
  } else if (
    facts.availableCapital !== null &&
    !facts.availableCapitalConfirmed &&
    facts.entryBudget === null
  ) {
    informationGaps.push("CAPITAL_NOT_CONFIRMED");
  }
  if (facts.segment === "UNDETERMINED") {
    informationGaps.push("SEGMENT_UNDETERMINED");
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
  if (
    facts.segment === "INVESTOR" &&
    facts.startingUnits === null &&
    facts.scalingPotentialUnits === null
  ) {
    informationGaps.push("INVESTOR_SCALE_UNKNOWN");
  } else if (
    facts.segment !== "INVESTOR" &&
    facts.startingUnits === null
  ) {
    informationGaps.push("STARTING_UNITS_UNKNOWN");
  }
  if (facts.primaryGoal === null || facts.primaryGoal === "UNKNOWN") {
    informationGaps.push("GOAL_UNKNOWN");
  }
  if (
    facts.segment === "SMALL_BUSINESS" &&
    facts.businessModelReadiness === "UNKNOWN"
  ) {
    informationGaps.push("BUSINESS_MODEL_READINESS_UNKNOWN");
  }
  if (
    facts.segment === "SMALL_BUSINESS" &&
    financialAssessment.financialReadiness !== "HIGH" &&
    financialAssessment.financialReadiness !== "READY"
  ) {
    informationGaps.push("ADDITIONAL_EXPENSES_CONTEXT_UNKNOWN");
  }
  if (facts.phoneNumber === null || !facts.phoneConfirmed) {
    informationGaps.push("PHONE_UNKNOWN");
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

  const unresolvedFinancialRisk = weakSignals.some((signal) =>
    ["ENTRY_CAPITAL_BELOW_REFERENCE", "ADDITIONAL_CAPITAL_UNCLEAR"].includes(
      signal,
    ),
  );
  if (unresolvedFinancialRisk) {
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

  if (facts.segment === "INVESTOR") {
    const strongInvestorProfile =
      (availableCapital ?? 0) >=
        PARTNER_QUALIFICATION_POLICY.investorCapitalReference &&
      ((facts.startingUnits ?? 0) >= 7 ||
        (facts.scalingPotentialUnits ?? 0) >=
          PARTNER_QUALIFICATION_POLICY.investorScaleReference);
    return {
      status: strongInvestorProfile ? "PRIORITY" : "HOT",
      reason: strongInvestorProfile
        ? "INVESTOR_SCALE_CONFIRMED"
        : "INVESTOR_READY",
      reasonCodes: unique([
        strongInvestorProfile ? "INVESTOR_SCALE_CONFIRMED" : "INVESTOR_READY",
        ...weakSignals,
      ]),
      blockingReasons: [],
      weakSignals: unique(weakSignals),
      shouldHandoffToManager: true,
      nextAction: "HANDOFF_TO_MANAGER",
    };
  }

  return {
    status: weakSignals.length > 0 ? "WARM" : "HOT",
    reason: weakSignals[0] ?? "SMALL_BUSINESS_READY",
    reasonCodes: unique(["SMALL_BUSINESS_READY", ...weakSignals]),
    blockingReasons: [],
    weakSignals: unique(weakSignals),
    shouldHandoffToManager: true,
    nextAction: "HANDOFF_TO_MANAGER",
  };
}
