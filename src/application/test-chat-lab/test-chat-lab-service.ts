import { createMessageExtractor } from "../extraction/extract-message";
import { createNaturalResponseGenerator } from "../conversation/generate-natural-response";
import type { StructuredLogger } from "../observability/structured-logger";
import type {
  ManagerNotificationProvider,
  OutboundMessageProvider,
} from "../ports/channels";
import type { Persistence } from "../ports/repositories";
import { createDueFollowUpsProcessor } from "../workflows/process-due-follow-ups";
import {
  createIncomingEventProcessor,
  type ProcessIncomingEventResult,
} from "../workflows/process-incoming-event";
import { createExternalConversationMessageRecorder } from "../workflows/record-external-message";
import { assessInformationNeeds } from "@/domain/conversation/information-needs";
import { evaluateQualification, hasConfirmedPhone, qualificationContextForLead } from "@/domain/qualification/qualification-policy";
import type { Message } from "@/domain/message/message";
import type { Conversation } from "@/domain/conversation/conversation";
import type { Lead } from "@/domain/lead/lead";
import type { LlmProvider } from "../ports/llm-provider";
import { generateId } from "@/shared/id";

import { TEST_CHAT_LAB_SOURCE, testChatLabScenarios } from "./test-chat-lab-contract";
import type { TestChatLabActionResult, TestChatLabSnapshot } from "./test-chat-lab-contract";

export { TEST_CHAT_LAB_SOURCE, testChatLabScenarios } from "./test-chat-lab-contract";

export interface TestChatLabDependencies {
  persistence: Persistence;
  llmProvider: LlmProvider;
  outboundProvider: OutboundMessageProvider;
  managerNotificationProvider: ManagerNotificationProvider;
  logger?: StructuredLogger;
}

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function latest(history: Message[], predicate: (message: Message) => boolean): Message | null {
  return history.slice().reverse().find(predicate) ?? null;
}

function currentNextStep(lead: Lead, conversation: Conversation | null, history: Message[], decision: ReturnType<typeof evaluateQualification>): string | null {
  const latestOutbound = latest(history, (message) => message.direction === "OUTBOUND");
  if (latestOutbound?.actor === "MANAGER") {
    return "MANAGER_DEFINED_NEXT_STEP";
  }
  if (decision.shouldHandoffToManager) return "HANDOFF";
  if (hasConfirmedPhone(lead)) return "CONTINUE_CONVERSATION";
  if (["QUALIFIED", "PRIORITY", "HOT", "WARM"].includes(lead.qualificationStatus) && !hasConfirmedPhone(lead)) {
    return "PHONE_NUMBER";
  }
  // A missing field is policy metadata, not an instruction for the next
  // conversational question. The Test Chat Lab should show the persisted
  // Claude-selected move only; otherwise report that the dialogue continues.
  return conversation?.pendingInformationNeed ?? "CONTINUE_CONVERSATION";
}

