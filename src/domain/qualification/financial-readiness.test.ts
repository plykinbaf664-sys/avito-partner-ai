import { describe, expect, it } from "vitest";

import type { FinancialReadinessFacts } from "./financial-readiness";
import { assessFinancialReadiness } from "./financial-readiness";

function facts(
  overrides: Partial<FinancialReadinessFacts> = {},
): FinancialReadinessFacts {
  return {
    availableCapital: null,
    availableCapitalConfirmed: false,
    entryBudget: null,
    additionalLaunchCapital: null,
    capitalScope: "UNKNOWN",
    additionalExpensesReadiness: "UNKNOWN",
    ...overrides,
  };
}

describe("small-business financial readiness", () => {
  it("treats 50,000 for the first stage as incomplete context", () => {
    expect(assessFinancialReadiness(facts({ entryBudget: 50_000 }))).toEqual({
      launchCostAwareness: "UNKNOWN",
      financialReadiness: "BORDERLINE",
      financialBarrier: "ADDITIONAL_LAUNCH_CAPITAL_UNKNOWN",
    });
  });

  it("recognizes explicit first-stage and additional capital", () => {
    expect(
      assessFinancialReadiness(
        facts({
          availableCapital: 150_000,
          availableCapitalConfirmed: true,
          entryBudget: 50_000,
          additionalLaunchCapital: 100_000,
          capitalScope: "ADDITIONAL_AVAILABLE",
          additionalExpensesReadiness: "READY",
        }),
      ),
    ).toEqual({
      launchCostAwareness: "CONFIRMED",
      financialReadiness: "HIGH",
      financialBarrier: null,
    });
  });

  it("treats confirmed 150,000 as strong but not exact capital", () => {
    expect(
      assessFinancialReadiness(
        facts({
          availableCapital: 150_000,
          availableCapitalConfirmed: true,
        }),
      ),
    ).toEqual({
      launchCostAwareness: "UNKNOWN",
      financialReadiness: "HIGH",
      financialBarrier: null,
    });
  });

  it("finds incompatibility only from explicit refusal plus insufficient total", () => {
    expect(
      assessFinancialReadiness(
        facts({
          availableCapital: 50_000,
          availableCapitalConfirmed: true,
          additionalLaunchCapital: 0,
          capitalScope: "TOTAL_LIMIT",
          additionalExpensesReadiness: "NOT_READY",
        }),
      ),
    ).toEqual({
      launchCostAwareness: "REJECTED",
      financialReadiness: "INCOMPATIBLE",
      financialBarrier: "UNWILLING_TO_FUND_REQUIRED_EXPENSES",
    });
  });
});
