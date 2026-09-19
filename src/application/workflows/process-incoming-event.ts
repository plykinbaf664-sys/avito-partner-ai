import { z } from "zod";

import type { NaturalResponseGenerator } from "../conversation/generate-natural-response";
import { EventProcessingRejectedError } from "../errors/event-processing-error";
import { RetryableInfrastructureError } from "../errors/infrastructure-error";
import { createManagerNotificationDelivery } from "../delivery/deliver-manager-notification";
import { createOutboundMessageDelivery } from "../delivery/deliver-outbound-message";
import type { ExtractMessageResult, MessageExtractionInput } from "../extraction/extract-message";
import { mergeExtractedFacts } from "../extraction/merge-extracted-facts";
import {
  silentLogger,
  type StructuredLogger,
} from "../observability/structured-logger";
import type { Persistence, RepositoryContext } from "../ports/repositories";
import type {
  ManagerNotificationProvider,
  OutboundMessageProvider,
} from "../ports/channels";
import {
  MAX_INBOUND_MESSAGE_LENGTH,
  MAX_INCOMING_PROCESSING_ATTEMPTS,
  MAX_RECENT_LLM_MESSAGES,
} from "../security/technical-limits";
import { buildConversationResponse } from "../../domain/conversation/conversation-response";
import {
  assessInformationNeeds,
  informationNeeds,
  stateForInformationNeed,
  type InformationNeed,
  type InformationNeedsAssessment,
} from "../../domain/conversation/information-needs";
import type { Conversation } from "../../domain/conversation/conversation";
import { transitionConversation } from "../../domain/conversation/conversation-state";
import type { IncomingEvent } from "../../domain/event/incoming-event";
import type { ExtractedMessage } from "../../domain/extraction/extracted-message";
import type { Lead } from "../../domain/lead/lead";
import type { Message } from "../../domain/message/message";
import type { ManagerNotification } from "../../domain/notification/manager-notification";
import { followUpEligibleAt } from "../../domain/follow-up/follow-up-policy";
import {
  createManagerSummary,
  type ManagerSummary,
} from "../../domain/handoff/manager-summary";
import { answerFromKnowledgeBase } from "../../domain/knowledge/knowledge-base";
import {
  evaluateQualification,
  hasConfirmedPhone,
  qualificationContextForLead,
  type QualificationDecision,
  type QualificationNextAction,
} from "../../domain/qualification/qualification-policy";
import { generateId, type IdGenerator } from "../../shared/id";

export const incomingPartnerEventSchema = z
  .object({
    source: z.string().trim().min(1).max(100),
    externalEventId: z.string().trim().min(1).max(255),
    externalLeadId: z.string().trim().min(1).max(255),
    messageId: z.string().trim().min(1).max(255),
    text: z.string().trim().min(1).max(MAX_INBOUND_MESSAGE_LENGTH),
    rawPayload: z.unknown().optional(),
    receivedAt: z.date().optional(),
  })
  .strict();

export type IncomingPartnerEvent = z.input<typeof incomingPartnerEventSchema>;

export interface ProcessIncomingEventMetrics {
  llmLatencyMs: number | null;
  totalProcessingLatencyMs: number;
  llmSuccess: boolean | null;
  duplicateEventCount: 0 | 1;
  extractionLlmCalls: 0 | 1;
  responseLlmCalls: 0 | 1;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
}

export interface ProcessIncomingEventResult {
  eventId: string;
  eventStatus: IncomingEvent["status"];
  leadId: string | null;
  conversationId: string | null;
  conversationState: Conversation["state"] | null;
  duplicate: boolean;
  outOfOrderIgnored: boolean;
  extraction: ExtractedMessage | null;
  segment: Lead["segment"] | null;
  segmentConfidence: number | null;
  qualificationStatus: Lead["qualificationStatus"] | null;
  qualificationReason: string | null;
  qualificationDecision: QualificationDecision | null;
  serviceability: Lead["serviceability"] | null;
  knownFacts: InformationNeedsAssessment["knownFacts"];
  missingCriticalFacts: InformationNeedsAssessment["missingCriticalFacts"];
  missingOptionalFacts: InformationNeedsAssessment["missingOptionalFacts"];
  missingImportantFacts: InformationNeedsAssessment["missingImportantFacts"];
  suggestedNextInformationNeed: InformationNeedsAssessment["suggestedNextInformationNeed"];
  requiresHumanHandoff: boolean;
  shouldHandoffToManager: boolean;
  nextAction: QualificationNextAction | null;
  outboundMessage: string | null;
  managerSummary: ManagerSummary | null;
  metrics: ProcessIncomingEventMetrics;
}

export type MessageExtractor = (
  input: MessageExtractionInput,
) => Promise<ExtractMessageResult>;

export interface ProcessIncomingEventDependencies {
  persistence: Persistence;
  extractMessage: MessageExtractor;
  generateNaturalResponse?: NaturalResponseGenerator;
  outboundProvider?: OutboundMessageProvider;
  managerNotificationProvider?: ManagerNotificationProvider;
  logger?: StructuredLogger;
  generateId?: IdGenerator;
  now?: () => Date;
  monotonicNow?: () => number;
  processingTimeoutMs?: number;
}

export interface ProcessIncomingEventOptions {
  suppressOutbound?: boolean;
}

interface PreparedEvent {
  claimed: boolean;
  recoveredStale: boolean;
  inboundSequence: number | null;
  lead: Lead | null;
  conversation: Conversation | null;
}

export const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1_000;

export function createInitialLead(
  id: string,
  source: string,
  externalLeadId: string,
  now: Date,
): Lead {
  const lead: Lead = {
    id,
    source,
    externalLeadId,
    name: null,
    contact: null,
    phoneNumber: null,
    phoneConfirmed: false,
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
    segment: "UNDETERMINED",
    segmentConfidence: 0,
    startingUnits: null,
    scalingPotentialUnits: null,
    hasFreeTime: null,
    availableTimeDetails: null,
    businessExperience: null,
    shortTermRentalExperience: null,
    ownsProperty: null,
    desiredIncome: null,
    primaryGoal: null,
    primaryFear: null,
    secondaryFear: null,
    launchTiming: null,
    managementReadiness: null,
    requiresGuaranteedIncome: null,
    rejectsBusinessModel: null,
    questions: [],
    objections: [],
    buyingIntent: null,
    qualificationStatus: "QUALIFYING",
    qualificationReason: "CAPITAL_UNKNOWN",
    conversationSummary: null,
    createdAt: now,
    updatedAt: now,
    handoffAt: null,
  };
  return lead;
}

