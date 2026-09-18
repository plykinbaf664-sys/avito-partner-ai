import { assessInformationNeeds } from "@/domain/conversation/information-needs";
import type { ConversationResponsePlan } from "@/domain/conversation/conversation-response";
import { questionForInformationNeed } from "@/domain/conversation/conversation-response";
import type { Conversation } from "@/domain/conversation/conversation";
import type { InformationNeed } from "@/domain/conversation/information-needs";
import {
  buildQualificationFollowUp,
  evaluateFollowUpEligibility,
} from "@/domain/follow-up/follow-up-policy";
import { hasConfirmedPhone } from "@/domain/qualification/qualification-policy";
import type { Lead } from "@/domain/lead/lead";
import type { Message } from "@/domain/message/message";
import { generateId, type IdGenerator } from "@/shared/id";

import type {
  NaturalResponseGenerator,
} from "../conversation/generate-natural-response";
import { createOutboundMessageDelivery } from "../delivery/deliver-outbound-message";
import { canRetryExternalDelivery } from "../delivery/retry-policy";
import {
  silentLogger,
  type StructuredLogger,
} from "../observability/structured-logger";
import type { OutboundMessageProvider } from "../ports/channels";
import type { Persistence } from "../ports/repositories";

const QUALIFIED_STATUSES = ["QUALIFIED", "PRIORITY", "HOT", "WARM"] as const;

function followUpDeduplicationKey(conversation: Conversation): string {
  const stage = conversation.lastOutboundAt?.getTime() ?? conversation.updatedAt.getTime();
  return `qualification-follow-up:${conversation.id}:${stage}`;
}

function buildFollowUpPlan(
  lead: Lead,
  conversation: Conversation,
): ConversationResponsePlan {
  const needs = assessInformationNeeds(lead);
  const qualificationSatisfied = QUALIFIED_STATUSES.includes(
    lead.qualificationStatus as (typeof QUALIFIED_STATUSES)[number],
  );
  const allowedNextInformationNeeds: InformationNeed[] =
    qualificationSatisfied && !hasConfirmedPhone(lead)
      ? ["PHONE_NUMBER"]
      : conversation.pendingInformationNeed !== null &&
          !needs.knownFacts.includes(conversation.pendingInformationNeed)
        ? [conversation.pendingInformationNeed]
        : needs.allowedNextInformationNeeds;
  const nextInformationNeed = allowedNextInformationNeeds[0] ?? null;
  return {
    text:
      "Сформируй одно короткое естественное продолжение разговора после паузы.",
    nextInformationNeed,
    asksUserQuestion: nextInformationNeed !== null,
    knowledgeEntryIds: [],
    unresolvedQuestions: [],
    useNaturalAdaptation: true,
    allowedNextInformationNeeds,
    allowedNextQuestions: allowedNextInformationNeeds.map((need) => ({
      need,
      question: questionForInformationNeed(need, lead),
    })),
    knownFacts: needs.knownFacts,
    missingCriticalFacts: needs.missingCriticalFacts,
    missingOptionalFacts: needs.missingOptionalFacts,
    qualificationReasonCodes: [],
  };
}

export interface ProcessDueFollowUpsResult {
  scanned: number;
  created: Message[];
  sent: Message[];
  failed: Message[];
  skipped: number;
}

export interface ProcessDueFollowUpsDependencies {
  persistence: Persistence;
  outboundProvider?: OutboundMessageProvider;
  generateNaturalResponse?: NaturalResponseGenerator;
  logger?: StructuredLogger;
  generateId?: IdGenerator;
  limit?: number;
}


