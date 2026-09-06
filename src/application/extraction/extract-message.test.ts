import { describe, expect, it } from "vitest";

import { FakeLLMProvider } from "../../integrations/fake/fake-llm-provider";

import { createMessageExtractor } from "./extract-message";

function countUnionParameters(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, item) => total + countUnionParameters(item),
      0,
    );
  }
  if (value === null || typeof value !== "object") return 0;

  const record = value as Record<string, unknown>;
  const isUnion = Array.isArray(record.anyOf) || Array.isArray(record.type);
  return (
    (isUnion ? 1 : 0) +
    Object.values(record).reduce<number>(
      (total, item) => total + countUnionParameters(item),
      0,
    )
  );
}

describe("message extraction schema", () => {
  it("stays within Anthropic's structured-output union limit", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        intent: "GENERAL_INTEREST",
        facts: {
          city: null,
          budget: null,
          budgetConfirmed: false,
          startingUnits: null,
          scalingPotentialUnits: null,
          hasFreeTime: null,
          availableTimeDetails: null,
          businessExperience: null,
          shortTermRentalExperience: null,
          ownsProperty: null,
          desiredIncome: null,
          primaryGoal: "UNKNOWN",
          launchTiming: null,
          managementReadiness: null,
          requiresGuaranteedIncome: null,
          rejectsBusinessModel: null,
        },
        signals: {
          questions: [],
          objections: [],
          possiblePrimaryFear: null,
          possibleSecondaryFear: null,
          wantsHuman: false,
        },
        confidence: 0.8,
        uncertainty: [],
      }),
    ]);

    await createMessageExtractor({ llmProvider: llm })("Просто интересуюсь");

    expect(countUnionParameters(llm.requests[0]?.jsonSchema)).toBeLessThanOrEqual(
      16,
    );
  });
});
