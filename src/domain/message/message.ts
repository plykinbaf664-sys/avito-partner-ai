import type { DeliveryStatus } from "../delivery/delivery-state";

export const messageDirections = ["INBOUND", "OUTBOUND"] as const;
export type MessageDirection = (typeof messageDirections)[number];
export const messageActors = ["USER", "AI", "MANAGER"] as const;
export type MessageActor = (typeof messageActors)[number];

export interface Message {
  id: string;
  conversationId: string;
  leadId: string;
  incomingEventId: string | null;
  externalMessageId: string | null;
  deduplicationKey: string | null;
  sequence: number | null;
  direction: MessageDirection;
  actor: MessageActor;
  content: string;
  deliveryStatus: DeliveryStatus | null;
  deliveryAttempts: number;
  deliveryRetryable: boolean | null;
  lastDeliveryErrorCode: string | null;
  sentAt: Date | null;
  createdAt: Date;
}
