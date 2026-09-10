import { z } from "zod";

import type { NaturalResponseGenerator } from "../conversation/generate-natural-response";
import { EventProcessingRejectedError } from "../errors/event-processing-error";
import { RetryableInfrastructureError } from "../errors/infrastructure-error";
import { createManagerNotificationDelivery } from "../delivery/deliver-manager-notification";
import { createOutboundMessageDelivery } from "../delivery/deliver-outbound-message";
import type { ExtractMessageResult } from "../extraction/extract-message";
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
} from "../security/technical-limits";
import { buildConversationResponse } from "../../domain/conversation/conversation-response";
import {
  assessInformationNeeds,
  stateForInformationNeed,
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
  text: string,
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

interface PreparedEvent {
  claimed: boolean;
  recoveredStale: boolean;
  inboundSequence: number | null;
  lead: Lead | null;
  conversation: Conversation | null;
}

export const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1_000;

function createLead(
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
    lead = createLead(idGenerator(), input.source, input.externalLeadId, now);
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

  const pendingFollowUp = await repositories.messages.findByDeduplicationKey(
    `qualification-follow-up:${conversation.id}:1`,
  );
  if (pendingFollowUp?.deliveryStatus === "PENDING") {
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
    ? evaluateQualification(lead, {
        wantsHuman:
          extraction?.signals.wantsHuman === true ||
          conversation?.state === "HANDOFF",
        unknownBusinessQuestion:
          extraction !== null &&
          answerFromKnowledgeBase(extraction).unresolvedQuestions.length > 0,
      })
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
  const code = "code" in error ? String(error.code) : error.name;
  return code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100);
}

function isRetryableProcessingError(error: unknown): boolean {
  return error instanceof RetryableInfrastructureError;
}

function parseStoredKnowledgeIds(summary: string | null): string[] {
  if (!summary) return [];
  try {
    const parsed: unknown = JSON.parse(summary);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
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
      extracted = await extractMessage(input.text);
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
        retryable:
          error instanceof Error && "retryable" in error
            ? Boolean(error.retryable)
            : true,
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
      const knowledge = answerFromKnowledgeBase(extracted.extraction);
      const decision = evaluateQualification(evaluatedLead, {
        wantsHuman:
          extracted.extraction.signals.wantsHuman ||
          currentConversation.state === "HANDOFF",
        unknownBusinessQuestion: knowledge.unresolvedQuestions.length > 0,
      });
      evaluatedLead = {
        ...evaluatedLead,
        qualificationStatus: decision.status,
        qualificationReason: decision.reason,
      };
      const needs = assessInformationNeeds(evaluatedLead);
      const nextInformationNeed =
        decision.nextAction === "CONTINUE_QUALIFICATION"
          ? needs.suggestedNextInformationNeed
          : null;
      const responsePlan = buildConversationResponse({
        lead: evaluatedLead,
        extraction: extracted.extraction,
        decision,
        nextInformationNeed,
        knowledge,
      });
      const history = await persistence.messages.listByConversationId(
        currentConversation.id,
      );
      let responseLlm: Awaited<ReturnType<NaturalResponseGenerator>> | null =
        null;
      if (responsePlan.useNaturalAdaptation && generateNaturalResponse) {
        try {
          responseLlm = await generateNaturalResponse({
            lead: evaluatedLead,
            plan: responsePlan,
            recentMessages: history.map(({ direction, content }) => ({
              direction,
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
        const transactionDecision = evaluateQualification(transactionLead, {
          wantsHuman:
            extracted.extraction.signals.wantsHuman ||
            storedConversation.state === "HANDOFF",
          unknownBusinessQuestion: knowledge.unresolvedQuestions.length > 0,
        });
        transactionLead = {
          ...transactionLead,
          qualificationStatus: transactionDecision.status,
          qualificationReason: transactionDecision.reason,
        };
        const transactionNeeds = assessInformationNeeds(transactionLead);
        const transactionNextInformationNeed =
          transactionDecision.nextAction === "CONTINUE_QUALIFICATION"
            ? transactionNeeds.suggestedNextInformationNeed
            : null;
        const transactionResponsePlan = buildConversationResponse({
          lead: transactionLead,
          extraction: extracted.extraction,
          decision: transactionDecision,
          nextInformationNeed: transactionNextInformationNeed,
          knowledge,
        });
        const transactionOutboundText =
          responseLlm?.text ?? transactionResponsePlan.text;

        const qualificationCompleted =
          transactionDecision.nextAction === "REJECT_POLITELY" ||
          transactionDecision.shouldHandoffToManager;
        const targetState =
          transactionDecision.status === "NO_FIT"
            ? "CLOSED"
            : transactionDecision.status === "HANDOFF"
              ? "HANDOFF"
              : transactionDecision.shouldHandoffToManager
                ? "QUALIFIED"
                : stateForInformationNeed(transactionNextInformationNeed);
        const nextState =
          storedConversation.state === "HANDOFF" ||
          storedConversation.state === "CLOSED"
            ? storedConversation.state
            : transitionConversation(storedConversation.state, targetState);
        const explainedKnowledge = [
          ...new Set([
            ...parseStoredKnowledgeIds(storedConversation.summary),
            ...knowledge.entryIds,
          ]),
        ];
        const managerSummary = transactionDecision.shouldHandoffToManager
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
            transactionDecision.shouldHandoffToManager &&
            !transactionLead.handoffAt
              ? now
              : transactionLead.handoffAt,
          updatedAt: now,
        };
        await repositories.leads.update(updatedLead);

        const outboundDeduplicationKey = `event-response:${registration.event.id}`;
        const outboundMessage: Message = {
          id: idGenerator(),
          conversationId: storedConversation.id,
          leadId: storedLead.id,
          incomingEventId: null,
          externalMessageId: null,
          deduplicationKey: outboundDeduplicationKey,
          sequence: null,
          direction: "OUTBOUND",
          content: transactionOutboundText,
          deliveryStatus: "PENDING",
          deliveryAttempts: 0,
          deliveryRetryable: null,
          lastDeliveryErrorCode: null,
          sentAt: null,
          createdAt: now,
        };
        await repositories.messages.insertIfAbsent(outboundMessage);
        const storedOutboundMessage =
          await repositories.messages.findByDeduplicationKey(
            outboundDeduplicationKey,
          );

        let managerNotificationId: string | null = null;
        if (
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
        }

        const updatedConversation: Conversation = {
          ...storedConversation,
          state: nextState,
          summary: JSON.stringify(explainedKnowledge),
          pendingInformationNeed: qualificationCompleted
            ? null
            : transactionNextInformationNeed,
          awaitingUserReply: false,
          qualificationCompleted,
          followUpEligibleAt: null,
          lastAppliedInboundSequence: Math.max(
            storedConversation.lastAppliedInboundSequence,
            prepared.inboundSequence ?? 0,
          ),
          updatedAt: now,
          closedAt:
            transactionDecision.status === "NO_FIT"
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
          lead: updatedLead,
          conversation: updatedConversation,
          decision: transactionDecision,
          managerSummary,
          outboundMessageId: storedOutboundMessage?.id ?? null,
          managerNotificationId,
          asksUserQuestion: transactionResponsePlan.asksUserQuestion,
          outboundText: transactionOutboundText,
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
        nextAction: completed.decision.nextAction,
        serviceability: completed.lead.serviceability,
        totalProcessingLatencyMs: completed.totalProcessingLatencyMs,
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