export function createTestChatLabService({
  persistence,
  llmProvider,
  outboundProvider,
  managerNotificationProvider,
  logger,
}: TestChatLabDependencies) {
  let virtualNow = new Date();
  let lastProcessing: TestChatLabSnapshot["lastProcessing"] = null;
  let responseFailureCode: string | null = null;
  const diagnosticLogger: StructuredLogger = {
    info: (event, fields) => logger?.info(event, fields),
    error: (event, fields) => {
      if (event === "response_generation.fallback" && typeof fields.errorType === "string") {
        responseFailureCode = fields.errorType;
      }
      logger?.error(event, fields);
    },
  };
  const extractMessage = createMessageExtractor({ llmProvider });
  const generateNaturalResponse = createNaturalResponseGenerator({ llmProvider });
  const processIncomingEvent = createIncomingEventProcessor({
    persistence,
    extractMessage,
    generateNaturalResponse,
    outboundProvider,
    managerNotificationProvider,
    logger: diagnosticLogger,
    now: () => virtualNow,
    monotonicNow: () => performance.now(),
  });
  const processDueFollowUps = createDueFollowUpsProcessor({
    persistence,
    outboundProvider,
    generateNaturalResponse,
    logger,
    generateId,
  });
  const recordManagerMessage = createExternalConversationMessageRecorder({
    persistence,
    logger,
    generateId,
  });

  const setTime = (value: Date) => { virtualNow = value; };

  async function snapshot(sessionId: string): Promise<TestChatLabSnapshot> {
    const lead = await persistence.leads.findByExternalIdentity(TEST_CHAT_LAB_SOURCE, sessionId);
    if (!lead) {
      return {
        sessionId,
        virtualNow: virtualNow.toISOString(),
        lead: null,
        conversation: null,
        messages: [],
        qualification: { status: null, reason: null, shouldHandoffToManager: false, nextAction: null, knownFacts: [], missingCriticalFacts: [] },
        phone: null,
        currentNextStep: null,
        replyAction: "NO_REPLY",
        handoff: { decision: "NONE", notificationStatus: null, notificationId: null },
        followUp: { eligibleAt: null, lastFollowUpAt: null, followUpCount: 0, awaitingUserReply: false },
        lastProcessing,
      };
    }
    const relation = await persistence.crm.findLeadSnapshot(lead.id);
    const conversation = relation?.conversation ?? await persistence.conversations.findOpenByLeadId(lead.id);
    const messages = await persistence.messages.listByLeadId(lead.id);
    const decision = evaluateQualification(lead, qualificationContextForLead(lead, {}));
    const needs = assessInformationNeeds(lead);
    const latestInbound = latest(messages, (message) => message.direction === "INBOUND");
    const latestAi = latest(messages, (message) => message.direction === "OUTBOUND" && message.actor === "AI");
    const replyAction = latestAi && (!latestInbound || latestAi.createdAt.getTime() >= latestInbound.createdAt.getTime()) ? "SEND_REPLY" : "NO_REPLY";
    const notification = await persistence.managerNotifications.findByIdempotencyKey(`manager-handoff:${lead.id}`);
    return {
      sessionId,
      virtualNow: virtualNow.toISOString(),
      lead,
      conversation,
      messages: messages.map(({ id, direction, actor, content, createdAt, deliveryStatus }) => ({ id, direction, actor, content, createdAt, deliveryStatus })),
      qualification: {
        status: lead.qualificationStatus,
        reason: lead.qualificationReason,
        shouldHandoffToManager: decision.shouldHandoffToManager,
        nextAction: decision.nextAction,
        knownFacts: needs.knownFacts,
        missingCriticalFacts: needs.missingCriticalFacts,
      },
      phone: hasConfirmedPhone(lead) ? lead.phoneNumber : null,
      currentNextStep: currentNextStep(lead, conversation, messages, decision),
      replyAction,
      handoff: {
        decision: decision.shouldHandoffToManager ? "HANDOFF" : "NONE",
        notificationStatus: notification?.deliveryStatus ?? null,
        notificationId: notification?.id ?? null,
      },
      followUp: {
        eligibleAt: iso(conversation?.followUpEligibleAt),
        lastFollowUpAt: iso(conversation?.lastFollowUpAt),
        followUpCount: conversation?.followUpCount ?? 0,
        awaitingUserReply: conversation?.awaitingUserReply ?? false,
      },
      lastProcessing,
    };
  }

  async function clientMessage(sessionId: string, text: string, now: Date, turnId = generateId(), suppressOutbound = false): Promise<TestChatLabActionResult> {
    setTime(now);
    responseFailureCode = null;
    const result: ProcessIncomingEventResult = await processIncomingEvent({
      source: TEST_CHAT_LAB_SOURCE,
      externalEventId: `${sessionId}:client:${turnId}`,
      externalLeadId: sessionId,
      messageId: `${sessionId}:client-message:${turnId}`,
      text,
      rawPayload: { testChatLab: true, actor: "USER" },
      receivedAt: now,
    }, { suppressOutbound });
    lastProcessing = {
      outboundMessage: result.outboundMessage,
      replyAction: result.outboundMessage === null ? "NO_REPLY" : "SEND_REPLY",
      eventStatus: result.eventStatus,
      responseFailureCode,
      responseGenerationSource: result.metrics.responseGenerationSource ?? null,
    };
    return { snapshot: await snapshot(sessionId), followUp: null };
  }

  async function managerMessage(sessionId: string, text: string, now: Date, turnId = generateId()): Promise<TestChatLabActionResult> {
    setTime(now);
    await recordManagerMessage({
      source: TEST_CHAT_LAB_SOURCE,
      externalLeadId: sessionId,
      externalMessageId: `${sessionId}:manager:${turnId}`,
      text,
      createdAt: now,
    });
    lastProcessing = { outboundMessage: null, replyAction: "NO_REPLY", eventStatus: "PROCESSED" };
    return { snapshot: await snapshot(sessionId), followUp: null };
  }

  async function advanceTime(sessionId: string, now: Date): Promise<TestChatLabActionResult> {
    setTime(now);
    const result = await processDueFollowUps(now);
    lastProcessing = {
      outboundMessage: result.sent[0]?.content ?? null,
      replyAction: result.sent.length > 0 ? "SEND_REPLY" : "NO_REPLY",
      eventStatus: "PROCESSED",
    };
    return {
      snapshot: await snapshot(sessionId),
      followUp: { scanned: result.scanned, created: result.created.length, sent: result.sent.length, failed: result.failed.length, skipped: result.skipped },
    };
  }

  async function runScenario(sessionId: string, scenarioId: string, startAt: Date): Promise<TestChatLabActionResult> {
    const scenario = testChatLabScenarios.find((item) => item.id === scenarioId);
    if (!scenario) throw new Error("TEST_CHAT_LAB_SCENARIO_NOT_FOUND");
    let result: TestChatLabActionResult = { snapshot: await snapshot(sessionId), followUp: null };
    for (const [index, step] of scenario.steps.entries()) {
      const isBurst = "burst" in scenario && scenario.burst === true;
      const at = new Date(startAt.getTime() + (isBurst ? 0 : index * 60_000));
      result = step.actor === "MANAGER"
        ? await managerMessage(sessionId, step.text, at, `${scenarioId}-${index}`)
        : await clientMessage(
            sessionId,
            step.text,
            at,
            `${scenarioId}-${index}`,
            isBurst && index < scenario.steps.length - 1,
          );
    }
    return result;
  }

  return { snapshot, clientMessage, managerMessage, advanceTime, runScenario };
}
