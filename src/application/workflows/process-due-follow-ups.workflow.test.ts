import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";
import { FakeOutboundProvider } from "@/integrations/fake/fake-outbound-provider";

import { createMessageExtractor } from "../extraction/extract-message";
import type { NaturalResponseGenerator } from "../conversation/generate-natural-response";
import { createDueFollowUpsProcessor } from "./process-due-follow-ups";
import { createIncomingEventProcessor } from "./process-incoming-event";
import { createExternalConversationMessageRecorder } from "./record-external-message";

function extractionReply(facts: Record<string, unknown> = {}) {
  return JSON.stringify({
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
      ...facts,
    },
    signals: {
      questions: [],
      objections: [],
      possiblePrimaryFear: null,
      possibleSecondaryFear: null,
      wantsHuman: false,
    },
    confidence: 0.98,
    uncertainty: [],
  });
}

describe("due qualification follow-ups workflow", () => {
  let persistence: SqlitePersistence;
  let currentTime: Date;
  let nextId: number;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated(
      "file::memory:",
      resolve(process.cwd(), "drizzle"),
    );
    currentTime = new Date("2026-09-01T10:00:00.000Z");
    nextId = 0;
  });

  afterEach(() => persistence.close());

  function harness(replies: string[]) {
    const llm = new FakeLLMProvider(replies);
    const responseProvider = new FakeOutboundProvider();
    const outboundProvider = new FakeOutboundProvider();
    const generateId = () => `follow-up-test-${++nextId}`;
    return {
      processEvent: createIncomingEventProcessor({
        persistence,
        extractMessage: createMessageExtractor({ llmProvider: llm }),
        outboundProvider: responseProvider,
        generateId,
        now: () => currentTime,
      }),
      processDue: createDueFollowUpsProcessor({
        persistence,
        outboundProvider,
        generateId,
      }),
      outboundProvider,
    };
  }

  const input = (id: string, text: string) => ({
    source: "follow-up-test",
    externalEventId: id,
    externalLeadId: "lead-1",
    messageId: `message-${id}`,
    text,
  });

  it("sends once at 2 hours and remains idempotent", async () => {
    const { processEvent, processDue, outboundProvider } = harness([
      extractionReply(),
    ]);
    const first = await processEvent(input("event-1", "Здравствуйте"));

    currentTime = new Date("2026-09-01T11:59:00.000Z");
    expect((await processDue(currentTime)).created).toHaveLength(0);

    currentTime = new Date("2026-09-01T12:00:00.000Z");
    const due = await processDue(currentTime);
    const repeated = await processDue(currentTime);
    const messages = await persistence.messages.listByConversationId(
      first.conversationId!,
    );

    expect(due.created).toHaveLength(1);
    expect(due.created[0]?.content.toLocaleLowerCase("ru-RU")).toContain("бюджет");
    expect(repeated.created).toHaveLength(0);
    expect(outboundProvider.requests).toHaveLength(1);
    expect(messages.filter((message) => message.direction === "OUTBOUND")).toHaveLength(2);
    expect(await persistence.conversations.findById(first.conversationId!)).toMatchObject({
      followUpCount: 1,
      lastFollowUpAt: currentTime,
      followUpEligibleAt: null,
    });
  });

  it("cancels a due follow-up when Dmitry continues the conversation", async () => {
    const { processEvent, processDue, outboundProvider } = harness([
      extractionReply(),
    ]);
    await processEvent(input("event-manager-follow-up", "Здравствуйте"));
    currentTime = new Date("2026-09-01T11:30:00.000Z");

    const recordManagerMessage = createExternalConversationMessageRecorder({
      persistence,
      generateId: () => `manager-message-${++nextId}`,
    });
    await recordManagerMessage({
      source: "follow-up-test",
      externalLeadId: "lead-1",
      externalMessageId: "manager-1",
      text: "Оставьте номер, я вам позвоню.",
      createdAt: currentTime,
    });

    currentTime = new Date("2026-09-01T12:00:00.000Z");
    expect((await processDue(currentTime)).created).toHaveLength(0);
    expect(outboundProvider.requests).toHaveLength(0);
    const conversation = await persistence.conversations.findOpenByLeadId(
      (await persistence.leads.findByExternalIdentity("follow-up-test", "lead-1"))!.id,
    );
    expect(conversation?.followUpEligibleAt).toBeNull();
  });

  it("deduplicates parallel scheduler invocations", async () => {
    const { processEvent, processDue, outboundProvider } = harness([
      extractionReply(),
    ]);
    const first = await processEvent(
      input("event-parallel-scheduler", "Р—РґСЂР°РІСЃС‚РІСѓР№С‚Рµ"),
    );
    currentTime = new Date("2026-09-01T12:00:00.000Z");

    await Promise.all([processDue(currentTime), processDue(currentTime)]);
    const messages = await persistence.messages.listByConversationId(
      first.conversationId!,
    );

    expect(outboundProvider.requests).toHaveLength(1);
    expect(
      messages.filter((message) =>
        message.deduplicationKey?.startsWith("qualification-follow-up:"),
      ),
    ).toHaveLength(1);
  });

  it("does not send the old follow-up after an inbound reply before 2 hours", async () => {
    const { processEvent, processDue } = harness([
      extractionReply(),
      extractionReply({ budget: 200_000, budgetConfirmed: true }),
    ]);
    await processEvent(input("event-1", "Здравствуйте"));
    currentTime = new Date("2026-09-02T09:00:00.000Z");
    await processEvent(input("event-2", "Бюджет 200 тысяч"));

    currentTime = new Date("2026-09-02T10:00:00.000Z");
    expect((await processDue(currentTime)).created).toHaveLength(0);
  });

  it("continues the ordinary qualification workflow after a follow-up reply", async () => {
    const { processEvent, processDue } = harness([
      extractionReply({ budget: 200_000, budgetConfirmed: true }),
      extractionReply({ launchTiming: "WITHIN_MONTH" }),
    ]);
    const first = await processEvent(input("event-1", "Есть 200 тысяч"));
    currentTime = new Date("2026-09-01T12:00:00.000Z");
    await processDue(currentTime);

    currentTime = new Date("2026-09-01T13:00:00.000Z");
    const resumed = await processEvent(input("event-2", "Хочу начать через месяц"));
    const messages = await persistence.messages.listByConversationId(
      first.conversationId!,
    );

    expect(resumed).toMatchObject({
      conversationId: first.conversationId,
      suggestedNextInformationNeed: "STARTING_UNITS",
      outboundMessage: expect.stringContaining("объектов"),
    });
    expect(messages.map((message) => message.direction)).toEqual([
      "INBOUND",
      "OUTBOUND",
      "OUTBOUND",
      "INBOUND",
      "OUTBOUND",
    ]);
  });

  it("keeps a failed follow-up unsent and retryable without duplicating it", async () => {
    const llm = new FakeLLMProvider([extractionReply()]);
    const generateId = () => `follow-up-test-${++nextId}`;
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
      outboundProvider: new FakeOutboundProvider(),
      generateId,
      now: () => currentTime,
    });
    const outboundProvider = new FakeOutboundProvider([
      { status: "FAILED", retryable: true, errorCode: "TEMPORARY_503" },
    ]);
    const processDue = createDueFollowUpsProcessor({
      persistence,
      outboundProvider,
      generateId,
    });
    const first = await processEvent(input("event-failed-follow-up", "Здравствуйте"));
    currentTime = new Date("2026-09-01T12:00:00.000Z");

    const failed = await processDue(currentTime);
    const conversation = await persistence.conversations.findById(
      first.conversationId!,
    );
    const messages = await persistence.messages.listByConversationId(
      first.conversationId!,
    );
    const followUps = messages.filter((message) =>
      message.deduplicationKey?.startsWith("qualification-follow-up:"),
    );

    expect(failed.failed).toHaveLength(1);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({
      deliveryStatus: "FAILED",
      deliveryRetryable: true,
      deliveryAttempts: 1,
      sentAt: null,
    });
    expect(conversation).toMatchObject({
      followUpCount: 0,
      lastFollowUpAt: null,
    });
  });

  it("uses the shared conversation brain for a contextual follow-up", async () => {
    const { processEvent, outboundProvider } = harness([extractionReply()]);
    await processEvent(input("event-natural-follow-up", "Hello"));

    const calls: Parameters<NaturalResponseGenerator>[0][] = [];
    const generateNaturalResponse: NaturalResponseGenerator = async (input) => {
      calls.push(input);
      return {
        text: "Returning to our conversation - is this topic still relevant?",
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
        nextInformationNeed: input.plan.nextInformationNeed,
      };
    };
    const processDue = createDueFollowUpsProcessor({
      persistence,
      outboundProvider,
      generateNaturalResponse,
      generateId: () => "natural-follow-up-" + (++nextId),
    });

    currentTime = new Date("2026-09-01T12:00:00.000Z");
    const due = await processDue(currentTime);

    expect(due.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ triggerType: "FOLLOW_UP_DUE" });
    expect(calls[0]?.recentMessages.some((message) => message.direction === "OUTBOUND"))
      .toBe(true);
    expect(outboundProvider.requests[0]?.text).toContain("Returning");
  });
  it("rechecks state after selection and skips when an inbound arrived", async () => {
    const { processEvent } = harness([extractionReply()]);
    const first = await processEvent(input("event-race", "Здравствуйте"));
    currentTime = new Date("2026-09-01T12:00:00.000Z");
    const originalList =
      persistence.conversations.listDueFollowUps.bind(
        persistence.conversations,
      );
    const staleCandidates = await originalList(currentTime, 100);
    const conversation = await persistence.conversations.findById(
      first.conversationId!,
    );
    await persistence.conversations.update({
      ...conversation!,
      awaitingUserReply: false,
      followUpEligibleAt: null,
      lastInboundAt: currentTime,
    });
    persistence.conversations.listDueFollowUps = async () => staleCandidates;
    const outboundProvider = new FakeOutboundProvider();
    const processDue = createDueFollowUpsProcessor({
      persistence,
      outboundProvider,
    });

    const result = await processDue(currentTime);

    expect(result).toMatchObject({ scanned: 1, sent: [], failed: [] });
    expect(result.created).toHaveLength(0);
    expect(outboundProvider.requests).toHaveLength(0);
  });
});