async function prepareClaimedEvent(
  repositories: RepositoryContext,
  event: IncomingEvent,
  input: z.output<typeof incomingPartnerEventSchema>,
  idGenerator: IdGenerator,
  now: Date,
  staleBefore: Date,
  maxProcessingAttempts: number,
): Promise<PreparedEvent> {
  const claim = await repositories.incomingEvents.tryClaim(
    event.id,
    now,
    staleBefore,
    maxProcessingAttempts,
  );
  if (!claim.claimed) {
    const lead = await repositories.leads.findByExternalIdentity(
      input.source,
      input.externalLeadId,
    );
    const conversation = lead
      ? await repositories.conversations.findOpenByLeadId(lead.id)
      : null;
    return {
      claimed: false,
      recoveredStale: false,
      inboundSequence: null,
      lead,
      conversation,
    };
  }

  let lead = await repositories.leads.findByExternalIdentity(
    input.source,
    input.externalLeadId,
  );
  if (!lead) {
    lead = createInitialLead(idGenerator(), input.source, input.externalLeadId, now);
    await repositories.leads.insert(lead);
  }

  let conversation = await repositories.conversations.findOpenByLeadId(lead.id);
  if (!conversation) {
    conversation = {
      id: idGenerator(),
      leadId: lead.id,
      state: transitionConversation("NEW", "DISCOVERY"),
      summary: null,
      pendingInformationNeed: null,
      lastInboundAt: now,
      lastOutboundAt: null,
      awaitingUserReply: false,
      qualificationCompleted: false,
      followUpEligibleAt: null,
      followUpCount: 0,
      lastFollowUpAt: null,
      nextInboundSequence: 0,
      lastAppliedInboundSequence: 0,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    await repositories.conversations.insert(conversation);
  }

  const existingMessage = await repositories.messages.findByIncomingEventId(
    event.id,
  );
  let inboundSequence = existingMessage?.sequence ?? null;
  if (existingMessage && inboundSequence === null) {
    inboundSequence = conversation.nextInboundSequence + 1;
    await repositories.messages.update({
      ...existingMessage,
      sequence: inboundSequence,
    });
  } else if (!existingMessage) {
    inboundSequence = conversation.nextInboundSequence + 1;
    const message: Message = {
      id: idGenerator(),
      conversationId: conversation.id,
      leadId: lead.id,
      incomingEventId: event.id,
      externalMessageId: input.messageId,
      deduplicationKey: null,
      sequence: inboundSequence,
      direction: "INBOUND",
      actor: "USER",
      content: input.text,
      deliveryStatus: null,
      deliveryAttempts: 0,
      deliveryRetryable: null,
      lastDeliveryErrorCode: null,
      sentAt: null,
      createdAt: now,
    };
    await repositories.messages.insert(message);
  }

  const conversationMessages = await repositories.messages.listByConversationId(
    conversation.id,
  );
  for (const pendingFollowUp of conversationMessages.filter(
    (message) =>
      message.direction === "OUTBOUND" &&
      message.deliveryStatus === "PENDING" &&
      message.deduplicationKey?.startsWith(
        `qualification-follow-up:${conversation!.id}:`,
      ),
  )) {
    await repositories.messages.update({
      ...pendingFollowUp,
      deliveryStatus: "FAILED",
      deliveryRetryable: false,
      lastDeliveryErrorCode: "CANCELLED_BY_INBOUND",
    });
  }

  conversation = {
    ...conversation,
    nextInboundSequence: Math.max(
      conversation.nextInboundSequence,
      inboundSequence ?? conversation.nextInboundSequence,
    ),
    followUpCount:
      conversation.lastFollowUpAt !== null &&
      (conversation.lastInboundAt === null ||
        conversation.lastFollowUpAt.getTime() > conversation.lastInboundAt.getTime())
        ? 0
        : conversation.followUpCount,
    lastInboundAt: now,
    awaitingUserReply: false,
    followUpEligibleAt: null,
    updatedAt: now,
  };
  await repositories.conversations.update(conversation);

  return {
    claimed: true,
    recoveredStale: claim.recoveredStale,
    inboundSequence,
    lead,
    conversation,
  };
}

function extractedFactNames(extraction: ExtractedMessage): string[] {
  return Object.entries(extraction.facts)
    .filter(([, value]) => value !== null)
    .map(([field]) => field);
}

function emptyNeeds(): InformationNeedsAssessment {
  return {
    knownFacts: [],
    missingCriticalFacts: [],
    missingOptionalFacts: [],
    missingImportantFacts: [],
    allowedNextInformationNeeds: [],
    suggestedNextInformationNeed: null,
  };
}

function buildResult({
  event,
  lead,
  conversation,
  duplicate,
  extraction,
  totalProcessingLatencyMs,
  decision: suppliedDecision,
  outboundMessage = null,
  managerSummary = null,
  responseLlm = null,
  outOfOrderIgnored = false,
}: {
  event: IncomingEvent;
  lead: Lead | null;
  conversation: Conversation | null;
  duplicate: boolean;
  extraction: ExtractedMessage | null;
  totalProcessingLatencyMs: number;
  decision?: QualificationDecision | null;
  outboundMessage?: string | null;
  managerSummary?: ManagerSummary | null;
  responseLlm?: {
    inputTokens: number;
    outputTokens: number;
  } | null;
  outOfOrderIgnored?: boolean;
}): ProcessIncomingEventResult {
  const decision = suppliedDecision ?? (lead
    ? evaluateQualification(lead, qualificationContextForLead(lead, {
        wantsHuman: extraction?.signals.wantsHuman === true,
        unknownBusinessQuestion:
          extraction !== null &&
          answerFromKnowledgeBase(extraction).unresolvedQuestions.length > 0,
      }))
    : null);
  const assessedNeeds = lead ? assessInformationNeeds(lead) : emptyNeeds();
  const needs =
    decision?.nextAction !== "CONTINUE_QUALIFICATION"
      ? { ...assessedNeeds, suggestedNextInformationNeed: null }
      : assessedNeeds;
  return {
    eventId: event.id,
    eventStatus: event.status,
    leadId: lead?.id ?? null,
    conversationId: conversation?.id ?? null,
    conversationState: conversation?.state ?? null,
    duplicate,
    outOfOrderIgnored,
    extraction,
    segment: lead?.segment ?? null,
    segmentConfidence: lead?.segmentConfidence ?? null,
    qualificationStatus: decision?.status ?? lead?.qualificationStatus ?? null,
    qualificationReason: decision?.reason ?? lead?.qualificationReason ?? null,
    qualificationDecision: decision,
    serviceability: lead?.serviceability ?? null,
    ...needs,
    requiresHumanHandoff: decision?.shouldHandoffToManager ?? false,
    shouldHandoffToManager: decision?.shouldHandoffToManager ?? false,
    nextAction: decision?.nextAction ?? null,
    outboundMessage,
    managerSummary,
    metrics: {
      llmLatencyMs: event.llmLatencyMs,
      totalProcessingLatencyMs,
      llmSuccess: duplicate ? null : event.status === "PROCESSED",
      duplicateEventCount: duplicate ? 1 : 0,
      extractionLlmCalls: duplicate ? 0 : 1,
      responseLlmCalls: responseLlm ? 1 : 0,
      totalInputTokens:
        event.llmInputTokens === null
          ? null
          : event.llmInputTokens + (responseLlm?.inputTokens ?? 0),
      totalOutputTokens:
        event.llmOutputTokens === null
          ? null
          : event.llmOutputTokens + (responseLlm?.outputTokens ?? 0),
    },
  };
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN_PROCESSING_ERROR";
  const code = "code" in error
    ? String(error.code)
    : error.message && /^[A-Z0-9_.:-]+$/u.test(error.message)
      ? error.message
      : error.name;
  return code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100);
}

