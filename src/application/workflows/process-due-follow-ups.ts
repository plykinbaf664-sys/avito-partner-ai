import { assessInformationNeeds } from "@/domain/conversation/information-needs";
import { PARTNER_KNOWLEDGE_BASE } from "@/domain/knowledge/knowledge-base";
import { settleLlmUsage, type LlmUsageTotals } from "../observability/llm-usage";
import { readConversationalNotes, mergeConversationalNotes } from "../conversation/conversation-context";
import type { ConversationResponsePlan } from "@/domain/conversation/conversation-response";
import {
  qualificationObjectiveForInformationNeed,
} from "@/domain/conversation/conversation-response";
import type { Conversation } from "@/domain/conversation/conversation";
import type { InformationNeed } from "@/domain/conversation/information-needs";
import {
  buildQualificationFollowUp,
  evaluateFollowUpEligibility,
  FOLLOW_UP_POLICY,
  nextSilenceDeadline,
} from "@/domain/follow-up/follow-up-policy";
import { hasConfirmedPhone } from "@/domain/qualification/qualification-policy";
import type { Lead } from "@/domain/lead/lead";
import type { Message } from "@/domain/message/message";
import { generateId, type IdGenerator } from "@/shared/id";

import type {
  NaturalResponseGenerator,
} from "../conversation/generate-natural-response";
import { createOutboundMessageDelivery } from "../delivery/deliver-outbound-message";
import { canRetryExternalDelivery, externalErrorCode } from "../delivery/retry-policy";
import {
  silentLogger,
  type StructuredLogger,
} from "../observability/structured-logger";
import type { OutboundMessageProvider } from "../ports/channels";
import type { Persistence } from "../ports/repositories";

const QUALIFIED_STATUSES = ["QUALIFIED", "PRIORITY", "HOT", "WARM"] as const;

function followUpDeduplicationKey(conversation: Conversation): string {
  const anchor = conversation.followUpAnchorAt ?? conversation.lastOutboundAt ?? conversation.updatedAt;
  return `qualification-follow-up:${conversation.id}:${anchor.getTime()}:${conversation.followUpCount + 1}`;
}

