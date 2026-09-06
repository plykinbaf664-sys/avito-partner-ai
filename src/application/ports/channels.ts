import type { ManagerSummary } from "@/domain/handoff/manager-summary";
import type { QualificationStatus } from "@/domain/lead/qualification-status";

export interface InboundChannelEvent {
  source: string;
  externalEventId: string;
  externalLeadId: string;
  message: string;
  rawPayload: unknown;
}

export interface InboundChannel {
  normalize(untrustedPayload: unknown): Promise<InboundChannelEvent>;
}

export interface OutboundDeliveryRequest {
  source: string;
  conversationId: string;
  externalRecipientId: string;
  text: string;
  idempotencyKey: string;
}

export type ProviderDeliveryResult =
  | {
      status: "SENT";
      externalId: string | null;
    }
  | {
      status: "FAILED";
      retryable: boolean;
      errorCode: string;
    };

export interface OutboundMessageProvider {
  deliver(message: OutboundDeliveryRequest): Promise<ProviderDeliveryResult>;
}

export interface ManagerNotificationRequest {
  leadId: string;
  conversationId: string;
  qualificationStatus: QualificationStatus;
  summary: ManagerSummary;
  idempotencyKey: string;
}

export interface ManagerNotificationProvider {
  notify(
    notification: ManagerNotificationRequest,
  ): Promise<ProviderDeliveryResult>;
}
