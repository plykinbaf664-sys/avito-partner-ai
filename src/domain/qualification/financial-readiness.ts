import { LAUNCH_COST_REFERENCE } from "../economics/economics-calculator";
import type { Lead } from "../lead/lead";

export const launchCostAwarenessValues = [
  "CONFIRMED",
  "PARTIAL",
  "REJECTED",
  "UNKNOWN",
] as const;

export type LaunchCostAwareness =
  (typeof launchCostAwarenessValues)[number];

export const financialReadinessValues = [
  "HIGH",
  "READY",
  "BORDERLINE",
  "INCOMPATIBLE",
  "UNKNOWN",
] as const;

export type FinancialReadiness = (typeof financialReadinessValues)[number];

export type FinancialBarrier =
  | "ADDITIONAL_LAUNCH_CAPITAL_UNKNOWN"
  | "UNWILLING_TO_FUND_REQUIRED_EXPENSES"
  | null;

export interface FinancialReadinessAssessment {
  launchCostAwareness: LaunchCostAwareness;
  financialReadiness: FinancialReadiness;
  financialBarrier: FinancialBarrier;
}

export type FinancialReadinessFacts = Pick<
  Lead,
  | "availableCapital"
  | "availableCapitalConfirmed"
  | "entryBudget"
  | "additionalLaunchCapital"
  | "capitalScope"
  | "additionalExpensesReadiness"
>;

export function assessFinancialReadiness(
  facts: FinancialReadinessFacts,
): FinancialReadinessAssessment {
  const launchCostAwareness: LaunchCostAwareness =
    facts.additionalExpensesReadiness === "NOT_READY"
      ? "REJECTED"
      : facts.additionalExpensesReadiness === "READY" ||
    facts.additionalLaunchCapital !== null ||
    facts.capitalScope === "ADDITIONAL_AVAILABLE"
        ? "CONFIRMED"
        : facts.additionalExpensesReadiness === "LIMITED"
          ? "PARTIAL"
          : "UNKNOWN";

  const statedCapital = facts.availableCapital ?? facts.entryBudget;
  const explicitlyUnwillingWithInsufficientTotal =
    facts.additionalExpensesReadiness === "NOT_READY" &&
    statedCapital !== null &&
    statedCapital < LAUNCH_COST_REFERENCE.baseLaunchReference &&
    (facts.additionalLaunchCapital ?? 0) <= 0;

  if (explicitlyUnwillingWithInsufficientTotal) {
    return {
      launchCostAwareness,
      financialReadiness: "INCOMPATIBLE",
      financialBarrier: "UNWILLING_TO_FUND_REQUIRED_EXPENSES",
    };
  }

  const reasonableLaunchCapital =
    LAUNCH_COST_REFERENCE.baseLaunchReference +
    LAUNCH_COST_REFERENCE.furnishingReserveReference;
  const combinedExplicitCapital =
    facts.entryBudget !== null && facts.additionalLaunchCapital !== null
      ? facts.entryBudget + facts.additionalLaunchCapital
      : null;

  if (
    launchCostAwareness !== "REJECTED" &&
    ((facts.availableCapitalConfirmed &&
      (facts.availableCapital ?? 0) >= reasonableLaunchCapital) ||
      (combinedExplicitCapital ?? 0) >= reasonableLaunchCapital)
  ) {
    return {
      launchCostAwareness,
      financialReadiness: "HIGH",
      financialBarrier: null,
    };
  }

  if (
    launchCostAwareness === "CONFIRMED" &&
    ((facts.availableCapitalConfirmed &&
      (facts.availableCapital ?? 0) >=
        LAUNCH_COST_REFERENCE.baseLaunchReference) ||
      (combinedExplicitCapital ?? 0) >=
        LAUNCH_COST_REFERENCE.baseLaunchReference)
  ) {
    return {
      launchCostAwareness,
      financialReadiness: "READY",
      financialBarrier: null,
    };
  }

  if (statedCapital === null) {
    return {
      launchCostAwareness,
      financialReadiness: "UNKNOWN",
      financialBarrier: "ADDITIONAL_LAUNCH_CAPITAL_UNKNOWN",
    };
  }

  return {
    launchCostAwareness,
    financialReadiness: "BORDERLINE",
    financialBarrier: "ADDITIONAL_LAUNCH_CAPITAL_UNKNOWN",
  };
}
