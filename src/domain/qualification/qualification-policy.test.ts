import { describe, expect, it } from "vitest";

import {
  evaluateServiceability,
  SERVICEABILITY_POLICY,
} from "../lead/serviceability";
import {
  evaluateQualification,
  type QualificationFacts,
} from "./qualification-policy";

function facts(overrides: Partial<QualificationFacts> = {}): QualificationFacts {
  return {
    segment: "UNDETERMINED",
    segmentConfidence: 0,
    city: null,
    serviceability: "NEEDS_REVIEW",
    budget: null,
    budgetConfirmed: false,
    availableCapital: null,
    availableCapitalConfirmed: false,
    entryBudget: null,
    additionalLaunchCapital: null,
    capitalScope: "UNKNOWN",
    additionalExpensesReadiness: "UNKNOWN",
    businessModelReadiness: "UNKNOWN",
    startingUnits: null,
    scalingPotentialUnits: null,
    hasFreeTime: null,
    launchTiming: null,
    managementReadiness: null,
    buyingIntent: null,
    requiresGuaranteedIncome: null,
    rejectsBusinessModel: null,
    ownsProperty: null,
    businessExperience: null,
    shortTermRentalExperience: null,
    primaryFear: null,
    primaryGoal: null,
    ...overrides,
  };
}

function readySmallBusiness(
  overrides: Partial<QualificationFacts> = {},
): QualificationFacts {
  return facts({
    segment: "SMALL_BUSINESS",
    segmentConfidence: 0.95,
    city: "Волгоград",
    serviceability: "SUPPORTED",
    availableCapital: 150_000,
    availableCapitalConfirmed: true,
    entryBudget: 50_000,
    additionalLaunchCapital: 100_000,
    capitalScope: "ADDITIONAL_AVAILABLE",
    additionalExpensesReadiness: "READY",
    businessModelReadiness: "ACCEPTS",
    startingUnits: 1,
    launchTiming: "WITHIN_MONTH",
    managementReadiness: "READY",
    primaryGoal: "ADDITIONAL_INCOME",
    ...overrides,
  });
}

function readyInvestor(
  overrides: Partial<QualificationFacts> = {},
): QualificationFacts {
  return facts({
    segment: "INVESTOR",
    segmentConfidence: 0.95,
    city: "Волгоград",
    serviceability: "SUPPORTED",
    availableCapital: 2_000_000,
    availableCapitalConfirmed: true,
    capitalScope: "UNKNOWN",
    businessModelReadiness: "CONSIDERING",
    startingUnits: 8,
    scalingPotentialUnits: 10,
    launchTiming: "WITHIN_MONTH",
    managementReadiness: "READY",
    primaryGoal: "INVESTMENT",
    ...overrides,
  });
}

