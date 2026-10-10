import type { Message } from "@/domain/message/message";

import {
  externalErrorCode,
  isRetryableExternalError,
  MAX_EXTERNAL_DELIVERY_ATTEMPTS,
  sanitizeExternalErrorCode,
} from "./retry-policy";
import {
  silentLogger,
  type StructuredLogger,
} from "../observability/structured-logger";
import type { OutboundMessageProvider } from "../ports/channels";
import type { Persistence } from "../ports/repositories";
import { outboundCancellationReason } from "./outbound-obsolescence";

export interface DeliverOutboundMessageDependencies {
  persistence: Persistence;
  provider: OutboundMessageProvider;
  logger?: StructuredLogger;
  now?: () => Date;
  eventId?: string | null;
}

export function createOutboundMessageDelivery({
  persistence,
  provider,
  logger = silentLogger,
  now: clock = () => new Date(),
  eventId = null,
}: DeliverOutboundMessageDependencies) {
  return async function deliverOutboundMessage(messageId: string): Promise<Message> {
    const message = await persistence.messages.findById(messageId);
    if (!message || message.direction !== "OUTBOUND" || !message.deduplicationKey) {
      throw new Error("Deliverable outbound message was not found");
    }
    if (message.deliveryStatus === "SENT") return message;
    if (
      message.deliveryStatus === "FAILED" &&
      (message.deliveryRetryable === false ||
        message.deliveryAttempts >= MAX_EXTERNAL_DELIVERY_ATTEMPTS)
    ) {
      return message;
    }

    const lead = await persistence.leads.findById(message.leadId);
    if (!lead) throw new Error("Outbound message lead was not found");
    // Final local fence also protects retries of a draft prepared before a
    // manager intervention. A channel request already in flight cannot be recalled.
    const history = await persistence.messages.listByConversationId(message.conversationId);
    const cancellationReason = outboundCancellationReason(message, history);
    if (cancellationReason) {
      const cancelled: Message = { ...message, deliveryStatus: "FAILED", deliveryRetryable: false,
        lastDeliveryErrorCode: cancellationReason };
      await persistence.messages.update(cancelled);
      logger.info("outbound.suppressed", { leadId: lead.id, conversationId: message.conversationId,
        messageId, reason: cancellationReason });
      return cancelled;
    }
    const attempts = message.deliveryAttempts + 1;

    try {
      const result = await provider.deliver({
        source: lead.source,
        conversationId: message.conversationId,
        externalRecipientId: lead.externalLeadId,
        text: message.content,
        idempotencyKey: message.deduplicationKey,
      });
      const updated: Message =
        result.status === "SENT"
          ? {
              ...message,
              externalMessageId: result.externalId,
              deliveryStatus: "SENT",
              deliveryAttempts: attempts,
              deliveryRetryable: false,
              lastDeliveryErrorCode: null,
              sentAt: clock(),
            }
          : {
              ...message,
              deliveryStatus: "FAILED",
              deliveryAttempts: result.attempted === false ? message.deliveryAttempts : attempts,
              deliveryRetryable:
                result.retryable && attempts < MAX_EXTERNAL_DELIVERY_ATTEMPTS,
              lastDeliveryErrorCode: sanitizeExternalErrorCode(result.errorCode),
            };
      await persistence.messages.update(updated);
      const suppressed = result.status === "FAILED" && result.errorCode.startsWith("CANCELLED_");
      logger[result.status === "SENT" || suppressed ? "info" : "error"](
        result.status === "SENT" ? "outbound.sent" : suppressed ? "outbound.suppressed" : "outbound.failed",
        {
          leadId: message.leadId,
          conversationId: message.conversationId,
          eventId,
          messageId: message.id,
          attempts,
          retryable: updated.deliveryRetryable,
          errorCode: updated.lastDeliveryErrorCode,
        },
      );
      return updated;
    } catch (error) {
      const retryable =
        isRetryableExternalError(error) &&
        attempts < MAX_EXTERNAL_DELIVERY_ATTEMPTS;
      const updated: Message = {
        ...message,
        deliveryStatus: "FAILED",
        deliveryAttempts: attempts,
        deliveryRetryable: retryable,
        lastDeliveryErrorCode: externalErrorCode(error),
      };
      await persistence.messages.update(updated);
      logger.error("outbound.failed", {
        leadId: message.leadId,
        conversationId: message.conversationId,
        eventId,
        messageId: message.id,
        attempts,
        retryable,
        errorCode: updated.lastDeliveryErrorCode,
      });
      return updated;
    }
  };
}