function isRetryableProcessingError(error: unknown): boolean {
  return error instanceof RetryableInfrastructureError;
}

interface DeferredInformationNeedMemory {
  need: InformationNeed;
  deferredAtInboundSequence: number;
}

interface StoredConversationMemory {
  knowledgeEntryIds: string[];
  deferredInformationNeeds: DeferredInformationNeedMemory[];
}

const DEFERRED_NEED_COOLDOWN_TURNS = 2;

function parseStoredConversationMemory(summary: string | null): StoredConversationMemory {
  const empty: StoredConversationMemory = {
    knowledgeEntryIds: [],
    deferredInformationNeeds: [],
  };
  if (!summary) return empty;
  try {
    const parsed: unknown = JSON.parse(summary);
    if (Array.isArray(parsed)) {
      return {
        ...empty,
        knowledgeEntryIds: parsed.filter(
          (value): value is string => typeof value === "string",
        ),
      };
    }
    if (!parsed || typeof parsed !== "object") return empty;
    const record = parsed as Record<string, unknown>;
    const knownNeeds = new Set<string>(informationNeeds);
    const deferred = Array.isArray(record.deferredInformationNeeds)
      ? record.deferredInformationNeeds.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const item = value as Record<string, unknown>;
          return typeof item.need === "string" &&
            knownNeeds.has(item.need) &&
            typeof item.deferredAtInboundSequence === "number" &&
            Number.isSafeInteger(item.deferredAtInboundSequence)
            ? [{
                need: item.need as InformationNeed,
                deferredAtInboundSequence: item.deferredAtInboundSequence,
              }]
            : [];
        })
      : [];
    return {
      knowledgeEntryIds: Array.isArray(record.knowledgeEntryIds)
        ? record.knowledgeEntryIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      deferredInformationNeeds: deferred,
    };
  } catch {
    return empty;
  }
}

function rememberDeferredInformationNeed(params: {
  memory: StoredConversationMemory;
  pendingInformationNeed: InformationNeed | null;
  previousQuestionResponse: ExtractedMessage["signals"]["previousQuestionResponse"];
  inboundSequence: number;
}): StoredConversationMemory {
  if (
    params.pendingInformationNeed === null ||
    (params.previousQuestionResponse ?? "NOT_A_RESPONSE") === "NOT_A_RESPONSE"
  ) {
    return params.memory;
  }
  return {
    ...params.memory,
    deferredInformationNeeds: [
      ...params.memory.deferredInformationNeeds.filter(
        (item) => item.need !== params.pendingInformationNeed,
      ),
      {
        need: params.pendingInformationNeed,
        deferredAtInboundSequence: params.inboundSequence,
      },
    ],
  };
}

function activeDeferredInformationNeeds(
  memory: StoredConversationMemory,
  inboundSequence: number,
): InformationNeed[] {
  return memory.deferredInformationNeeds
    .filter((item) =>
      inboundSequence - item.deferredAtInboundSequence <=
        DEFERRED_NEED_COOLDOWN_TURNS,
    )
    .map((item) => item.need);
}

function elapsedMilliseconds(startedAt: number, timer: () => number): number {
  return Math.max(0, Math.round(timer() - startedAt));
}

