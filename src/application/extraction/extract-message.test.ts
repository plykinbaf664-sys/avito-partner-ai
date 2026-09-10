import { describe, expect, it } from "vitest";

import { FakeLLMProvider } from "../../integrations/fake/fake-llm-provider";

import {
  createMessageExtractor,
  extractedMessageSchema,
} from "./extract-message";

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
          availableCapital: -1,
          availableCapitalConfirmed: false,
          entryBudget: -1,
          additionalLaunchCapital: -1,
          capitalScope: "UNKNOWN",
          additionalExpensesReadiness: "UNKNOWN",
          businessModelReadiness: "UNKNOWN",
          calculationUnits: -1,
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
    expect(llm.requests[0]?.systemPrompt).toContain("SECURITY BOUNDARY");
    const untrustedEnvelope = JSON.parse(llm.requests[0]!.userMessage) as {
      type: string;
      text: string;
    };
    expect(untrustedEnvelope.type).toBe("UNTRUSTED_USER_CONTENT");
    expect(untrustedEnvelope.text).toBeTruthy();
  });

  it("rejects negative and technically unreasonable extracted values", () => {
    const result = extractedMessageSchema.safeParse({
      facts: {
        availableCapital: -2,
        startingUnits: -1,
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (issue) => issue.path.join(".") === "facts.availableCapital",
      ),
    ).toBe(true);
    expect(
      result.error.issues.some(
        (issue) => issue.path.join(".") === "facts.startingUnits",
      ),
    ).toBe(true);
  });

  it("normalizes an ambiguous 50,000 response to first-stage capital", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        intent: "QUALIFICATION_INFORMATION",
        facts: {
          city: null,
          budget: 50_000,
          budgetConfirmed: true,
          availableCapital: 50_000,
          availableCapitalConfirmed: false,
          entryBudget: 50_000,
          additionalLaunchCapital: -1,
          capitalScope: "ENTRY_ONLY",
          additionalExpensesReadiness: "UNKNOWN",
          businessModelReadiness: "UNKNOWN",
          calculationUnits: -1,
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
        confidence: 0.9,
        uncertainty: [],
      }),
    ]);

    const result = await createMessageExtractor({ llmProvider: llm })(
      "У меня есть 50 тысяч",
    );

    expect(result.extraction.facts).toMatchObject({
      entryBudget: 50_000,
      availableCapital: null,
      availableCapitalConfirmed: false,
      capitalScope: "ENTRY_ONLY",
    });
  });

  it("recognizes an explicit willingness to work with the management company", async () => {
    const statement = "Готов работать с управляющей компанией";
    const llm = new FakeLLMProvider([
      JSON.stringify({
        intent: "QUALIFICATION_INFORMATION",
        facts: {
          phoneNumber: "",
          phoneConfirmed: false,
          city: null,
          budget: null,
          budgetConfirmed: false,
          availableCapital: -1,
          availableCapitalConfirmed: false,
          entryBudget: -1,
          additionalLaunchCapital: -1,
          capitalScope: "UNKNOWN",
          additionalExpensesReadiness: "UNKNOWN",
          businessModelReadiness: "UNKNOWN",
          calculationUnits: -1,
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
          objections: [statement],
          possiblePrimaryFear: null,
          possibleSecondaryFear: null,
          wantsHuman: false,
        },
        confidence: 0.9,
        uncertainty: [],
      }),
    ]);

    const result = await createMessageExtractor({ llmProvider: llm })(statement);

    expect(result.extraction.facts.managementReadiness).toBe("READY");
    expect(result.extraction.signals.objections).toEqual([]);
  });

  it("normalizes an explicitly provided phone number", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        intent: "QUALIFICATION_INFORMATION",
        facts: {
          phoneNumber: "+7 999 123-45-67",
          phoneConfirmed: true,
          city: null,
          budget: null,
          budgetConfirmed: false,
          availableCapital: -1,
          availableCapitalConfirmed: false,
          entryBudget: -1,
          additionalLaunchCapital: -1,
          capitalScope: "UNKNOWN",
          additionalExpensesReadiness: "UNKNOWN",
          businessModelReadiness: "UNKNOWN",
          calculationUnits: -1,
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
        confidence: 0.99,
        uncertainty: [],
      }),
    ]);

    const result = await createMessageExtractor({ llmProvider: llm })(
      "Мой номер +7 999 123-45-67",
    );
    expect(result.extraction.facts).toMatchObject({
      phoneNumber: "+79991234567",
      phoneConfirmed: true,
    });
  });
});