function buildFollowUpPlan(
  lead: Lead,
): ConversationResponsePlan {
  const needs = assessInformationNeeds(lead);
  const qualificationSatisfied = QUALIFIED_STATUSES.includes(
    lead.qualificationStatus as (typeof QUALIFIED_STATUSES)[number],
  );
  const allowedNextInformationNeeds: InformationNeed[] =
    qualificationSatisfied && !hasConfirmedPhone(lead)
      ? ["PHONE_NUMBER"]
      : needs.allowedNextInformationNeeds;
  return {
    text:
      "Сформируй одно короткое естественное продолжение разговора после паузы.",
    nextInformationNeed: null,
    asksUserQuestion: false,
    knowledgeEntryIds: [],
    approvedFacts: PARTNER_KNOWLEDGE_BASE.map(({ id, category, answer }) => ({ id, category, answer })),
    unresolvedQuestions: [],
    useNaturalAdaptation: true,
    allowedNextInformationNeeds,
    allowedNextQuestions: [],
    allowedQualificationMoves: allowedNextInformationNeeds.map((need) => ({
      need,
      objective: qualificationObjectiveForInformationNeed(need),
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
        if (conversation.followUpCount === FOLLOW_UP_POLICY.maximumQualificationFollowUps) {
          await repositories.conversations.update({ ...conversation, missedAt: now,
            awaitingUserReply: false, followUpEligibleAt: null, updatedAt: now });
          logger.info("conversation.missed", { leadId: lead.id, conversationId: conversation.id,
            followUpCount: conversation.followUpCount });
          return null;
        }
        const deduplicationKey = followUpDeduplicationKey(conversation);
        const existing =
          await repositories.messages.findByDeduplicationKey(deduplicationKey);
        if (existing) {
          return existing.deliveryStatus === "SENT" || canRetryExternalDelivery({
            attempts: existing.deliveryAttempts,
            retryable: existing.deliveryRetryable,
          })
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
          plan: buildFollowUpPlan(lead),
          history,
        };
      });
      if (!prepared) continue;

      let selected: { message: Message; created: boolean };
      let generationUsage: LlmUsageTotals | undefined;
      let generationFallback = false;
      const settleUsage = (outcome: Parameters<typeof settleLlmUsage>[2]) => settleLlmUsage(persistence.llmUsage,
        generationUsage?.callIds ?? [], outcome, () => logger.error("llm.usage_settlement_failed", { conversationId: candidate.id }));
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
        let noReply = false;
        let conversationNotes: string | undefined;
        if (generateNaturalResponse) {
          try {
            const natural = await generateNaturalResponse({
              llmContext: { requestId: generateId(), conversationId: prepared.conversation.id, leadId: prepared.lead.id,
                source: prepared.lead.source, operation: "FOLLOW_UP" },
              lead: prepared.lead,
              conversationMemory: readConversationalNotes(prepared.conversation.summary),
              plan: prepared.plan!,
              triggerType: "FOLLOW_UP_DUE",
              followUpStage: prepared.conversation.followUpCount + 1,
              silenceMs: (prepared.conversation.followUpAnchorAt ?? prepared.conversation.lastOutboundAt)
                ? Math.max(
                    0,
                    now.getTime() - (prepared.conversation.followUpAnchorAt ?? prepared.conversation.lastOutboundAt)!.getTime(),
                  )
                : undefined,
              recentMessages: prepared.history.map(({ direction, actor, content }) => ({
                direction,
                actor,
                content,
              })),
            });
            generationUsage = natural.llmUsage;
            conversationNotes = natural.conversationMemory;
            noReply = natural.replyAction === "NO_REPLY";
            content = natural.text;
            selectedInformationNeed = natural.nextInformationNeed;
            if (!noReply && !content.trim()) throw Object.assign(new Error("EMPTY_FOLLOW_UP"), { code: "EMPTY_FOLLOW_UP" });
          } catch (error) {
            generationFallback = true;
            // Proactive messages require a reliable conversational decision.
            // Fail closed: never spam neutral fallback text or mark a lead
            // MISSED as if two useful messages had been delivered.
            noReply = true;
            if (error instanceof Error && "llmUsage" in error) generationUsage = error.llmUsage as LlmUsageTotals;
            logger.error("follow_up.generation_fallback", {
              leadId: prepared.lead.id,
              conversationId: prepared.conversation.id,
              fallbackReason: externalErrorCode(error),
            });
          }
        }

        if (noReply) {
          const consumed = await persistence.transaction(async (repositories) => {
            const current = await repositories.conversations.findById(prepared.conversation.id);
            const lead = current ? await repositories.leads.findById(current.leadId) : null;
            if (!current || !lead || !evaluateFollowUpEligibility(current, lead, now).eligible ||
                current.lastAppliedInboundSequence !== prepared.conversation.lastAppliedInboundSequence ||
                current.lastInboundAt?.getTime() !== prepared.conversation.lastInboundAt?.getTime() ||
                current.lastOutboundAt?.getTime() !== prepared.conversation.lastOutboundAt?.getTime()) return false;
            // Consume this silence decision, without claiming a message was sent.
            // A new inbound schedules its own episode through the ordinary workflow.
            await repositories.conversations.update({ ...current, followUpEligibleAt: null, awaitingUserReply: false,
              summary: mergeConversationalNotes(current.summary, conversationNotes), updatedAt: now });
            return true;
          });
          await settleUsage(consumed ? generationFallback ? "FALLBACK" : "NO_REPLY" : "SUPPRESSED");
          continue;
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
            conversation.followUpAnchorAt?.getTime() !== prepared.conversation.followUpAnchorAt?.getTime() ||
            conversation.lastOutboundAt?.getTime() !== prepared.conversation.lastOutboundAt?.getTime() ||
            conversation.nextInboundSequence !== prepared.conversation.nextInboundSequence ||
            conversation.followUpCount !== prepared.conversation.followUpCount ||
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
            actor: "AI",
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
            summary: mergeConversationalNotes(conversation.summary, conversationNotes),
            pendingInformationNeed: selectedInformationNeed,
            updatedAt: now,
          });
          return { message: followUp, created: true };
        });
        if (!inserted) { await settleUsage("SUPPRESSED"); continue; }
        selected = inserted;
        await settleUsage(generationFallback ? "FALLBACK" : "USED");
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
          conversation.followUpAnchorAt?.getTime() === prepared.conversation.followUpAnchorAt?.getTime() &&
          conversation.nextInboundSequence === prepared.conversation.nextInboundSequence &&
          conversation.followUpCount === prepared.conversation.followUpCount &&
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
        await settleUsage("SUPPRESSED");
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
          if (conversation.followUpAnchorAt?.getTime() !== prepared.conversation.followUpAnchorAt?.getTime() ||
              conversation.nextInboundSequence !== prepared.conversation.nextInboundSequence) return;
          const sentAt = delivered.sentAt ?? now;
          const anchor = conversation.followUpAnchorAt ?? prepared.conversation.lastOutboundAt ?? sentAt;
          const count = Math.max(conversation.followUpCount, prepared.conversation.followUpCount + 1);
          await repositories.conversations.update({
            ...conversation,
            lastOutboundAt: delivered.sentAt ?? now,
            followUpAnchorAt: anchor,
            followUpEligibleAt: nextSilenceDeadline(anchor, count, sentAt),
            followUpCount: count,
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
            if (!conversation ||
                conversation.followUpAnchorAt?.getTime() !== prepared.conversation.followUpAnchorAt?.getTime() ||
                conversation.nextInboundSequence !== prepared.conversation.nextInboundSequence) return;
            await repositories.conversations.update({
              ...conversation,
              followUpEligibleAt: null,
              updatedAt: now,
            });
          });
        }
        if (delivered.lastDeliveryErrorCode?.startsWith("CANCELLED_")) await settleUsage("SUPPRESSED");
        logger[delivered.lastDeliveryErrorCode?.startsWith("CANCELLED_") ? "info" : "error"]("follow_up.failed", {
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