export function createIncomingEventProcessor({
  persistence,
  extractMessage,
  generateNaturalResponse,
  outboundProvider,
  managerNotificationProvider,
  logger = silentLogger,
  generateId: idGenerator = generateId,
  now: clock = () => new Date(),
  monotonicNow: timer = () => performance.now(),
  processingTimeoutMs = DEFAULT_PROCESSING_TIMEOUT_MS,
}: ProcessIncomingEventDependencies) {
  return async function processIncomingEvent(
    untrustedInput: IncomingPartnerEvent,
    options: ProcessIncomingEventOptions = {},
  ): Promise<ProcessIncomingEventResult> {
    const processingStartedAt = timer();
    const input = incomingPartnerEventSchema.parse(untrustedInput);
    const receivedAt = input.receivedAt ?? clock();
    const newEvent: IncomingEvent = {
      id: idGenerator(),
      source: input.source,
      externalEventId: input.externalEventId,
      externalLeadId: input.externalLeadId,
      payload: input.rawPayload ?? input,
      status: "RECEIVED",
      error: null,
      processingAttempts: 0,
      processingRetryable: null,
      extraction: null,
      llmModel: null,
      llmInputTokens: null,
      llmOutputTokens: null,
      llmLatencyMs: null,
      totalProcessingLatencyMs: null,
      receivedAt,
      processingStartedAt: null,
      processedAt: null,
    };

    const registration = await persistence.incomingEvents.register(newEvent);
    logger.info("event.accepted", {
      eventId: registration.event.id,
      source: input.source,
      retry: !registration.created && registration.event.status === "FAILED",
    });

    let prepared: PreparedEvent;
    try {
      prepared = await persistence.transaction((repositories) =>
        prepareClaimedEvent(
          repositories,
          registration.event,
          input,
          idGenerator,
          clock(),
          new Date(clock().getTime() - processingTimeoutMs),
          MAX_INCOMING_PROCESSING_ATTEMPTS,
        ),
      );
    } catch (error) {
      await persistence.incomingEvents.markFailed(
        registration.event.id,
        safeErrorCode(error),
        true,
      );
      throw error;
    }

    if (prepared.recoveredStale) {
      logger.info("event.stale_recovered", {
        eventId: registration.event.id,
        leadId: prepared.lead?.id ?? null,
        conversationId: prepared.conversation?.id ?? null,
        source: input.source,
      });
    }

    if (!prepared.claimed) {
      if (
        registration.event.status === "FAILED" &&
        (registration.event.processingRetryable === false ||
          registration.event.processingAttempts >=
            MAX_INCOMING_PROCESSING_ATTEMPTS)
      ) {
        logger.error("event.retry_rejected", {
          eventId: registration.event.id,
          leadId: prepared.lead?.id ?? null,
          conversationId: prepared.conversation?.id ?? null,
          source: input.source,
          attempts: registration.event.processingAttempts,
        });
        throw new EventProcessingRejectedError();
      }
      const duration = elapsedMilliseconds(processingStartedAt, timer);
      logger.info("event.duplicate", {
        eventId: registration.event.id,
        source: input.source,
        leadId: prepared.lead?.id ?? null,
        duplicateEventCount: 1,
        totalProcessingLatencyMs: duration,
      });
      return buildResult({
        event: registration.event,
        lead: prepared.lead,
        conversation: prepared.conversation,
        duplicate: true,
        extraction: registration.event.extraction,
        totalProcessingLatencyMs: duration,
      });
    }

    const llmStartedAt = timer();
    logger.info("extraction.started", {
      eventId: registration.event.id,
      leadId: prepared.lead!.id,
      conversationId: prepared.conversation!.id,
      source: input.source,
    });

    let extracted: ExtractMessageResult;
    try {
      const extractionHistory = await persistence.messages.listRecentByConversationId(
        prepared.conversation!.id,
        MAX_RECENT_LLM_MESSAGES,
      );
      extracted = await extractMessage({
        text: input.text,
        currentLead: prepared.lead!,
        pendingInformationNeed: prepared.conversation!.pendingInformationNeed,
        recentMessages: extractionHistory.map(({ direction, actor, content }) => ({ direction, actor, content })),
      });
    } catch (error) {
      const llmLatencyMs = elapsedMilliseconds(llmStartedAt, timer);
      await persistence.incomingEvents.markFailed(
        registration.event.id,
        safeErrorCode(error),
        isRetryableProcessingError(error),
      );
      logger.error("extraction.failed", {
        eventId: registration.event.id,
        leadId: prepared.lead!.id,
        source: input.source,
        llmLatencyMs,
        llmSuccess: false,
        retryable: isRetryableProcessingError(error),
        errorCode: safeErrorCode(error),
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }

    const llmLatencyMs = elapsedMilliseconds(llmStartedAt, timer);
    logger.info("extraction.success", {
      eventId: registration.event.id,
      leadId: prepared.lead!.id,
      source: input.source,
      llmLatencyMs,
      llmSuccess: true,
      model: extracted.llm.model,
      inputTokens: extracted.llm.inputTokens,
      outputTokens: extracted.llm.outputTokens,
    });
    logger.info("facts.extracted", {
      eventId: registration.event.id,
      leadId: prepared.lead!.id,
      source: input.source,
      factNames: extractedFactNames(extracted.extraction),
      questionCount: extracted.extraction.signals.questions.length,
      objectionCount: extracted.extraction.signals.objections.length,
      wantsHuman: extracted.extraction.signals.wantsHuman,
    });

    try {
      const currentLead = await persistence.leads.findByExternalIdentity(
        input.source,
        input.externalLeadId,
      );
      if (!currentLead) throw new Error("Prepared lead no longer exists");
      const currentConversation =
        await persistence.conversations.findOpenByLeadId(currentLead.id);
      if (!currentConversation) {
        throw new Error("Prepared conversation no longer exists");
      }

      if (
        prepared.inboundSequence !== null &&
        prepared.inboundSequence <= currentConversation.lastAppliedInboundSequence
      ) {
        const processedAt = clock();
        const totalProcessingLatencyMs = elapsedMilliseconds(
          processingStartedAt,
          timer,
        );
        await persistence.incomingEvents.markProcessed(registration.event.id, {
          extraction: extracted.extraction,
          llmModel: extracted.llm.model,
          llmInputTokens: extracted.llm.inputTokens,
          llmOutputTokens: extracted.llm.outputTokens,
          llmLatencyMs,
          totalProcessingLatencyMs,
          processedAt,
        });
        logger.info("event.out_of_order_ignored", {
          eventId: registration.event.id,
          leadId: currentLead.id,
          conversationId: currentConversation.id,
          source: input.source,
          inboundSequence: prepared.inboundSequence,
          lastAppliedInboundSequence:
            currentConversation.lastAppliedInboundSequence,
        });
        return buildResult({
          event: {
            ...registration.event,
            status: "PROCESSED",
            extraction: extracted.extraction,
            llmModel: extracted.llm.model,
            llmInputTokens: extracted.llm.inputTokens,
            llmOutputTokens: extracted.llm.outputTokens,
            llmLatencyMs,
            totalProcessingLatencyMs,
            processedAt,
          },
          lead: currentLead,
          conversation: currentConversation,
          duplicate: false,
          outOfOrderIgnored: true,
          extraction: extracted.extraction,
          totalProcessingLatencyMs,
        });
      }

      const evaluatedAt = clock();
      let evaluatedLead = mergeExtractedFacts(
        currentLead,
        extracted.extraction,
        evaluatedAt,
      );
      const history = await persistence.messages.listByConversationId(
        currentConversation.id,
      );
      const latestOutbound = history.findLast(
        (message) => message.direction === "OUTBOUND",
      );
      const phoneReceived =
        extracted.extraction.facts.phoneNumber !== null &&
        extracted.extraction.facts.phoneConfirmed;
      const phoneFulfillsRecentStep = phoneReceived && latestOutbound !== undefined;
      const inboundSequence = prepared.inboundSequence ??
        currentConversation.lastAppliedInboundSequence + 1;
      const storedConversationMemory = parseStoredConversationMemory(
        currentConversation.summary,
      );
      const conversationMemory = rememberDeferredInformationNeed({
        memory: storedConversationMemory,
        pendingInformationNeed: currentConversation.pendingInformationNeed,
        previousQuestionResponse:
          extracted.extraction.signals.previousQuestionResponse,
        inboundSequence,
      });
      const deferredInformationNeeds = activeDeferredInformationNeeds(
        conversationMemory,
        inboundSequence,
      );
      const guidanceNeed =
        currentConversation.pendingInformationNeed !== null &&
        ["UNSURE", "DECLINED_TO_ANSWER"].includes(
          extracted.extraction.signals.previousQuestionResponse ??
            "NOT_A_RESPONSE",
        )
          ? currentConversation.pendingInformationNeed
          : null;
      const previouslyExplainedKnowledge =
        conversationMemory.knowledgeEntryIds;
      const knowledge = answerFromKnowledgeBase(extracted.extraction, {
        previousEntryIds: previouslyExplainedKnowledge,
        guidanceNeed,
        recentMessages: history.map(({ direction, actor, content }) => ({ direction, actor, content })),
        leadFacts: {
          city: evaluatedLead.city,
          availableCapital: evaluatedLead.availableCapital,
          entryBudget: evaluatedLead.entryBudget,
          startingUnits: evaluatedLead.startingUnits,
          scalingPotentialUnits: evaluatedLead.scalingPotentialUnits,
        },
      });
      const decision = evaluateQualification(evaluatedLead, qualificationContextForLead(evaluatedLead, {
        wantsHuman: extracted.extraction.signals.wantsHuman,
        unknownBusinessQuestion: knowledge.unresolvedQuestions.length > 0,
      }));
      evaluatedLead = {
        ...evaluatedLead,
        qualificationStatus: decision.status,
        qualificationReason: decision.reason,
      };
      const needs = assessInformationNeeds(evaluatedLead, {
        excludedNextInformationNeeds: deferredInformationNeeds,
      });
      // Qualification assessment exposes missing facts for policy and CRM,
      // but it never selects the next conversational question. Claude gets
      // the complete set of allowed directions and may return one or null.
      const nextInformationNeed = null;
      const responsePlan = buildConversationResponse({
        lead: evaluatedLead,
        extraction: extracted.extraction,
        decision,
        nextInformationNeed,
        knowledge,
        informationNeeds: needs,
        previouslyExplainedKnowledgeEntryIds: previouslyExplainedKnowledge,
        deferredInformationNeeds:
          conversationMemory.deferredInformationNeeds.map((item) => item.need),
        guidanceNeed,
      });
      const responseGenerationPlan = phoneFulfillsRecentStep
        ? {
            ...responsePlan,
            asksUserQuestion: false,
            nextInformationNeed: null,
            allowedNextInformationNeeds: [],
            allowedNextQuestions: [],
            allowedQualificationMoves: [],
          }
        : responsePlan;
      let responseLlm: Awaited<ReturnType<NaturalResponseGenerator>> | null =
        null;
      if (
        !options.suppressOutbound &&
        responseGenerationPlan.useNaturalAdaptation &&
        generateNaturalResponse &&
        !phoneFulfillsRecentStep
      ) {
        try {
          responseLlm = await generateNaturalResponse({
            lead: evaluatedLead,
            plan: responseGenerationPlan,
            recentMessages: history.map(({ direction, actor, content }) => ({
              direction,
              actor,
              content,
            })),
          });
        } catch (error) {
          logger.error("response_generation.fallback", {
            eventId: registration.event.id,
            leadId: prepared.lead!.id,
            conversationId: prepared.conversation!.id,
            source: input.source,
            errorType: safeErrorCode(error),
          });
        }
      }
      const completed = await persistence.transaction(async (repositories) => {
        const storedLead = await repositories.leads.findByExternalIdentity(
          input.source,
          input.externalLeadId,
        );
        if (!storedLead) throw new Error("Prepared lead no longer exists");
        const storedConversation =
          await repositories.conversations.findOpenByLeadId(storedLead.id);
        if (!storedConversation) {
          throw new Error("Prepared conversation no longer exists");
        }

        const now = clock();
        const totalProcessingLatencyMs = elapsedMilliseconds(
          processingStartedAt,
          timer,
        );
        if (
          prepared.inboundSequence !== null &&
          prepared.inboundSequence <= storedConversation.lastAppliedInboundSequence
        ) {
          await repositories.incomingEvents.markProcessed(registration.event.id, {
            extraction: extracted.extraction,
            llmModel: extracted.llm.model,
            llmInputTokens: extracted.llm.inputTokens,
            llmOutputTokens: extracted.llm.outputTokens,
            llmLatencyMs,
            totalProcessingLatencyMs,
            processedAt: now,
          });
          return {
            outOfOrderIgnored: true as const,
            lead: storedLead,
            conversation: storedConversation,
            decision: evaluateQualification(storedLead),
            managerSummary: null,
            outboundMessageId: null,
            managerNotificationId: null,
            totalProcessingLatencyMs,
          };
        }

        let transactionLead = mergeExtractedFacts(
          storedLead,
          extracted.extraction,
          now,
        );
        const transactionDecision = evaluateQualification(transactionLead, qualificationContextForLead(transactionLead, {
          wantsHuman: extracted.extraction.signals.wantsHuman,
          unknownBusinessQuestion:
            knowledge.unresolvedQuestions.length > 0 ||
            responseLlm?.answerCoverage === "UNKNOWN",
        }));
        transactionLead = {
          ...transactionLead,
          qualificationStatus: transactionDecision.status,
          qualificationReason: transactionDecision.reason,
        };
        const transactionNeeds = assessInformationNeeds(transactionLead, {
          excludedNextInformationNeeds: deferredInformationNeeds,
        });
        const adaptiveNextInformationNeed = responseLlm?.nextInformationNeed;
        let transactionNextInformationNeed =
          phoneFulfillsRecentStep || responseLlm?.replyAction === "NO_REPLY"
            ? null
            : transactionDecision.nextAction !== "CONTINUE_QUALIFICATION"
              ? null
              : responseLlm !== null &&
                  adaptiveNextInformationNeed != null &&
                  transactionNeeds.allowedNextInformationNeeds.includes(
                    adaptiveNextInformationNeed,
                  )
                ? adaptiveNextInformationNeed
                : null;
        let transactionResponsePlan = buildConversationResponse({
          lead: transactionLead,
          extraction: extracted.extraction,
          decision: transactionDecision,
          nextInformationNeed: transactionNextInformationNeed,
          knowledge,
          informationNeeds: transactionNeeds,
          previouslyExplainedKnowledgeEntryIds: previouslyExplainedKnowledge,
          deferredInformationNeeds:
            conversationMemory.deferredInformationNeeds.map((item) => item.need),
          guidanceNeed,
        });
        // If the conversation model is unavailable or rejected by policy, keep
        // the sales workflow alive with the existing deterministic safe draft.
        // This fallback is exceptional: during normal operation Claude chooses
        // freely among every allowed qualification direction.
        if (
          responseLlm === null &&
          transactionResponsePlan.qualificationProgressExpected === true
        ) {
          transactionNextInformationNeed =
            transactionNeeds.suggestedNextInformationNeed;
          transactionResponsePlan = buildConversationResponse({
            lead: transactionLead,
            extraction: extracted.extraction,
            decision: transactionDecision,
            nextInformationNeed: transactionNextInformationNeed,
            knowledge,
            informationNeeds: transactionNeeds,
            previouslyExplainedKnowledgeEntryIds: previouslyExplainedKnowledge,
            deferredInformationNeeds:
              conversationMemory.deferredInformationNeeds.map((item) => item.need),
            guidanceNeed,
          });
        }
        const canUseAdaptiveResponse =
          responseLlm !== null &&
          responseLlm.replyAction !== "NO_REPLY" &&
          responseLlm.nextInformationNeed === transactionNextInformationNeed;
        const transactionOutboundText = canUseAdaptiveResponse
          ? responseLlm!.text
          : transactionResponsePlan.text;

        const responseSuppressed =
          options.suppressOutbound === true ||
          (prepared.inboundSequence !== null &&
            prepared.inboundSequence < storedConversation.nextInboundSequence);
        const postHandoffSubstantiveInbound =
          storedLead.handoffAt !== null &&
          (extractedFactNames(extracted.extraction).length > 0 ||
            extracted.extraction.signals.questions.length > 0 ||
            extracted.extraction.signals.objections.length > 0);
        const noAiReply =
          (responseLlm?.replyAction === "NO_REPLY" && !postHandoffSubstantiveInbound) ||
          (phoneFulfillsRecentStep && !transactionDecision.shouldHandoffToManager);
        const shouldSendOutbound = !responseSuppressed && !noAiReply;
        const responseGenerationSource = responseSuppressed
          ? "SUPPRESSED"
          : noAiReply
            ? "NO_REPLY"
            : responseLlm
              ? "LLM"
              : "FALLBACK_DRAFT";
        const qualificationCompleted = responseSuppressed
          ? storedConversation.qualificationCompleted
          : transactionDecision.nextAction === "REJECT_POLITELY" ||
            transactionDecision.shouldHandoffToManager;
        const targetState =
          transactionDecision.status === "NO_FIT"
            ? "CLOSED"
            : transactionDecision.status === "HANDOFF"
              ? "HANDOFF"
              : transactionDecision.shouldHandoffToManager
                ? "QUALIFIED"
                : transactionDecision.nextAction === "CONTINUE_QUALIFICATION" &&
                    transactionNextInformationNeed === null
                  ? storedConversation.state === "NEW"
                    ? "DISCOVERY"
                    : "QUALIFYING"
                  : stateForInformationNeed(transactionNextInformationNeed);
        // Legacy premature handoffs without a phone must resume qualification.
        const resumeIncompleteHandoff =
          storedConversation.state === "HANDOFF" &&
          !hasConfirmedPhone(storedLead);
        const nextState = responseSuppressed
          ? storedConversation.state
          : (storedConversation.state === "HANDOFF" &&
                !resumeIncompleteHandoff) ||
              storedConversation.state === "CLOSED"
            ? storedConversation.state
            : transitionConversation(
                resumeIncompleteHandoff
                  ? "QUALIFYING"
                  : storedConversation.state,
                targetState,
              );
        const storedMemory = parseStoredConversationMemory(
          storedConversation.summary,
        );
        const storedPreviouslyExplainedKnowledge =
          storedMemory.knowledgeEntryIds;
        const newlyExplainedKnowledge = responseSuppressed
          ? []
          : responseLlm?.usedKnowledgeEntryIds ?? knowledge.entryIds;
        const explainedKnowledge = responseSuppressed
          ? storedPreviouslyExplainedKnowledge
          : [
              ...new Set([
                ...storedPreviouslyExplainedKnowledge,
                ...newlyExplainedKnowledge,
              ]),
            ];
        const unresolvedDeferredInformationNeeds =
          conversationMemory.deferredInformationNeeds.filter(
            (item) => !transactionNeeds.knownFacts.includes(item.need),
          );
        const updatedConversationMemory: StoredConversationMemory = {
          knowledgeEntryIds: explainedKnowledge,
          deferredInformationNeeds: responseSuppressed
            ? storedMemory.deferredInformationNeeds
            : unresolvedDeferredInformationNeeds,
        };
        const managerSummary =
          !responseSuppressed &&
          transactionDecision.shouldHandoffToManager
            ? createManagerSummary(
                transactionLead,
                transactionDecision,
                explainedKnowledge,
              )
            : null;
        const updatedLead: Lead = {
          ...transactionLead,
          conversationSummary: managerSummary
            ? JSON.stringify(managerSummary)
            : transactionLead.conversationSummary,
          handoffAt:
            !responseSuppressed &&
            transactionDecision.shouldHandoffToManager &&
            !transactionLead.handoffAt
              ? now
              : transactionLead.handoffAt,
          updatedAt: now,
        };
        await repositories.leads.update(updatedLead);

        let outboundMessageId: string | null = null;
        if (shouldSendOutbound) {
          const turnId =
            prepared.inboundSequence === null
              ? registration.event.id
              : String(prepared.inboundSequence);
          const outboundDeduplicationKey =
            `turn-response:${storedConversation.id}:${turnId}`;
          const outboundMessage: Message = {
            id: idGenerator(),
            conversationId: storedConversation.id,
            leadId: storedLead.id,
            incomingEventId: null,
            externalMessageId: null,
            deduplicationKey: outboundDeduplicationKey,
            sequence: null,
            direction: "OUTBOUND",
            actor: "AI",
            content: transactionOutboundText,
            deliveryStatus: "PENDING",
            deliveryAttempts: 0,
            deliveryRetryable: null,
            lastDeliveryErrorCode: null,
            sentAt: null,
            createdAt: now,
          };
          await repositories.messages.insertIfAbsent(outboundMessage);
          outboundMessageId =
            (
              await repositories.messages.findByDeduplicationKey(
                outboundDeduplicationKey,
              )
            )?.id ?? null;
        }

        let managerNotificationId: string | null = null;
        if (
          !responseSuppressed &&
          transactionDecision.shouldHandoffToManager &&
          storedLead.handoffAt === null &&
          managerSummary
        ) {
          const idempotencyKey = `manager-handoff:${storedLead.id}`;
          const notification: ManagerNotification = {
            id: idGenerator(),
            leadId: storedLead.id,
            conversationId: storedConversation.id,
            qualificationStatus: transactionDecision.status,
            summary: managerSummary,
            idempotencyKey,
            deliveryStatus: "PENDING",
            deliveryAttempts: 0,
            deliveryRetryable: null,
            lastDeliveryErrorCode: null,
            externalNotificationId: null,
            createdAt: now,
            updatedAt: now,
            sentAt: null,
          };
          await repositories.managerNotifications.insertIfAbsent(notification);
          managerNotificationId =
            (
              await repositories.managerNotifications.findByIdempotencyKey(
                idempotencyKey,
              )
            )?.id ?? null;
        } else if (
          !responseSuppressed &&
          transactionDecision.shouldHandoffToManager &&
          managerSummary
        ) {
          // Refresh only an untouched legacy queue entry after collecting its missing phone.
          // Never create another handoff or reset an attempted/sent notification.
          const existing =
            await repositories.managerNotifications.findByIdempotencyKey(
              `manager-handoff:${storedLead.id}`,
            );
          if (
            existing?.deliveryStatus === "PENDING" &&
            existing.deliveryAttempts === 0 &&
            !existing.summary.phoneNumber
          ) {
            await repositories.managerNotifications.update({
              ...existing,
              summary: managerSummary,
              qualificationStatus: transactionDecision.status,
              updatedAt: now,
            });
            managerNotificationId = existing.id;
          }
        }

        const updatedConversation: Conversation = {
          ...storedConversation,
          state: nextState,
          summary: JSON.stringify(updatedConversationMemory),
          pendingInformationNeed: responseSuppressed
            ? storedConversation.pendingInformationNeed
            : qualificationCompleted
              ? null
              : transactionNextInformationNeed,
          awaitingUserReply: responseSuppressed
            ? storedConversation.awaitingUserReply
            : shouldSendOutbound && transactionNextInformationNeed !== null,
          qualificationCompleted,
          followUpEligibleAt: responseSuppressed
            ? storedConversation.followUpEligibleAt
            : null,
          lastAppliedInboundSequence: Math.max(
            storedConversation.lastAppliedInboundSequence,
            prepared.inboundSequence ?? 0,
          ),
          updatedAt: now,
          closedAt: responseSuppressed
            ? storedConversation.closedAt
            : transactionDecision.status === "NO_FIT"
              ? now
              : storedConversation.closedAt,
        };
        await repositories.conversations.update(updatedConversation);

        await repositories.incomingEvents.markProcessed(registration.event.id, {
          extraction: extracted.extraction,
          llmModel: extracted.llm.model,
          llmInputTokens: extracted.llm.inputTokens,
          llmOutputTokens: extracted.llm.outputTokens,
          llmLatencyMs,
          totalProcessingLatencyMs,
          processedAt: now,
        });

        return {
          outOfOrderIgnored: false as const,
          responseSuppressed,
          lead: updatedLead,
          conversation: updatedConversation,
          decision: transactionDecision,
          managerSummary,
          outboundMessageId,
          managerNotificationId,
          responseGenerationSource,
          asksUserQuestion:
            shouldSendOutbound && transactionResponsePlan.asksUserQuestion,
          outboundText: shouldSendOutbound ? transactionOutboundText : null,
          totalProcessingLatencyMs,
        };

      });

      if (completed.outOfOrderIgnored) {
        logger.info("event.out_of_order_ignored", {
          eventId: registration.event.id,
          leadId: completed.lead.id,
          conversationId: completed.conversation.id,
          source: input.source,
          inboundSequence: prepared.inboundSequence,
          lastAppliedInboundSequence:
            completed.conversation.lastAppliedInboundSequence,
        });
        return buildResult({
          event: {
            ...registration.event,
            status: "PROCESSED",
            extraction: extracted.extraction,
            llmModel: extracted.llm.model,
            llmInputTokens: extracted.llm.inputTokens,
            llmOutputTokens: extracted.llm.outputTokens,
            llmLatencyMs,
            totalProcessingLatencyMs: completed.totalProcessingLatencyMs,
            processedAt: completed.conversation.updatedAt,
          },
          lead: completed.lead,
          conversation: completed.conversation,
          duplicate: false,
          outOfOrderIgnored: true,
          extraction: extracted.extraction,
          totalProcessingLatencyMs: completed.totalProcessingLatencyMs,
          decision: completed.decision,
        });
      }

      if (completed.responseSuppressed) {
        logger.info("event.response_superseded", {
          eventId: registration.event.id,
          leadId: completed.lead.id,
          conversationId: completed.conversation.id,
          source: input.source,
          inboundSequence: prepared.inboundSequence,
          latestInboundSequence: completed.conversation.nextInboundSequence,
        });
      }

      let finalConversation = completed.conversation;
      if (outboundProvider && completed.outboundMessageId) {
        const delivered = await createOutboundMessageDelivery({
          persistence,
          provider: outboundProvider,
          logger,
          now: clock,
          eventId: registration.event.id,
        })(completed.outboundMessageId);
        if (delivered.deliveryStatus === "SENT") {
          finalConversation = await persistence.transaction(
            async (repositories) => {
              const conversation = await repositories.conversations.findById(
                completed.conversation.id,
              );
              if (!conversation) {
                throw new Error("Delivered message conversation was not found");
              }
              const awaitingUserReply =
                completed.asksUserQuestion &&
                !conversation.qualificationCompleted;
              const updated: Conversation = {
                ...conversation,
                lastOutboundAt: delivered.sentAt,
                awaitingUserReply,
                followUpEligibleAt:
                  awaitingUserReply && delivered.sentAt
                    ? followUpEligibleAt(delivered.sentAt)
                    : null,
                updatedAt: delivered.sentAt ?? conversation.updatedAt,
              };
              await repositories.conversations.update(updated);
              return updated;
            },
          );
        }
      }
      if (managerNotificationProvider && completed.managerNotificationId) {
        await createManagerNotificationDelivery({
          persistence,
          provider: managerNotificationProvider,
          logger,
          now: clock,
          eventId: registration.event.id,
        })(completed.managerNotificationId);
      }

      logger.info("qualification.updated", {
        eventId: registration.event.id,
        leadId: completed.lead.id,
        conversationId: completed.conversation.id,
        source: input.source,
        qualificationStatus: completed.lead.qualificationStatus,
        qualificationReason: completed.lead.qualificationReason,
        reasonCodes: completed.decision.reasonCodes,
        blockingReasons: completed.decision.blockingReasons,
        weakSignals: completed.decision.weakSignals,
        shouldHandoffToManager: completed.decision.shouldHandoffToManager,
        qualificationSatisfied: ["QUALIFIED", "PRIORITY", "HOT", "WARM"].includes(completed.lead.qualificationStatus),
        phoneKnown: hasConfirmedPhone(completed.lead),
        nextBusinessGoal: completed.decision.shouldHandoffToManager
          ? "HANDOFF"
          : ["QUALIFIED", "PRIORITY", "HOT", "WARM"].includes(completed.lead.qualificationStatus) && !hasConfirmedPhone(completed.lead)
            ? "REQUEST_PHONE_FOR_HANDOFF"
            : "CONTINUE_CONVERSATION",
        nextAction: completed.decision.nextAction,
        serviceability: completed.lead.serviceability,
        totalProcessingLatencyMs: completed.totalProcessingLatencyMs,
      });
      logger.info("conversation.turn", {
        conversationId: completed.conversation.id,
        latestInboundId: input.messageId,
        triggerType: "USER_INBOUND",
        detectedIntent: extracted.extraction.intent,
        answeredUserQuestion:
          extracted.extraction.signals.questions.length > 0 &&
          completed.outboundText !== null,
        qualificationStatus: completed.lead.qualificationStatus,
        selectedQualificationNeed: completed.conversation.pendingInformationNeed,
        qualificationSatisfied: ["QUALIFIED", "PRIORITY", "HOT", "WARM"].includes(
          completed.lead.qualificationStatus,
        ),
        phoneKnown: hasConfirmedPhone(completed.lead),
        nextBusinessGoal: completed.decision.shouldHandoffToManager
          ? "HANDOFF"
          : ["QUALIFIED", "PRIORITY", "HOT", "WARM"].includes(
                completed.lead.qualificationStatus,
              ) && !hasConfirmedPhone(completed.lead)
            ? "REQUEST_PHONE_FOR_HANDOFF"
            : "CONTINUE_CONVERSATION",
        handoffDecision: completed.decision.shouldHandoffToManager
          ? "HANDOFF"
          : "NONE",
        followUpDecision: completed.conversation.followUpEligibleAt
          ? "SCHEDULED"
          : "NONE",
        knownFactsUsed: assessInformationNeeds(completed.lead).knownFacts,
        fallbackUsed: completed.responseGenerationSource === "FALLBACK_DRAFT",
        fallbackReason:
          completed.responseGenerationSource === "FALLBACK_DRAFT"
            ? "LLM_UNAVAILABLE_OR_INVALID_OUTPUT"
            : null,
        responseGenerationSource: completed.responseGenerationSource,
      });
      if (completed.decision.status === "NO_FIT") {
        logger.info("qualification.no_fit", {
          eventId: registration.event.id,
          leadId: completed.lead.id,
          conversationId: completed.conversation.id,
          source: input.source,
          reasonCodes: completed.decision.reasonCodes,
        });
      }
      if (completed.decision.shouldHandoffToManager) {
        logger.info("qualification.handoff_ready", {
          eventId: registration.event.id,
          leadId: completed.lead.id,
          conversationId: completed.conversation.id,
          source: input.source,
          qualificationStatus: completed.decision.status,
        });
      }

      return buildResult({
        event: {
          ...registration.event,
          status: "PROCESSED",
          extraction: extracted.extraction,
          llmModel: extracted.llm.model,
          llmInputTokens: extracted.llm.inputTokens,
          llmOutputTokens: extracted.llm.outputTokens,
          llmLatencyMs,
          totalProcessingLatencyMs: completed.totalProcessingLatencyMs,
          processedAt: completed.conversation.updatedAt,
        },
        lead: completed.lead,
        conversation: finalConversation,
        duplicate: false,
        extraction: extracted.extraction,
        totalProcessingLatencyMs: completed.totalProcessingLatencyMs,
        decision: completed.decision,
        outboundMessage: completed.outboundText,
        managerSummary: completed.managerSummary,
        responseLlm,
      });
    } catch (error) {
      await persistence.incomingEvents.markFailed(
        registration.event.id,
        safeErrorCode(error),
        isRetryableProcessingError(error),
      );
      throw error;
    }
  };
}
