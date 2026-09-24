import { describe, expect, it } from "vitest";

import {
  calculateAffordableObjectCount,
  calculateLaunchBudgetRange,
  calculateEconomicsEstimate,
  buildApprovedEconomicsContext,
  findApprovedRentReference,
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

  it("resolves the canonical Moscow geography for economics aliases", () => {
    expect(findApprovedRentReference("Московская область")).toMatchObject({
      city: "Москва",
      rentMin: 50_000,
      rentMax: 50_000,
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

  it("calculates complete objects from a one-time service fee and per-object costs", () => {
    const regional = calculateAffordableObjectCount({
      availableCapital: 500_000,
      rentReference: {
        city: "Регион",
        region: "Тестовый регион",
        rentMin: 35_000,
        rentMax: 35_000,
        updatedAt: "2026-09-01",
        source: "Подтверждённый тестовый ориентир",
      },
    });
    expect(regional).toMatchObject({
      maxUnitsAtMinCost: 4,
      maxUnitsAtMaxCost: 4,
      totalStartupCostAtMinCost: 450_000,
      totalStartupCostAtMaxCost: 450_000,
    });
    expect(calculateLaunchBudgetRange({
      units: 5,
      rentReference: {
        city: "Регион",
        region: "Тестовый регион",
        rentMin: 35_000,
        rentMax: 35_000,
        updatedAt: "2026-09-01",
        source: "Подтверждённый тестовый ориентир",
      },
    })?.totalMin).toBe(550_000);

    const moscow = calculateAffordableObjectCount({
      availableCapital: 500_000,
      rentReference: {
        city: "Москва",
        region: "Москва",
        rentMin: 50_000,
        rentMax: 50_000,
        updatedAt: "2026-09-01",
        source: "Подтверждённый тестовый ориентир",
      },
    });
    expect(moscow).toMatchObject({
      maxUnitsAtMinCost: 3,
      maxUnitsAtMaxCost: 3,
      totalStartupCostAtMinCost: 440_000,
      totalStartupCostAtMaxCost: 440_000,
    });
    expect(calculateLaunchBudgetRange({
      units: 4,
      rentReference: {
        city: "Москва",
        region: "Москва",
        rentMin: 50_000,
        rentMax: 50_000,
        updatedAt: "2026-09-01",
        source: "Подтверждённый тестовый ориентир",
      },
    })?.totalMin).toBe(570_000);
  });

  it("builds a bounded capability context instead of asking the model to invent economics", () => {
    const context = buildApprovedEconomicsContext({ availableCapital: 250_000 });

    expect(context.launchFee).toBe(50_000);
    expect(context.preparationPerObject).toBe(30_000);
    expect(context.incomePerObject).toBe(20_000);
    expect(context.depositMonths).toBe(1);
    expect(context.depositAssumption).toMatch(/допущение|зависит/iu);
    expect(context.scenarios.map((scenario) => scenario.affordableObjectCount?.maxUnitsAtMinCost))
      .toEqual([2, 1]);
    expect(context.scenarios.map((scenario) => scenario.affordableObjectCount?.remainingReserveAtMinCost))
      .toEqual([0, 70_000]);
    expect(context.scenarios.map((scenario) => scenario.requestedUnitsLaunch))
      .toEqual([null, null]);
  });
});