describe("segment-aware partner qualification", () => {
  it("keeps unknown facts in information gathering", () => {
    expect(evaluateQualification(facts())).toMatchObject({
      status: "NEEDS_MORE_INFO",
      reason: "CAPITAL_UNKNOWN",
      blockingReasons: [],
      shouldHandoffToManager: false,
    });
  });

  it("accepts explicit first-stage and additional capital", () => {
    expect(evaluateQualification(readySmallBusiness())).toMatchObject({
      status: "HOT",
      reason: "SMALL_BUSINESS_READY",
      blockingReasons: [],
      shouldHandoffToManager: true,
    });
  });

  it("keeps 50,000 for the first stage in qualification", () => {
    expect(
      evaluateQualification(
        readySmallBusiness({
          availableCapital: null,
          availableCapitalConfirmed: false,
          entryBudget: 50_000,
          additionalLaunchCapital: null,
          capitalScope: "ENTRY_ONLY",
          additionalExpensesReadiness: "UNKNOWN",
        }),
      ),
    ).toMatchObject({
      status: "BORDERLINE",
      reason: "ADDITIONAL_CAPITAL_UNCLEAR",
      blockingReasons: [],
      shouldHandoffToManager: false,
      nextAction: "CONTINUE_QUALIFICATION",
    });
  });

  it("rejects explicit refusal to fund required launch expenses", () => {
    expect(
      evaluateQualification(
        readySmallBusiness({
          availableCapital: 50_000,
          entryBudget: null,
          additionalLaunchCapital: 0,
          capitalScope: "TOTAL_LIMIT",
          additionalExpensesReadiness: "NOT_READY",
        }),
      ),
    ).toMatchObject({
      status: "NO_FIT",
      reason: "UNWILLING_TO_FUND_REQUIRED_EXPENSES",
      blockingReasons: ["UNWILLING_TO_FUND_REQUIRED_EXPENSES"],
      shouldHandoffToManager: false,
      nextAction: "REJECT_POLITELY",
    });
  });

  it("can qualify 130,000 when required expenses are understood", () => {
    expect(
      evaluateQualification(
        readySmallBusiness({
          availableCapital: 130_000,
          additionalLaunchCapital: null,
          capitalScope: "TOTAL_LIMIT",
          additionalExpensesReadiness: "READY",
        }),
      ),
    ).toMatchObject({
      status: "HOT",
      shouldHandoffToManager: true,
    });
  });

  it("does not restore a universal low-capital hard blocker", () => {
    expect(
      evaluateQualification(
        facts({
          availableCapital: 5_000,
          availableCapitalConfirmed: true,
        }),
      ).status,
    ).not.toBe("NO_FIT");
  });

  it("prioritizes a ready investor by capital and scale", () => {
    expect(evaluateQualification(readyInvestor())).toMatchObject({
      status: "PRIORITY",
      reason: "INVESTOR_SCALE_CONFIRMED",
      shouldHandoffToManager: true,
    });
  });

  it("does not reject an investor who delegates daily operations", () => {
    expect(
      evaluateQualification(readyInvestor({ hasFreeTime: false })),
    ).toMatchObject({
      status: "PRIORITY",
      blockingReasons: [],
      shouldHandoffToManager: true,
    });
  });

  it("does not qualify ownership or five properties by itself", () => {
    expect(
      evaluateQualification(facts({ ownsProperty: true })),
    ).toMatchObject({
      status: "NEEDS_MORE_INFO",
      shouldHandoffToManager: false,
    });
  });

  it.each([
    ["DECLINED_BY_LEAD", { buyingIntent: "DECLINED" }],
    ["NO_LAUNCH_INTENT", { launchTiming: "NO_PLANS" }],
    ["NO_MANAGEMENT_INTERACTION", { managementReadiness: "NOT_READY" }],
    ["REQUIRES_INCOME_GUARANTEE", { requiresGuaranteedIncome: true }],
    ["INCOMPATIBLE_BUSINESS_MODEL", { businessModelReadiness: "REJECTS" }],
  ] as const)("keeps universal blocker %s", (reason, overrides) => {
    expect(evaluateQualification(facts(overrides))).toMatchObject({
      status: "NO_FIT",
      reason,
      shouldHandoffToManager: false,
      nextAction: "REJECT_POLITELY",
    });
  });

  it("never lets a human request override a confirmed blocker", () => {
    expect(
      evaluateQualification(facts({ buyingIntent: "DECLINED" }), {
        wantsHuman: true,
      }),
    ).toMatchObject({
      status: "NO_FIT",
      shouldHandoffToManager: false,
    });
  });
});

describe("serviceability policy", () => {
  it.each(SERVICEABILITY_POLICY.supportedCities)(
    "marks %s as supported",
    (city) => {
      expect(evaluateServiceability(city)).toBe("SUPPORTED");
    },
  );

  it("normalizes supported city names", () => {
    expect(evaluateServiceability(" г. пОдОлЬсК ")).toBe("SUPPORTED");
  });

  it("sends an unknown city to review rather than rejecting the lead", () => {
    expect(evaluateServiceability("Казань")).toBe("NEEDS_REVIEW");
    expect(evaluateServiceability(null)).toBe("NEEDS_REVIEW");
  });
});
