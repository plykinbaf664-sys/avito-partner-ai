import type { Conversation } from "@/domain/conversation/conversation";
import { transitionConversation } from "@/domain/conversation/conversation-state";
import type { Message } from "@/domain/message/message";
import { generateId, type IdGenerator } from "@/shared/id";

import { silentLogger, type StructuredLogger } from "../observability/structured-logger";
import type { Persistence } from "../ports/repositories";
import { createInitialLead } from "./process-incoming-event";
import { followUpEligibleAt } from "@/domain/follow-up/follow-up-policy";

export interface ExternalConversationMessageInput {
  source: string;
  externalLeadId: string;
  externalMessageId: string;
  text: string;
  createdAt: Date;
}

export interface ExternalConversationMessageResult {
  leadId: string;
  conversationId: string;
  messageId: string;
  created: boolean;
  duplicate: boolean;
}

export function createExternalConversationMessageRecorder({
  persistence,
  logger = silentLogger,
  generateId: idGenerator = generateId,
}: {
  persistence: Persistence;
  logger?: StructuredLogger;
  generateId?: IdGenerator;
}) {
  return async function recordExternalConversationMessage(
    input: ExternalConversationMessageInput,
  ): Promise<ExternalConversationMessageResult> {
    const deduplicationKey = `avito-human-message:${input.source}:${input.externalLeadId}:${input.externalMessageId}`;
    return persistence.transaction(async (repositories) => {
      let lead = await repositories.leads.findByExternalIdentity(
        input.source,
        input.externalLeadId,
      );
      if (!lead) {
        lead = createInitialLead(
          idGenerator(),
          input.source,
          input.externalLeadId,
          input.createdAt,
        );
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
          lastInboundAt: null,
          lastOutboundAt: null,
          awaitingUserReply: false,
          qualificationCompleted: false,
          followUpEligibleAt: null,
          followUpCount: 0,
          lastFollowUpAt: null,
          followUpAnchorAt: null,
          missedAt: null,
          nextInboundSequence: 0,
          lastAppliedInboundSequence: 0,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          closedAt: null,
        } satisfies Conversation;
        await repositories.conversations.insert(conversation);
      }
      const existing = await repositories.messages.findByDeduplicationKey(
        deduplicationKey,
      );
      if (existing) {
        return {
          leadId: lead.id,
          conversationId: conversation.id,
          messageId: existing.id,
          created: false,
          duplicate: true,
        };
      }
      const messages = await repositories.messages.listByConversationId(conversation.id);
      const supersedesCurrent = (!conversation.lastOutboundAt || input.createdAt >= conversation.lastOutboundAt) &&
        (!conversation.lastInboundAt || input.createdAt >= conversation.lastInboundAt);
      for (const pending of messages.filter(
        (message) =>
          supersedesCurrent &&
          message.direction === "OUTBOUND" &&
          message.deliveryStatus === "PENDING" &&
          message.actor === "AI",
      )) {
        await repositories.messages.update({
          ...pending,
          deliveryStatus: "FAILED",
          deliveryRetryable: false,
          lastDeliveryErrorCode: "CANCELLED_BY_HUMAN_MESSAGE",
        });
      }
      const message: Message = {
        id: idGenerator(),
        conversationId: conversation.id,
        leadId: lead.id,
        incomingEventId: null,
        externalMessageId: input.externalMessageId,
        deduplicationKey,
        sequence: null,
        direction: "OUTBOUND",
        actor: "MANAGER",
        content: input.text,
        deliveryStatus: null,
        deliveryAttempts: 0,
        deliveryRetryable: null,
        lastDeliveryErrorCode: null,
        sentAt: input.createdAt,
        createdAt: input.createdAt,
      };
      await repositories.messages.insertIfAbsent(message);
      const latestOutboundAt = conversation.lastOutboundAt &&
        conversation.lastOutboundAt.getTime() > input.createdAt.getTime()
        ? conversation.lastOutboundAt
        : input.createdAt;
      const canContinue = supersedesCurrent && !conversation.qualificationCompleted &&
        !["NO_FIT", "HANDOFF", "CLOSED"].includes(lead.qualificationStatus) &&
        lead.handoffAt === null && lead.buyingIntent !== "DECLINED";
      await repositories.conversations.update({
        ...conversation,
        lastOutboundAt: latestOutboundAt,
        ...(supersedesCurrent ? {
          awaitingUserReply: canContinue,
          followUpEligibleAt: canContinue ? followUpEligibleAt(latestOutboundAt) : null,
          followUpAnchorAt: canContinue ? latestOutboundAt : null,
          followUpCount: 0, lastFollowUpAt: null, missedAt: null,
          pendingInformationNeed: null,
        } : {}),
        updatedAt:
          conversation.updatedAt.getTime() > input.createdAt.getTime()
            ? conversation.updatedAt
            : input.createdAt,
      });
      logger.info("avito.human_message_recorded", {
        source: input.source,
        externalLeadId: input.externalLeadId,
        externalMessageId: input.externalMessageId,
        leadId: lead.id,
        conversationId: conversation.id,
        messageId: message.id,
      });
      return {
        leadId: lead.id,
        conversationId: conversation.id,
        messageId: message.id,
        created: true,
        duplicate: false,
      };
    });
  };
}
