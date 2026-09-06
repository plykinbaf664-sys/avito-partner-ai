import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RetryableInfrastructureError } from "../errors/infrastructure-error";
import { createMessageExtractor } from "../extraction/extract-message";
import type { ExtractMessageResult } from "../extraction/extract-message";
import type { Persistence } from "../ports/repositories";
import type {
  ExtractedFacts,
  ExtractedMessage,
  ExtractedSignals,
  MessageIntent,
} from "../../domain/extraction/extracted-message";
import { SqlitePersistence } from "../../infrastructure/database/sqlite-persistence";
import {
  FakeLLMProvider,
  type FakeLlmReply,
} from "../../integrations/fake/fake-llm-provider";
import { FakeManagerNotificationProvider } from "../../integrations/fake/fake-manager-notification-provider";
import { FakeOutboundProvider } from "../../integrations/fake/fake-outbound-provider";

import { createIncomingEventProcessor } from "./process-incoming-event";

function extractionReply({
  intent = "QUALIFICATION_INFORMATION",
  facts = {},
  signals = {},
}: {
  intent?: MessageIntent;
  facts?: Partial<ExtractedFacts>;
  signals?: Partial<ExtractedSignals>;
} = {}): string {
  const extraction: ExtractedMessage = {
    intent,
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
      ...facts,
    },
    signals: {
      questions: [],
      objections: [],
      possiblePrimaryFear: null,
      possibleSecondaryFear: null,
      wantsHuman: false,
      ...signals,
    },
    confidence: 0.95,
    uncertainty: [],
  };
  return JSON.stringify(extraction);
}

function extractionResult(
  facts: Partial<ExtractedFacts>,
): ExtractMessageResult {
  return {
    extraction: JSON.parse(extractionReply({ facts })) as ExtractedMessage,
    llm: { model: "fake", inputTokens: 10, outputTokens: 10 },
  };
}

