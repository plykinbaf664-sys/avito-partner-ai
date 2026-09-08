import { describe, expect, it } from "vitest";

import type { Lead } from "./lead";
import { assessLeadSegment } from "./lead-segment";

type SegmentFacts = Parameters<typeof assessLeadSegment>[0];

function facts(overrides: Partial<SegmentFacts> = {}): SegmentFacts {
  return {
    availableCapital: null,
    entryBudget: null,
    startingUnits: null,
    scalingPotentialUnits: null,
    primaryGoal: null,
    businessModelReadiness: "UNKNOWN",
    ...overrides,
  } satisfies Pick<
    Lead,
    | "availableCapital"
    | "entryBudget"
    | "startingUnits"
    | "scalingPotentialUnits"
    | "primaryGoal"
    | "businessModelReadiness"
  >;
}

describe("lead segmentation", () => {
  it("keeps sparse information undetermined", () => {
    expect(assessLeadSegment(facts())).toEqual({
      segment: "UNDETERMINED",
      confidence: 0.15,
    });
  });

  it("recognizes a one-unit small-business start", () => {
    expect(
      assessLeadSegment(
        facts({
          availableCapital: 50_000,
          startingUnits: 1,
          businessModelReadiness: "ACCEPTS",
        }),
      ),
    ).toEqual({ segment: "SMALL_BUSINESS", confidence: 0.95 });
  });

  it("recognizes 70,000 and one starting unit as small business", () => {
    expect(
      assessLeadSegment(
        facts({ availableCapital: 70_000, startingUnits: 1 }),
      ),
    ).toMatchObject({ segment: "SMALL_BUSINESS" });
  });

  it("recognizes a capital-and-scale investor profile", () => {
    expect(
      assessLeadSegment(
        facts({
          availableCapital: 2_000_000,
          startingUnits: 8,
          scalingPotentialUnits: 10,
          primaryGoal: "INVESTMENT",
        }),
      ),
    ).toEqual({ segment: "INVESTOR", confidence: 0.95 });
  });

  it("keeps start at one as small business despite ambitious scaling", () => {
    expect(
      assessLeadSegment(
        facts({ startingUnits: 1, scalingPotentialUnits: 10 }),
      ).segment,
    ).toBe("SMALL_BUSINESS");
  });
});