export function createDueFollowUpsProcessor({
  persistence,
  outboundProvider,
  generateNaturalResponse,
  logger = silentLogger,
  generateId: idGenerator = generateId,
  limit = 100,
}: ProcessDueFollowUpsDependencies) {
  return async function processDueFollowUps(
    now: Date,
  ): Promise<ProcessDueFollowUpsResult> {
    const candidates = await persistence.conversations.listDueFollowUps(now, limit);
    const created: Message[] = [];
    const sent: Message[] = [];
    const failed: Message[] = [];

    for (const candidate of candidates) {
      logger.info("follow_up.due", {
        leadId: candidate.leadId,
        conversationId: candidate.id,
        scheduledFor: candidate.followUpEligibleAt?.toISOString() ?? null,
      });

      const prepared = await persistence.transaction(async (repositories) => {
        const conversation = await repositories.conversations.findById(candidate.id);
        if (!conversation) return null;
        const lead = await repositories.leads.findById(conversation.leadId);
        if (!lead) return null;
        const eligibility = evaluateFollowUpEligibility(conversation, lead, now);
        if (!eligibility.eligible) {
          logger.info("follow_up.skipped", {
            leadId: lead.id,
            conversationId: conversation.id,
            reason: eligibility.reason,
          });
          return null;
        }
        const history = await repositories.messages.listByConversationId(
          conversation.id,
        );
        if (
          history.some(
            (message) =>
              message.direction === "OUTBOUND" &&
              message.deliveryStatus === "PENDING",
          )
        ) {
          logger.info("follow_up.skipped", {
            leadId: lead.id,
            conversationId: conversation.id,
            reason: "PENDING_OUTBOUND",
          });
          return null;
        }
        const deduplicationKey = followUpDeduplicationKey(conversation);
        const existing =
          await repositories.messages.findByDeduplicationKey(deduplicationKey);
        if (existing) {
          return canRetryExternalDelivery({
            attempts: existing.deliveryAttempts,
            retryable: existing.deliveryRetryable,
          }) && existing.deliveryStatus !== "SENT"
            ? {
                conversation,
                lead,
                deduplicationKey,
                message: existing,
                created: false,
                plan: null,
                history,
              }
            : null;
        }
        return {
          conversation,
          lead,
          deduplicationKey,
          message: null,
          created: false,
          plan: buildFollowUpPlan(lead, conversation),
          history,
        };
      });
      if (!prepared) continue;

      let selected: { message: Message; created: boolean };
      if (prepared.message) {
        selected = { message: prepared.message, created: false };
      } else {
        let content = buildQualificationFollowUp(
          prepared.conversation,
          prepared.history
            .slice()
            .reverse()
            .find((message) => message.direction === "OUTBOUND")?.content ?? null,
        );
        let selectedInformationNeed = prepared.plan!.nextInformationNeed;
        if (generateNaturalResponse) {
          try {
            const natural = await generateNaturalResponse({
              lead: prepared.lead,
              plan: prepared.plan!,
              triggerType: "FOLLOW_UP_DUE",
              silenceMs: prepared.conversation.lastOutboundAt
                ? Math.max(
                    0,
                    now.getTime() - prepared.conversation.lastOutboundAt.getTime(),
                  )
                : undefined,
              recentMessages: prepared.history.map(({ direction, content }) => ({
                direction,
                content,
              })),
            });
            content = natural.text;
            selectedInformationNeed = natural.nextInformationNeed;
          } catch (error) {
            logger.error("follow_up.generation_fallback", {
              leadId: prepared.lead.id,
              conversationId: prepared.conversation.id,
              fallbackReason: error instanceof Error ? error.message : "UNKNOWN",
            });
          }
        }

        const inserted = await persistence.transaction(async (repositories) => {
          const conversation = await repositories.conversations.findById(
            prepared.conversation.id,
          );
          const lead = conversation
            ? await repositories.leads.findById(conversation.leadId)
            : null;
          if (!conversation || !lead) return null;
          const history = await repositories.messages.listByConversationId(
            conversation.id,
          );
          if (
            !evaluateFollowUpEligibility(conversation, lead, now).eligible ||
            history.some(
              (message) =>
                message.direction === "OUTBOUND" &&
                message.deliveryStatus === "PENDING",
            )
          ) {
            return null;
          }
          const existing = await repositories.messages.findByDeduplicationKey(
            prepared.deduplicationKey,
          );
          if (existing) {
            return canRetryExternalDelivery({
              attempts: existing.deliveryAttempts,
              retryable: existing.deliveryRetryable,
            }) && existing.deliveryStatus !== "SENT"
              ? { message: existing, created: false }
              : null;
          }
          const followUp: Message = {
            id: idGenerator(),
            conversationId: conversation.id,
            leadId: lead.id,
            incomingEventId: null,
            externalMessageId: null,
            deduplicationKey: prepared.deduplicationKey,
            sequence: null,
            direction: "OUTBOUND",
            content,
            deliveryStatus: "PENDING",
            deliveryAttempts: 0,
            deliveryRetryable: null,
            lastDeliveryErrorCode: null,
            sentAt: null,
            createdAt: now,
          };
          const inserted = await repositories.messages.insertIfAbsent(followUp);
          if (!inserted) return null;
          await repositories.conversations.update({
            ...conversation,
            pendingInformationNeed: selectedInformationNeed,
            updatedAt: now,
          });
          return { message: followUp, created: true };
        });
        if (!inserted) continue;
        selected = inserted;
      }

      if (selected.created) created.push(selected.message);
      if (!outboundProvider) continue;

      const stillEligible = await persistence.transaction(async (repositories) => {
        const conversation = await repositories.conversations.findById(candidate.id);
        const lead = conversation
          ? await repositories.leads.findById(conversation.leadId)
          : null;
        const history = conversation
          ? await repositories.messages.listByConversationId(conversation.id)
          : [];
        if (
          conversation &&
          lead &&
          evaluateFollowUpEligibility(conversation, lead, now).eligible &&
          !history.some(
            (message) =>
              message.direction === "INBOUND" &&
              conversation.lastOutboundAt !== null &&
              message.createdAt.getTime() > conversation.lastOutboundAt.getTime(),
          ) &&
          !history.some(
            (message) =>
              message.direction === "OUTBOUND" &&
              message.deliveryStatus === "PENDING" &&
              message.id !== selected.message.id,
          )
        ) {
          return true;
        }
        const pending = await repositories.messages.findById(selected.message.id);
        if (pending && pending.deliveryStatus !== "SENT") {
          await repositories.messages.update({
            ...pending,
            deliveryStatus: "FAILED",
            deliveryRetryable: false,
            lastDeliveryErrorCode: "FOLLOW_UP_NO_LONGER_ELIGIBLE",
          });
        }
        return false;
      });
      if (!stillEligible) {
        logger.info("follow_up.cancelled", {
          leadId: selected.message.leadId,
          conversationId: selected.message.conversationId,
          reason: "NEW_INBOUND_OR_STATE_CHANGED",
        });
        continue;
      }

      const delivered = await createOutboundMessageDelivery({
        persistence,
        provider: outboundProvider,
        logger,
        now: () => now,
      })(selected.message.id);
      if (delivered.deliveryStatus === "SENT") {
        sent.push(delivered);
        await persistence.transaction(async (repositories) => {
          const conversation = await repositories.conversations.findById(
            delivered.conversationId,
          );
          if (!conversation) return;
          await repositories.conversations.update({
            ...conversation,
            lastOutboundAt: delivered.sentAt ?? now,
            followUpEligibleAt: null,
            followUpCount: Math.max(conversation.followUpCount, 1),
            lastFollowUpAt: delivered.sentAt ?? now,
            updatedAt: delivered.sentAt ?? now,
          });
        });
        logger.info("follow_up.sent", {
          leadId: delivered.leadId,
          conversationId: delivered.conversationId,
          messageId: delivered.id,
          selectedInformationNeed:
            prepared.plan?.nextInformationNeed ?? null,
          followUpAlreadySent: prepared.conversation.followUpCount > 0,
        });
      } else {
        failed.push(delivered);
        if (delivered.deliveryRetryable === false) {
          await persistence.transaction(async (repositories) => {
            const conversation = await repositories.conversations.findById(
              delivered.conversationId,
            );
            if (!conversation) return;
            await repositories.conversations.update({
              ...conversation,
              followUpEligibleAt: null,
              updatedAt: now,
            });
          });
        }
        logger.error("follow_up.failed", {
          leadId: delivered.leadId,
          conversationId: delivered.conversationId,
          messageId: delivered.id,
          retryable: delivered.deliveryRetryable,
          errorCode: delivered.lastDeliveryErrorCode,
        });
      }
    }

    return {
      scanned: candidates.length,
      created,
      sent,
      failed,
      skipped: candidates.length - sent.length - failed.length,
    };
  };
}
