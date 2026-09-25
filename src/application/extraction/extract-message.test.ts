import { describe, expect, it } from "vitest";

import { FakeLLMProvider } from "../../integrations/fake/fake-llm-provider";
import type { Lead } from "../../domain/lead/lead";

import {
  createMessageExtractor,
  extractPhoneNumberFromText,
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

function structuredExtractionReply(overrides: {
  intent?: "QUESTION" | "QUALIFICATION_INFORMATION";
  city?: string | null;
  questions?: string[];
  objections?: string[];
  requiresSubstantiveAnswer?: boolean;
  questionKind?: "CONVERSATION_META" | "BUSINESS_INFORMATION";
} = {}): string {
  return JSON.stringify({
    intent: overrides.intent ?? "QUALIFICATION_INFORMATION",
    facts: {
      phoneNumber: "",
      phoneConfirmed: false,
      city: overrides.city ?? null,
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
      buyingIntent: "UNKNOWN",
      launchTiming: null,
      managementReadiness: null,
      requiresGuaranteedIncome: null,
      rejectsBusinessModel: null,
    },
    signals: {
      questions: overrides.questions ?? [],
      objections: overrides.objections ?? [],
      possiblePrimaryFear: null,
      possibleSecondaryFear: null,
      wantsHuman: false,
      previousQuestionResponse: "NOT_A_RESPONSE",
      resolvedQuestion: "",
      contextualReference: false,
      questionKind: overrides.questionKind ?? "BUSINESS_INFORMATION",
      needsStartupScaleRecommendation: false,
      requiresSubstantiveAnswer:
        overrides.requiresSubstantiveAnswer ?? false,
    },
    confidence: 0.9,
    uncertainty: [],
  });
}

it("normalizes obvious Russian phone formats deterministically", () => {
  expect(extractPhoneNumberFromText("89049163020")).toBe("+79049163020");
  expect(extractPhoneNumberFromText("+79049163020")).toBe("+79049163020");
  expect(extractPhoneNumberFromText("8 904 916 30 20")).toBe("+79049163020");
  expect(extractPhoneNumberFromText("+7 (904) 916-30-20")).toBe("+79049163020");
  expect(extractPhoneNumberFromText("50 000 рублей")).toBeNull();
});

describe("message extraction schema", () => {
  it("does not turn an unspecified amount or scale into a confirmed zero", async () => {
    const output = JSON.parse(structuredExtractionReply({ intent: "QUESTION" }));
    output.facts.budget = 0;
    output.facts.budgetConfirmed = true;
    output.facts.availableCapital = 0;
    output.facts.availableCapitalConfirmed = true;
    output.facts.capitalScope = "TOTAL_LIMIT";
    output.facts.calculationUnits = 0;
    const result = await createMessageExtractor({
      llmProvider: new FakeLLMProvider([JSON.stringify(output)]),
    })("Пока хочу понять, как устроен бизнес");

    expect(result.extraction.facts).toMatchObject({
      budget: null,
      budgetConfirmed: false,
      availableCapital: null,
      availableCapitalConfirmed: false,
      capitalScope: "UNKNOWN",
      calculationUnits: null,
    });
  });

  it("requires a resolved referent for a short contextual question before using it", async () => {
    const unresolved = JSON.parse(structuredExtractionReply({
      intent: "QUESTION",
      questions: ["А сколько надо?"],
      requiresSubstantiveAnswer: true,
    }));
    unresolved.signals.contextualReference = true;
    unresolved.signals.questionKind = "CLARIFICATION";
    const resolved = structuredClone(unresolved);
    resolved.signals.resolvedQuestion = "Сколько личного времени в день потребуется партнёру?";
    const llm = new FakeLLMProvider([
      JSON.stringify(unresolved),
      JSON.stringify(resolved),
    ]);
    const result = await createMessageExtractor({ llmProvider: llm })({
      text: "А сколько надо?",
      recentMessages: [{ direction: "OUTBOUND", content: "Сколько времени сможете уделять запуску?" }],
    });
    expect(result.extraction.signals.resolvedQuestion).toContain("времени");
    expect(result.diagnostics).toMatchObject({
      status: "RECOVERED",
      attempts: 2,
      failureReasons: ["UNRESOLVED_CONTEXTUAL_REFERENCE"],
    });
  });

  it("degrades safely after bounded malformed JSON repair attempts", async () => {
    const llm = new FakeLLMProvider(["not-json", "still-not-json"]);

    const result = await createMessageExtractor({ llmProvider: llm })(
      "Меня интересует доход?",
    );

    expect(llm.callCount).toBe(2);
    expect(result.diagnostics).toEqual({
      status: "DEGRADED",
      attempts: 2,
      failureReasons: ["MALFORMED_JSON", "MALFORMED_JSON"],
      discardedSignalFields: [],
    });
    expect(result.extraction.facts).toMatchObject({
      city: null,
      availableCapital: null,
      desiredIncome: null,
    });
    expect(result.extraction.signals).toMatchObject({
      questions: [],
      objections: [],
      wantsHuman: false,
    });
  });

  it("degrades safely after bounded schema-invalid repair attempts", async () => {
    const invalid = JSON.stringify({
      intent: "QUESTION",
      facts: { city: "Москва" },
      signals: { questions: ["Меня интересует доход?"] },
    });
    const llm = new FakeLLMProvider([invalid, invalid]);

    const result = await createMessageExtractor({ llmProvider: llm })(
      "Меня интересует доход?",
    );

    expect(llm.callCount).toBe(2);
    expect(result.diagnostics).toMatchObject({
      status: "DEGRADED",
      attempts: 2,
      failureReasons: ["SCHEMA_INVALID", "SCHEMA_INVALID"],
    });
    expect(result.extraction.facts.city).toBeNull();
    expect(result.extraction.signals.questions).toEqual([]);
  });

  it("keeps valid facts but discards ungrounded semantic signals after repair", async () => {
    const ungrounded = structuredExtractionReply({
      intent: "QUESTION",
      city: "Москва",
      questions: ["Какая юридическая гарантия прибыли закреплена договором?"],
      objections: ["Пользователь отказывается оплачивать услугу"],
      requiresSubstantiveAnswer: true,
    });
    const llm = new FakeLLMProvider([ungrounded, ungrounded]);

    const result = await createMessageExtractor({ llmProvider: llm })({
      text: "А сколько нужно?",
      recentMessages: [{
        direction: "OUTBOUND",
        actor: "AI",
        content: "Сколько времени в день сможете уделять проекту?",
      }],
    });

    expect(llm.callCount).toBe(2);
    expect(result.diagnostics).toMatchObject({
      status: "DEGRADED",
      attempts: 2,
      failureReasons: ["UNGROUNDED_SIGNALS", "UNGROUNDED_SIGNALS"],
      discardedSignalFields: expect.arrayContaining(["questions", "objections"]),
    });
    expect(result.extraction.facts.city).toBe("Москва");
    expect(result.extraction.signals).toMatchObject({
      questions: [],
      objections: [],
      requiresSubstantiveAnswer: true,
    });
  });

  it("extracts a meta-question about why the current qualification step matters", async () => {
    const llm = new FakeLLMProvider([structuredExtractionReply({
      intent: "QUESTION",
      questions: ["А че это важно?"],
      requiresSubstantiveAnswer: true,
      questionKind: "CONVERSATION_META",
    })]);

    const result = await createMessageExtractor({ llmProvider: llm })({
      text: "А че это важно?",
      recentMessages: [{
        direction: "OUTBOUND",
        actor: "AI",
        content: "Скажите, какой бюджет вы готовы вложить в запуск бизнеса?",
      }],
    });

    expect(result.extraction.signals).toMatchObject({
      questionKind: "CONVERSATION_META",
      requiresSubstantiveAnswer: true,
      questions: ["А че это важно?"],
    });
  });

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
      CURRENT_MESSAGE: string;
    };
    expect(untrustedEnvelope.type).toBe("UNTRUSTED_CONVERSATION_CONTEXT");
    expect(untrustedEnvelope.CURRENT_MESSAGE).toBeTruthy();
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

  it("uses the pending capital question to interpret a concise amount as available capital", async () => {
    const llm = new FakeLLMProvider([
      JSON.stringify({
        intent: "QUALIFICATION_INFORMATION",
        facts: {
          phoneNumber: "",
          phoneConfirmed: false,
          city: null,
          budget: 300_000,
          budgetConfirmed: true,
          availableCapital: 300_000,
          availableCapitalConfirmed: true,
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
          buyingIntent: "CONSIDERING",
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
        confidence: 0.95,
        uncertainty: [],
      }),
    ]);
    const extract = createMessageExtractor({ llmProvider: llm });
    const result = await extract({
      text: "300 для начала",
      pendingInformationNeed: "AVAILABLE_CAPITAL",
      currentLead: { availableCapital: null, availableCapitalConfirmed: false } as Lead,
      recentMessages: [{
        direction: "OUTBOUND",
        content: "Какую сумму вы реально готовы выделить на проект: это бюджет только на первый этап или общий доступный капитал?",
      }],
    });

    expect(result.extraction.facts).toMatchObject({
      availableCapital: 300_000,
      availableCapitalConfirmed: true,
      entryBudget: null,
    });
    expect(JSON.parse(llm.requests[0]!.userMessage)).toMatchObject({
      PENDING_INFORMATION_NEED: "AVAILABLE_CAPITAL",
    });
    expect(llm.requests[0]?.systemPrompt).toContain("сама по себе не является неопределённостью");
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

  it("sends bounded dialogue context and current facts to resolve references", async () => {
    const llm = new FakeLLMProvider([JSON.stringify({
      intent: "QUALIFICATION_INFORMATION",
      facts: {
        phoneNumber: "", phoneConfirmed: false, city: null, budget: null,
        budgetConfirmed: false, availableCapital: -1,
        availableCapitalConfirmed: false, entryBudget: -1,
        additionalLaunchCapital: -1, capitalScope: "UNKNOWN",
        additionalExpensesReadiness: "READY",
        businessModelReadiness: "UNKNOWN", calculationUnits: -1,
        startingUnits: null, scalingPotentialUnits: null, hasFreeTime: null,
        availableTimeDetails: null, businessExperience: null,
        shortTermRentalExperience: null, ownsProperty: null,
        desiredIncome: null, primaryGoal: "UNKNOWN", launchTiming: null,
        managementReadiness: null, requiresGuaranteedIncome: null,
        rejectsBusinessModel: null,
      },
      signals: { questions: [], objections: [], possiblePrimaryFear: null,
        possibleSecondaryFear: null, wantsHuman: false },
      confidence: 0.95, uncertainty: [],
    })]);
    const extract = createMessageExtractor({ llmProvider: llm });
    const recentMessages = Array.from({ length: 15 }, (_, index) => ({
      direction: index % 2 === 0 ? "INBOUND" as const : "OUTBOUND" as const,
      content: `message-${index}`,
    }));

    await extract({
      text: "Да, такой бюджет подходит",
      currentLead: {
        city: "Химки", availableCapital: null,
        availableCapitalConfirmed: false, entryBudget: null,
        additionalLaunchCapital: null, capitalScope: "UNKNOWN",
        additionalExpensesReadiness: "UNKNOWN",
        businessModelReadiness: "CONSIDERING", startingUnits: 1,
        scalingPotentialUnits: null, launchTiming: null,
        managementReadiness: null, primaryGoal: "MAIN_BUSINESS",
        hasFreeTime: false, availableTimeDetails: "Только час вечером",
        buyingIntent: "CONSIDERING",
        questions: ["Сколько стоит запуск?"], objections: ["Мало времени"],
        phoneNumber: null, phoneConfirmed: false,
      } as Lead,
      pendingInformationNeed: "AVAILABLE_CAPITAL",
      recentMessages,
    });

    const envelope = JSON.parse(llm.requests[0]!.userMessage) as {
      CURRENT_MESSAGE: string;
      PENDING_INFORMATION_NEED: string;
      CURRENT_LEAD_FACTS: {
        city: string;
        startingUnits: number;
        hasFreeTime: boolean;
        availableTimeDetails: string;
        buyingIntent: string;
        questions: string[];
        objections: string[];
      };
      RECENT_MESSAGES: Array<{ content: string }>;
    };
    expect(envelope).toMatchObject({
      CURRENT_MESSAGE: "Да, такой бюджет подходит",
      PENDING_INFORMATION_NEED: "AVAILABLE_CAPITAL",
      CURRENT_LEAD_FACTS: {
        city: "Химки",
        startingUnits: 1,
        hasFreeTime: false,
        availableTimeDetails: "Только час вечером",
        buyingIntent: "CONSIDERING",
        questions: ["Сколько стоит запуск?"],
        objections: ["Мало времени"],
      },
    });
    expect(envelope.RECENT_MESSAGES).toHaveLength(12);
    expect(envelope.RECENT_MESSAGES[0]?.content).toBe("message-3");
    expect(llm.requests[0]?.systemPrompt).toContain("«Понял», «ясно», «хорошо» сами по себе не подтверждают бюджет");
    expect(llm.requests[0]?.systemPrompt).toContain("COMPLAINT — раздражение");
    expect(llm.requests[0]?.systemPrompt).toContain("3–4 часов в день");
  });

  it("retries ungrounded or contradictory conversation signals", async () => {
    const reply = (overrides: {
      city: string | null;
      questions: string[];
      previousQuestionResponse: "ANSWERED" | "UNSURE" | "DECLINED_TO_ANSWER";
      requiresSubstantiveAnswer: boolean;
      intent: "QUESTION" | "QUALIFICATION_INFORMATION";
    }) => JSON.stringify({
      intent: overrides.intent,
      facts: {
        phoneNumber: "", phoneConfirmed: false, city: overrides.city,
        budget: null, budgetConfirmed: false, availableCapital: -1,
        availableCapitalConfirmed: false, entryBudget: -1,
        additionalLaunchCapital: -1, capitalScope: "UNKNOWN",
        additionalExpensesReadiness: "UNKNOWN",
        businessModelReadiness: "UNKNOWN", calculationUnits: -1,
        startingUnits: null, scalingPotentialUnits: null, hasFreeTime: null,
        availableTimeDetails: null, businessExperience: null,
        shortTermRentalExperience: null, ownsProperty: null,
        desiredIncome: null, primaryGoal: "UNKNOWN", buyingIntent: "UNKNOWN",
        launchTiming: null, managementReadiness: null,
        requiresGuaranteedIncome: null, rejectsBusinessModel: null,
      },
      signals: {
        questions: overrides.questions, objections: [],
        possiblePrimaryFear: null, possibleSecondaryFear: null,
        wantsHuman: false,
        previousQuestionResponse: overrides.previousQuestionResponse,
        resolvedQuestion: "", contextualReference: false,
        needsStartupScaleRecommendation: false,
        requiresSubstantiveAnswer: overrides.requiresSubstantiveAnswer,
      },
      confidence: 0.95,
      uncertainty: [],
    });
    const llm = new FakeLLMProvider([
      reply({
        city: null,
        questions: ["Расскажите подробнее"],
        previousQuestionResponse: "DECLINED_TO_ANSWER",
        requiresSubstantiveAnswer: true,
        intent: "QUESTION",
      }),
      reply({
        city: "Москва",
        questions: [],
        previousQuestionResponse: "ANSWERED",
        requiresSubstantiveAnswer: false,
        intent: "QUALIFICATION_INFORMATION",
      }),
    ]);

    const result = await createMessageExtractor({ llmProvider: llm })({
      text: "Москва",
      recentMessages: [
        { direction: "INBOUND", content: "Расскажите подробнее" },
        {
          direction: "OUTBOUND",
          content: "Команда помогает с запуском. В каком городе вы планируете запуск?",
        },
      ],
    });

    expect(llm.callCount).toBe(2);
    expect(llm.requests[1]?.systemPrompt).toContain("TRUSTED_VALIDATION_FEEDBACK");
    expect(result.extraction).toMatchObject({
      intent: "QUALIFICATION_INFORMATION",
      facts: { city: "Москва" },
      signals: {
        questions: [],
        previousQuestionResponse: "ANSWERED",
        requiresSubstantiveAnswer: false,
      },
    });

    const semanticLlm = new FakeLLMProvider([
      reply({
        city: null,
        questions: ["не знаю даже, деньги"],
        previousQuestionResponse: "UNSURE",
        requiresSubstantiveAnswer: false,
        intent: "QUESTION",
      }),
      reply({
        city: null,
        questions: [],
        previousQuestionResponse: "UNSURE",
        requiresSubstantiveAnswer: false,
        intent: "QUALIFICATION_INFORMATION",
      }),
    ]);
    const semanticResult = await createMessageExtractor({
      llmProvider: semanticLlm,
    })({
      text: "Да я не знаю даже, деньги",
      pendingInformationNeed: "GOAL",
      recentMessages: [{
        direction: "OUTBOUND",
        content: "Какую главную цель хотите решить этим бизнесом?",
      }],
    });

    expect(semanticLlm.callCount).toBe(2);
    expect(semanticLlm.requests[1]?.systemPrompt)
      .toContain("not itself a user question");
    expect(semanticResult.extraction).toMatchObject({
      intent: "QUALIFICATION_INFORMATION",
      signals: {
        questions: [],
        previousQuestionResponse: "UNSURE",
        requiresSubstantiveAnswer: false,
      },
    });
  });
});
