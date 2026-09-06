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
    city: null,
    serviceability: "NEEDS_REVIEW",
    budget: null,
    budgetConfirmed: false,
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

function readyFacts(overrides: Partial<QualificationFacts> = {}) {
  return facts({
    city: "Волгоград",
    serviceability: "SUPPORTED",
    budget: 150_000,
    budgetConfirmed: true,
    launchTiming: "WITHIN_MONTH",
    managementReadiness: "READY",
    primaryGoal: "ADDITIONAL_INCOME",
    startingUnits: 1,
    ...overrides,
  });
}

describe("partner qualification policy", () => {
  it("keeps an unknown or tentative budget in information gathering", () => {
    expect(evaluateQualification(facts())).toMatchObject({
      status: "NEEDS_MORE_INFO",
      reason: "BUDGET_UNKNOWN",
      blockingReasons: [],
      shouldHandoffToManager: false,
      nextAction: "CONTINUE_QUALIFICATION",
    });
    expect(
      evaluateQualification(facts({ budget: 300_000, budgetConfirmed: false })),
    ).toMatchObject({
      status: "NEEDS_MORE_INFO",
      reason: "BUDGET_NOT_CONFIRMED",
    });
  });

  it.each([0, 5_000, 50_000, 99_000])(
    "rejects a confirmed budget of %i as a hard blocker",
    (budget) => {
      expect(
        evaluateQualification(facts({ budget, budgetConfirmed: true })),
      ).toMatchObject({
        status: "NO_FIT",
        reason: "INSUFFICIENT_BUDGET",
        blockingReasons: ["INSUFFICIENT_BUDGET"],
        shouldHandoffToManager: false,
        nextAction: "REJECT_POLITELY",
      });
    },
  );

  it.each([100_000, 140_000, 149_999])(
    "keeps a confirmed budget of %i as borderline",
    (budget) => {
      expect(
        evaluateQualification(facts({ budget, budgetConfirmed: true })),
      ).toMatchObject({
        status: "BORDERLINE",
        reason: "BORDERLINE_BUDGET",
        weakSignals: ["BORDERLINE_BUDGET"],
        blockingReasons: [],
        shouldHandoffToManager: false,
      });
    },
  );

  it("accepts 150,000 as the minimum threshold and asks for missing facts", () => {
    const decision = evaluateQualification(
      facts({ budget: 150_000, budgetConfirmed: true }),
    );
    expect(decision.status).toBe("NEEDS_MORE_INFO");
    expect(decision.blockingReasons).toEqual([]);
    expect(decision.reasonCodes).not.toContain("INSUFFICIENT_BUDGET");
  });

  it("rejects only an explicit lack of launch intent", () => {
    expect(
      evaluateQualification(
        facts({ launchTiming: "NO_PLANS", budget: 150_000, budgetConfirmed: true }),
      ),
    ).toMatchObject({
      status: "NO_FIT",
      reason: "NO_LAUNCH_INTENT",
      nextAction: "REJECT_POLITELY",
    });
    expect(
      evaluateQualification(
        facts({ launchTiming: "UNKNOWN", budget: 150_000, budgetConfirmed: true }),
      ).status,
    ).toBe("NEEDS_MORE_INFO");
    expect(
      evaluateQualification(
        facts({ launchTiming: "LATER", budget: 150_000, budgetConfirmed: true }),
      ),
    ).toMatchObject({
      status: "BORDERLINE",
      weakSignals: ["WEAK_LAUNCH_INTENT"],
    });
  });

  it("rejects explicit operational refusal but not limited time", () => {
    expect(
      evaluateQualification(
        facts({ managementReadiness: "NOT_READY" }),
      ),
    ).toMatchObject({
      status: "NO_FIT",
      reason: "NO_OPERATIONAL_READINESS",
    });
    expect(
      evaluateQualification(
        facts({ hasFreeTime: false, budget: 150_000, budgetConfirmed: true }),
      ),
    ).toMatchObject({
      status: "BORDERLINE",
      weakSignals: ["LIMITED_OPERATIONAL_CAPACITY"],
    });
  });

  it("does not reject for no property, no experience, or fear", () => {
    const decision = evaluateQualification(
      readyFacts({
        startingUnits: 1,
        ownsProperty: false,
        businessExperience: "Нет опыта",
        shortTermRentalExperience: "Нет опыта",
        primaryFear: "FEAR_LOSE_MONEY",
      }),
    );
    expect(decision.status).toBe("HOT");
    expect(decision.blockingReasons).toEqual([]);
  });

  it("rejects only explicitly unsupported geography", () => {
    expect(
      evaluateQualification(
        readyFacts({ city: "Закрытый регион", serviceability: "UNSUPPORTED" }),
      ),
    ).toMatchObject({ status: "NO_FIT", reason: "UNSUPPORTED_REGION" });
    expect(
      evaluateQualification(
        readyFacts({ city: "Казань", serviceability: "NEEDS_REVIEW" }),
      ),
    ).toMatchObject({
      status: "WARM",
      reason: "REGION_NEEDS_REVIEW",
      shouldHandoffToManager: true,
    });
  });

  it("rejects an explicit decline", () => {
    expect(
      evaluateQualification(readyFacts({ buyingIntent: "DECLINED" })),
    ).toMatchObject({
      status: "NO_FIT",
      reason: "DECLINED_BY_LEAD",
      shouldHandoffToManager: false,
    });
  });

  it("rejects only a mandatory income guarantee, not a fear of losing money", () => {
    expect(
      evaluateQualification(readyFacts({ requiresGuaranteedIncome: true })),
    ).toMatchObject({
      status: "NO_FIT",
      reason: "REQUIRES_INCOME_GUARANTEE",
    });
    expect(
      evaluateQualification(
        readyFacts({ startingUnits: 1, primaryFear: "FEAR_LOSE_MONEY" }),
      ).status,
    ).toBe("HOT");
  });

  it("rejects an explicitly incompatible business model", () => {
    expect(
      evaluateQualification(readyFacts({ rejectsBusinessModel: true })),
    ).toMatchObject({
      status: "NO_FIT",
      reason: "INCOMPATIBLE_BUSINESS_MODEL",
    });
  });

  it("aggregates every confirmed hard blocker", () => {
    const decision = evaluateQualification(
      facts({
        budget: 5_000,
        budgetConfirmed: true,
        launchTiming: "NO_PLANS",
        managementReadiness: "NOT_READY",
      }),
    );
    expect(decision.status).toBe("NO_FIT");
    expect(decision.blockingReasons).toEqual([
      "INSUFFICIENT_BUDGET",
      "NO_LAUNCH_INTENT",
      "NO_OPERATIONAL_READINESS",
    ]);
  });

  it("produces qualified, hot, and priority outcomes by confirmed scale", () => {
    expect(evaluateQualification(readyFacts({ startingUnits: 0 }))).toMatchObject({
      status: "QUALIFIED",
      shouldHandoffToManager: true,
      nextAction: "HANDOFF_TO_MANAGER",
    });
    expect(evaluateQualification(readyFacts({ startingUnits: 1 })).status).toBe(
      "HOT",
    );
    expect(evaluateQualification(readyFacts({ startingUnits: 5 })).status).toBe(
      "PRIORITY",
    );
    expect(
      evaluateQualification(
        readyFacts({ startingUnits: 1, scalingPotentialUnits: 5 }),
      ).status,
    ).toBe("PRIORITY");
  });

  it("never lets a human request override a hard blocker", () => {
    expect(
      evaluateQualification(
        facts({ budget: 5_000, budgetConfirmed: true }),
        { wantsHuman: true },
      ),
    ).toMatchObject({
      status: "NO_FIT",
      shouldHandoffToManager: false,
      nextAction: "REJECT_POLITELY",
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
