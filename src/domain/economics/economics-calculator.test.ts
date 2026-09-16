import { describe, expect, it } from "vitest";

import {
  calculateLaunchBudgetRange,
  calculateEconomicsEstimate,
  GENERAL_RENT_RANGE_REFERENCE,
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
        "Это ориентир, а не гарантия: фактический результат зависит от конкретного объекта, загрузки и расходов.",
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
      baseLaunchReference: 150_000,
      furnishingReserveReference: 30_000,
      isExact: false,
    });
  });

  it("calculates the approved one-unit examples and a multi-unit range", () => {
    expect(calculateLaunchBudgetRange({ units: 1 })).toMatchObject({
      totalMin: 150_000,
      totalMax: 180_000,
      serviceFee: 50_000,
      preparationPerUnit: 30_000,
      isExact: false,
    });
    expect(calculateLaunchBudgetRange({ units: 2 })).toMatchObject({
      totalMin: 250_000,
      totalMax: 310_000,
    });
    expect(GENERAL_RENT_RANGE_REFERENCE).toMatchObject({
      rentMin: 35_000,
      rentMax: 50_000,
      source: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("calculates a sourced regional range without inventing a precise price", () => {
    const range = calculateLaunchBudgetRange({
      units: 1,
      rentReference: {
        city: "Тестовый город",
        region: "Тестовый регион",
        rentMin: 25_000,
        rentMax: 35_000,
        updatedAt: "2026-09-01",
        source: "Тестовый подтверждённый источник",
      },
    });
    expect(range).toMatchObject({
      totalMin: 130_000,
      totalMax: 150_000,
      isExact: false,
      reference: { source: "Тестовый подтверждённый источник" },
    });
  });
});