describe("incoming partner event workflow", () => {
  let persistence: SqlitePersistence;
  let nextId: number;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated(
      "file::memory:",
      resolve(process.cwd(), "drizzle"),
    );
    nextId = 0;
  });

  afterEach(() => {
    persistence.close();
  });

  function createHarness(replies: FakeLlmReply[]) {
    const llm = new FakeLLMProvider(replies);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      generateId: () => `generated-${++nextId}`,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    return { llm, processEvent };
  }

  function input(
    externalEventId: string,
    text: string,
    externalLeadId = "lead-1",
  ) {
    return {
      source: "local-test",
      externalEventId,
      externalLeadId,
      messageId: `message-${externalEventId}`,
      text,
    };
  }

  it("extracts city, budget, and launch timing from one message", async () => {
    const { processEvent } = createHarness([
      extractionReply({
        facts: {
          city: "Волгоград",
          budget: 500_000,
          budgetConfirmed: true,
          launchTiming: "WITHIN_MONTH",
        },
      }),
    ]);

    const result = await processEvent(
      input(
        "event-1",
        "Я из Волгограда, есть 500 тысяч и хочу начать через месяц",
      ),
    );

    expect(result.extraction?.facts).toMatchObject({
      city: "Волгоград",
      budget: 500_000,
      launchTiming: "WITHIN_MONTH",
    });
    expect(result.serviceability).toBe("SUPPORTED");
    expect(result.knownFacts).toEqual(
      expect.arrayContaining(["CITY", "BUDGET", "LAUNCH_TIMING"]),
    );
    expect(result.missingImportantFacts).not.toEqual(
      expect.arrayContaining(["CITY", "BUDGET", "LAUNCH_TIMING"]),
    );
    expect(result.suggestedNextInformationNeed).toBe("STARTING_UNITS");
    expect(
      await persistence.incomingEvents.findByIdentity("local-test", "event-1"),
    ).toMatchObject({
      status: "PROCESSED",
      extraction: {
        facts: {
          city: "Волгоград",
          budget: 500_000,
          launchTiming: "WITHIN_MONTH",
        },
      },
    });
  });

  it("persists 100,000 rubles as a borderline budget", async () => {
    const { processEvent } = createHarness([
      extractionReply({ facts: { budget: 100_000, budgetConfirmed: true } }),
    ]);

    const result = await processEvent(
      input("event-budget-low", "Есть только 100 тысяч"),
    );
    const lead = await persistence.leads.findByExternalIdentity(
      "local-test",
      "lead-1",
    );

    expect(lead?.budget).toBe(100_000);
    expect(result).toMatchObject({
      qualificationStatus: "BORDERLINE",
      qualificationReason: "BORDERLINE_BUDGET",
      shouldHandoffToManager: false,
      nextAction: "CONTINUE_QUALIFICATION",
    });
  });

  it("normalizes zero potential units from no owned property without losing a low-budget lead", async () => {
    const question = "Можно поработать с таким бюджетом?";
    const { processEvent } = createHarness([
      extractionReply({
        facts: {
          budget: 50_000,
          budgetConfirmed: true,
          startingUnits: 0,
          scalingPotentialUnits: 0,
          ownsProperty: false,
        },
        signals: {
          questions: [question],
          possiblePrimaryFear: "FEAR_NO_PROPERTY",
        },
      }),
    ]);

    const result = await processEvent(
      input(
        "event-no-property-low-budget",
        "У меня нет квартир и денег только 50 тысяч, можно поработать?",
      ),
    );
    const lead = await persistence.leads.findByExternalIdentity(
      "local-test",
      "lead-1",
    );
    const messages = await persistence.messages.listByConversationId(
      result.conversationId!,
    );
    const event = await persistence.incomingEvents.findByIdentity(
      "local-test",
      "event-no-property-low-budget",
    );

    expect(result.extraction?.facts).toMatchObject({
      budget: 50_000,
      startingUnits: null,
      scalingPotentialUnits: null,
      ownsProperty: false,
    });
    expect(result.extraction?.signals.questions).toEqual([question]);
    expect(result).toMatchObject({
      eventStatus: "PROCESSED",
      conversationState: "CLOSED",
      qualificationStatus: "NO_FIT",
      qualificationReason: "INSUFFICIENT_BUDGET",
      shouldHandoffToManager: false,
      nextAction: "REJECT_POLITELY",
    });
    expect(lead).toMatchObject({
      budget: 50_000,
      ownsProperty: false,
      startingUnits: null,
      scalingPotentialUnits: null,
      questions: [question],
      qualificationStatus: "NO_FIT",
      qualificationReason: "INSUFFICIENT_BUDGET",
    });
    expect(messages.map((message) => message.direction)).toEqual([
      "INBOUND",
      "OUTBOUND",
    ]);
    expect(event).toMatchObject({ status: "PROCESSED", error: null });
  });

  it("closes a confirmed 5,000 budget lead without manager handoff", async () => {
    const { llm, processEvent } = createHarness([
      extractionReply({
        facts: { budget: 5_000, budgetConfirmed: true },
        signals: { wantsHuman: true },
      }),
    ]);

    const result = await processEvent(
      input("event-hard-budget-blocker", "У меня 5000 рублей, хочу бизнес"),
    );

    expect(result).toMatchObject({
      eventStatus: "PROCESSED",
      conversationState: "CLOSED",
      qualificationStatus: "NO_FIT",
      qualificationReason: "INSUFFICIENT_BUDGET",
      requiresHumanHandoff: false,
      shouldHandoffToManager: false,
      nextAction: "REJECT_POLITELY",
      suggestedNextInformationNeed: null,
      qualificationDecision: {
        status: "NO_FIT",
        blockingReasons: ["INSUFFICIENT_BUDGET"],
        shouldHandoffToManager: false,
        nextAction: "REJECT_POLITELY",
      },
    });
    expect(llm.callCount).toBe(1);
  });

  it("extracts potential for five units", async () => {
    const { processEvent } = createHarness([
      extractionReply({
        facts: { startingUnits: 1, scalingPotentialUnits: 5 },
      }),
    ]);

    await processEvent(input("event-units", "Хочу начать с пяти квартир"));
    const lead = await persistence.leads.findByExternalIdentity(
      "local-test",
      "lead-1",
    );
    expect(lead).toMatchObject({
      startingUnits: 1,
      scalingPotentialUnits: 5,
    });
  });

  it("keeps a question and budget facts from the same message", async () => {
    const question = "Сколько стоит сопровождение?";
    const { processEvent } = createHarness([
      extractionReply({
        intent: "QUESTION",
        facts: { budget: 300_000, budgetConfirmed: true },
        signals: { questions: [question] },
      }),
    ]);

    const result = await processEvent(
      input("event-question", "У меня есть 300 тысяч. Сколько стоит сопровождение?"),
    );
    const lead = await persistence.leads.findByExternalIdentity(
      "local-test",
      "lead-1",
    );

    expect(result.extraction?.intent).toBe("QUESTION");
    expect(lead?.budget).toBe(300_000);
    expect(lead?.questions).toEqual([question]);
  });

  it("uses the newest explicitly stated budget while retaining message history", async () => {
    const { processEvent } = createHarness([
      extractionReply({ facts: { budget: 150_000, budgetConfirmed: true } }),
      extractionReply({ facts: { budget: 100_000, budgetConfirmed: true } }),
    ]);

    const first = await processEvent(input("event-budget-1", "Есть 150 тысяч"));
    const second = await processEvent(
      input("event-budget-2", "Я пересчитал, максимум 100 тысяч"),
    );
    const lead = await persistence.leads.findByExternalIdentity(
      "local-test",
      "lead-1",
    );
    const messages = await persistence.messages.listByConversationId(
      first.conversationId!,
    );

    expect(second.leadId).toBe(first.leadId);
    expect(lead?.budget).toBe(100_000);
    expect(lead?.qualificationStatus).toBe("BORDERLINE");
    expect(
      messages
        .filter((message) => message.direction === "INBOUND")
        .map((message) => message.content),
    ).toEqual([
      "Есть 150 тысяч",
      "Я пересчитал, максимум 100 тысяч",
    ]);
  });

  it("does not mutate lead facts when the LLM output is invalid", async () => {
    const { processEvent } = createHarness(["not-json"]);
    const eventInput = input("event-invalid", "Есть 500 тысяч");

    await expect(processEvent(eventInput)).rejects.toThrow(
      "malformed extraction JSON",
    );
    const lead = await persistence.leads.findByExternalIdentity(
      "local-test",
      "lead-1",
    );
    const conversation = await persistence.conversations.findOpenByLeadId(
      lead!.id,
    );
    const messages = await persistence.messages.listByConversationId(
      conversation!.id,
    );
    const event = await persistence.incomingEvents.findByIdentity(
      "local-test",
      "event-invalid",
    );

    expect(lead).toMatchObject({ budget: null, qualificationStatus: "QUALIFYING" });
    expect(messages).toHaveLength(1);
    expect(event).toMatchObject({ status: "FAILED", extraction: null });
  });

  it("does not lose the event or message when Anthropic is unavailable", async () => {
    const { processEvent } = createHarness([
      new RetryableInfrastructureError("Anthropic is temporarily unavailable"),
    ]);

    await expect(
      processEvent(input("event-unavailable", "Хочу начать")),
    ).rejects.toMatchObject({ retryable: true });
    const event = await persistence.incomingEvents.findByIdentity(
      "local-test",
      "event-unavailable",
    );
    const lead = await persistence.leads.findByExternalIdentity(
      "local-test",
      "lead-1",
    );
    const conversation = await persistence.conversations.findOpenByLeadId(
      lead!.id,
    );
    const messages = await persistence.messages.listByConversationId(
      conversation!.id,
    );

    expect(event?.status).toBe("FAILED");
    expect(messages).toHaveLength(1);
  });

  it("does not call the LLM or persist a message twice for a duplicate event", async () => {
    const { llm, processEvent } = createHarness([extractionReply()]);
    const eventInput = input("event-duplicate", "Хочу узнать подробнее");

    const first = await processEvent(eventInput);
    const duplicate = await processEvent(eventInput);
    const messages = await persistence.messages.listByConversationId(
      first.conversationId!,
    );

    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({
      eventId: first.eventId,
      duplicate: true,
    });
    expect(llm.callCount).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it("marks an unknown city for review without making the lead NO_FIT", async () => {
    const { processEvent } = createHarness([
      extractionReply({
        facts: {
          city: "Казань",
          budget: 500_000,
          budgetConfirmed: true,
          startingUnits: 5,
          scalingPotentialUnits: 5,
          launchTiming: "WITHIN_MONTH",
          managementReadiness: "READY",
        },
      }),
    ]);

    const result = await processEvent(input("event-city", "Я из Казани"));
    expect(result.serviceability).toBe("NEEDS_REVIEW");
    expect(result.qualificationStatus).toBe("NEEDS_MORE_INFO");
    expect(result.qualificationStatus).not.toBe("NO_FIT");
  });

  it("moves a direct request for a person to handoff deterministically", async () => {
    const { processEvent } = createHarness([
      extractionReply({
        intent: "WANTS_HUMAN",
        signals: { wantsHuman: true },
      }),
    ]);

    const result = await processEvent(
      input("event-human", "Позовите, пожалуйста, менеджера"),
    );
    expect(result).toMatchObject({
      requiresHumanHandoff: true,
      conversationState: "HANDOFF",
      qualificationStatus: "HANDOFF",
      qualificationReason: "USER_REQUESTED_HUMAN",
    });
  });

  it("keeps a failed event claim retryable before the LLM call", async () => {
    let failNextTransaction = true;
    const flakyPersistence: Persistence = {
      leads: persistence.leads,
      conversations: persistence.conversations,
      messages: persistence.messages,
      incomingEvents: persistence.incomingEvents,
      managerNotifications: persistence.managerNotifications,
      checkHealth: () => persistence.checkHealth(),
      checkReadiness: () => persistence.checkReadiness(),
      transaction: async (operation) => {
        if (failNextTransaction) {
          failNextTransaction = false;
          throw new Error("Temporary processing failure");
        }
        return persistence.transaction(operation);
      },
    };
    const llm = new FakeLLMProvider([extractionReply()]);
    const processEvent = createIncomingEventProcessor({
      persistence: flakyPersistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      generateId: () => `generated-${++nextId}`,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    const eventInput = input("event-retry", "Попробуем ещё раз");

    await expect(processEvent(eventInput)).rejects.toThrow(
      "Temporary processing failure",
    );
    expect(llm.callCount).toBe(0);

    const retried = await processEvent(eventInput);
    expect(retried.duplicate).toBe(false);
    expect(llm.callCount).toBe(1);
    expect(
      await persistence.incomingEvents.findByIdentity(
        "local-test",
        "event-retry",
      ),
    ).toMatchObject({ status: "PROCESSED", error: null });
  });

  it("reclaims a stale PROCESSING event without duplicating messages", async () => {
    const now = new Date("2026-09-03T12:00:00.000Z");
    await persistence.incomingEvents.register({
      id: "stale-event-id",
      source: "local-test",
      externalEventId: "event-stale",
      externalLeadId: "lead-1",
      payload: {},
      status: "PROCESSING",
      error: null,
      extraction: null,
      llmModel: null,
      llmInputTokens: null,
      llmOutputTokens: null,
      llmLatencyMs: null,
      totalProcessingLatencyMs: null,
      receivedAt: new Date(now.getTime() - 10 * 60_000),
      processingStartedAt: new Date(now.getTime() - 6 * 60_000),
      processedAt: null,
    });
    const llm = new FakeLLMProvider([extractionReply()]);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      generateId: () => `generated-${++nextId}`,
      now: () => now,
    });

    const result = await processEvent(input("event-stale", "Продолжить"));
    const messages = await persistence.messages.listByConversationId(
      result.conversationId!,
    );

    expect(result).toMatchObject({ duplicate: false, eventStatus: "PROCESSED" });
    expect(llm.callCount).toBe(1);
    expect(messages.map((message) => message.direction)).toEqual([
      "INBOUND",
      "OUTBOUND",
    ]);
  });

  it("does not let a late older extraction overwrite newer lead state", async () => {
    let releaseOlder!: (result: ExtractMessageResult) => void;
    let olderStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      olderStarted = resolve;
    });
    const olderResult = new Promise<ExtractMessageResult>((resolve) => {
      releaseOlder = resolve;
    });
    const extractMessage = async (text: string) => {
      if (text === "older") {
        olderStarted();
        return olderResult;
      }
      return extractionResult({ budget: 300_000, budgetConfirmed: true });
    };
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage,
      generateId: () => `generated-${++nextId}`,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    const older = processEvent(input("event-older", "older"));
    await started;
    const newer = await processEvent(input("event-newer", "newer"));
    releaseOlder(extractionResult({ budget: 100_000, budgetConfirmed: true }));
    const lateResult = await older;
    const lead = await persistence.leads.findById(newer.leadId!);

    expect(lateResult.outOfOrderIgnored).toBe(true);
    expect(lead?.budget).toBe(300_000);
    expect(lead?.qualificationStatus).not.toBe("BORDERLINE");
  });

  it("delivers an event response once for a completed duplicate", async () => {
    const llm = new FakeLLMProvider([extractionReply()]);
    const outboundProvider = new FakeOutboundProvider();
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      outboundProvider,
      generateId: () => `generated-${++nextId}`,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    const eventInput = input("event-delivery-duplicate", "Интересно");

    await processEvent(eventInput);
    await processEvent(eventInput);

    expect(llm.callCount).toBe(1);
    expect(outboundProvider.requests).toHaveLength(1);
  });

  it("records a retryable outbound failure without marking the message sent", async () => {
    const llm = new FakeLLMProvider([extractionReply()]);
    const outboundProvider = new FakeOutboundProvider([
      { status: "FAILED", retryable: true, errorCode: "NETWORK_TIMEOUT" },
    ]);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      outboundProvider,
      generateId: () => `generated-${++nextId}`,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    const result = await processEvent(input("event-outbound-failed", "Интересно"));
    const messages = await persistence.messages.listByConversationId(
      result.conversationId!,
    );
    const outbound = messages.find((message) => message.direction === "OUTBOUND");

    expect(outbound).toMatchObject({
      deliveryStatus: "FAILED",
      deliveryRetryable: true,
      deliveryAttempts: 1,
      sentAt: null,
    });
  });

  it("notifies a manager once on handoff and never for NO_FIT", async () => {
    const managerProvider = new FakeManagerNotificationProvider();
    const llm = new FakeLLMProvider([
      extractionReply({ intent: "WANTS_HUMAN", signals: { wantsHuman: true } }),
      extractionReply({ facts: { budget: 5_000, budgetConfirmed: true } }),
    ]);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      managerNotificationProvider: managerProvider,
      generateId: () => `generated-${++nextId}`,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    const handoffInput = input("event-handoff-once", "Позовите менеджера");

    const handoff = await processEvent(handoffInput);
    await processEvent(handoffInput);
    const rejected = await processEvent(
      input("event-no-fit-notification", "Есть 5 тысяч", "lead-no-fit"),
    );

    expect(handoff.shouldHandoffToManager).toBe(true);
    expect(rejected.qualificationStatus).toBe("NO_FIT");
    expect(managerProvider.requests).toHaveLength(1);
    expect(
      await persistence.managerNotifications.findByIdempotencyKey(
        `manager-handoff:${handoff.leadId}`,
      ),
    ).toMatchObject({ deliveryStatus: "SENT", deliveryAttempts: 1 });
  });
});
