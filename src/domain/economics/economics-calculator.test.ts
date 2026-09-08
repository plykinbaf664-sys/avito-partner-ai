import { describe, expect, it } from "vitest";

import {
  calculateEconomicsEstimate,
  LAUNCH_COST_REFERENCE,
} from "./economics-calculator";

describe("partner economics calculator", () => {
  it.each([
    [1, 20_000],
    [3, 60_000],
    [5, 100_000],
    [10, 200_000],
  ])("calculates %i units deterministically", (units, income) => {
    expect(calculateEconomicsEstimate(units)).toEqual({
      units,
      estimatedMonthlyIncome: income,
      incomePerUnitReference: 20_000,
      isGuaranteed: false,
      disclaimer:
        "Это ориентир, а не гарантия: фактический результат зависит от конкретного объекта и условий.",
    });
  });

  it("does not infer units from capital or invalid input", () => {
    expect(calculateEconomicsEstimate(null)).toBeNull();
    expect(calculateEconomicsEstimate(0)).toBeNull();
  });

  it("keeps launch costs as non-exact reference data", () => {
    expect(LAUNCH_COST_REFERENCE).toEqual({
      serviceFeeReference: 50_000,
      rentReference: 35_000,
      depositReference: 35_000,
      baseLaunchReference: 120_000,
      furnishingReserveReference: 20_000,
      isExact: false,
    });
  });
});
