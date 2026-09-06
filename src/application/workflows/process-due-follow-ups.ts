import {
  buildQualificationFollowUp,
  evaluateFollowUpEligibility,
} from "@/domain/follow-up/follow-up-policy";
import type { Message } from "@/domain/message/message";
import { generateId, type IdGenerator } from "@/shared/id";

import { createOutboundMessageDelivery } from "../delivery/deliver-outbound-message";
import { canRetryExternalDelivery } from "../delivery/retry-policy";
import {
  silentLogger,
  type StructuredLogger,
} from "../observability/structured-logger";
import type { OutboundMessageProvider } from "../ports/channels";
import type { Persistence } from "../ports/repositories";

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
  logger?: StructuredLogger;
  generateId?: IdGenerator;
  limit?: number;
}

export function createDueFollowUpsProcessor({
  persistence,
  outboundProvider,
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
      });
      const selected = await persistence.transaction(async (repositories) => {
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

        const deduplicationKey = `qualification-follow-up:${conversation.id}:1`;
        const existing =
          await repositories.messages.findByDeduplicationKey(deduplicationKey);
        if (existing) {
          return canRetryExternalDelivery({
            attempts: existing.deliveryAttempts,
            retryable: existing.deliveryRetryable,
          }) && existing.deliveryStatus !== "SENT"
            ? { message: existing, created: false }
            : null;
        }

        const history = await repositories.messages.listByConversationId(
          conversation.id,
        );
        const lastOutbound = [...history]
          .reverse()
          .find((item) => item.direction === "OUTBOUND");
        const followUp: Message = {
          id: idGenerator(),
          conversationId: conversation.id,
          leadId: lead.id,
          incomingEventId: null,
          externalMessageId: null,
          deduplicationKey,
          sequence: null,
          direction: "OUTBOUND",
          content: buildQualificationFollowUp(
            conversation,
            lastOutbound?.content ?? null,
          ),
          deliveryStatus: "PENDING",
          deliveryAttempts: 0,
          deliveryRetryable: null,
          lastDeliveryErrorCode: null,
          sentAt: null,
          createdAt: now,
        };
        const inserted = await repositories.messages.insertIfAbsent(followUp);
        return inserted ? { message: followUp, created: true } : null;
      });
      if (!selected) continue;
      if (selected.created) created.push(selected.message);
      if (!outboundProvider) continue;

      const stillEligible = await persistence.transaction(async (repositories) => {
        const conversation = await repositories.conversations.findById(candidate.id);
        const lead = conversation
          ? await repositories.leads.findById(conversation.leadId)
          : null;
        if (
          conversation &&
          lead &&
          evaluateFollowUpEligibility(conversation, lead, now).eligible
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
        logger.info("follow_up.skipped", {
          leadId: selected.message.leadId,
          conversationId: selected.message.conversationId,
          reason: "STATE_CHANGED_BEFORE_DELIVERY",
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
