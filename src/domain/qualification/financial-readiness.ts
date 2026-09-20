import {
  calculateLaunchBudgetRange,
  findApprovedRentReference,
  GENERAL_RENT_RANGE_REFERENCE,
  type LaunchBudgetRange,
} from "../economics/economics-calculator";
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
  | "CAPITAL_BELOW_LAUNCH_RANGE"
  | null;

export interface FinancialReadinessAssessment {
  launchCostAwareness: LaunchCostAwareness;
  financialReadiness: FinancialReadiness;
  financialBarrier: FinancialBarrier;
  launchBudgetRange: LaunchBudgetRange;
  usesCitySpecificRent: boolean;
}

export type FinancialReadinessFacts = Pick<
  Lead,
  | "availableCapital"
  | "availableCapitalConfirmed"
  | "entryBudget"
  | "additionalLaunchCapital"
  | "capitalScope"
  | "additionalExpensesReadiness"
> & Partial<Pick<
  Lead,
  "city" | "budget" | "budgetConfirmed" | "startingUnits" | "objections"
>>;

function confirmedTotalCapital(facts: FinancialReadinessFacts): number | null {
  if (
    facts.availableCapitalConfirmed &&
    facts.availableCapital !== null &&
    facts.capitalScope !== "ENTRY_ONLY"
  ) {
    return facts.availableCapital;
  }
  if (
    facts.entryBudget !== null &&
    facts.additionalLaunchCapital !== null &&
    facts.capitalScope === "ADDITIONAL_AVAILABLE"
  ) {
    return facts.entryBudget + facts.additionalLaunchCapital;
  }
  if (facts.budgetConfirmed && facts.budget != null && facts.capitalScope !== "ENTRY_ONLY") {
    return facts.budget;
  }
  return null;
}

export function assessFinancialReadiness(
  facts: FinancialReadinessFacts,
): FinancialReadinessAssessment {
  const cityReference = findApprovedRentReference(facts.city ?? null);
  const launchBudgetRange = calculateLaunchBudgetRange({
    units: facts.startingUnits ?? 1,
    rentReference: cityReference ?? GENERAL_RENT_RANGE_REFERENCE,
  })!;
  const totalCapital = confirmedTotalCapital(facts);
  const confirmedCapitalCoversFullRange =
    totalCapital !== null && totalCapital >= launchBudgetRange.totalMax;
  const explicitExpenseRefusal =
    facts.additionalExpensesReadiness === "NOT_READY" &&
    (facts.objections?.length ?? 0) > 0;
  const launchCostAwareness: LaunchCostAwareness =
    facts.additionalExpensesReadiness === "NOT_READY"
      ? confirmedCapitalCoversFullRange && !explicitExpenseRefusal
        ? "CONFIRMED"
        : "REJECTED"
      : facts.additionalExpensesReadiness === "READY" ||
          facts.additionalLaunchCapital !== null ||
          facts.capitalScope === "ADDITIONAL_AVAILABLE"
        ? "CONFIRMED"
        : facts.additionalExpensesReadiness === "LIMITED"
          ? "PARTIAL"
          : "UNKNOWN";

  // A confirmed TOTAL_LIMIT is the complete amount available for the launch,
  // including rent, deposit and preparation. If it covers the full approved
  // range, an inconsistent NOT_READY extraction must not create a false
  // rejection. Explicitly insufficient totals remain blocked below.
  if (
    facts.additionalExpensesReadiness === "NOT_READY" &&
    (!confirmedCapitalCoversFullRange || explicitExpenseRefusal)
  ) {
    return {
      launchCostAwareness,
      financialReadiness: "INCOMPATIBLE",
      financialBarrier: "UNWILLING_TO_FUND_REQUIRED_EXPENSES",
      launchBudgetRange,
      usesCitySpecificRent: cityReference !== null,
    };
  }

  if (totalCapital !== null && totalCapital < launchBudgetRange.totalMin) {
    return {
      launchCostAwareness,
      financialReadiness: "INCOMPATIBLE",
      financialBarrier: "CAPITAL_BELOW_LAUNCH_RANGE",
      launchBudgetRange,
      usesCitySpecificRent: cityReference !== null,
    };
  }

  if (confirmedCapitalCoversFullRange) {
    return {
      launchCostAwareness,
      financialReadiness: "HIGH",
      financialBarrier: null,
      launchBudgetRange,
      usesCitySpecificRent: cityReference !== null,
    };
  }

  if (
    launchCostAwareness === "CONFIRMED" &&
    (totalCapital !== null
      ? totalCapital >= launchBudgetRange.totalMin
      : facts.availableCapital === null && facts.entryBudget === null)
  ) {
    return {
      launchCostAwareness,
      financialReadiness: "READY",
      financialBarrier: null,
      launchBudgetRange,
      usesCitySpecificRent: cityReference !== null,
    };
  }

  if (totalCapital === null && facts.availableCapital === null && facts.entryBudget === null) {
    return {
      launchCostAwareness,
      financialReadiness: "UNKNOWN",
      financialBarrier: "ADDITIONAL_LAUNCH_CAPITAL_UNKNOWN",
      launchBudgetRange,
      usesCitySpecificRent: cityReference !== null,
    };
  }

  return {
    launchCostAwareness,
    financialReadiness: "BORDERLINE",
    financialBarrier: "ADDITIONAL_LAUNCH_CAPITAL_UNKNOWN",
    launchBudgetRange,
    usesCitySpecificRent: cityReference !== null,
  };
}
