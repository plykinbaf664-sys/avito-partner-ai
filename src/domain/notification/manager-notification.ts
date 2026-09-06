import type { DeliveryStatus } from "../delivery/delivery-state";
import type { ManagerSummary } from "../handoff/manager-summary";
import type { QualificationStatus } from "../lead/qualification-status";

export interface ManagerNotification {
  id: string;
  leadId: string;
  conversationId: string;
  qualificationStatus: QualificationStatus;
  summary: ManagerSummary;
  idempotencyKey: string;
  deliveryStatus: DeliveryStatus;
  deliveryAttempts: number;
  deliveryRetryable: boolean | null;
  lastDeliveryErrorCode: string | null;
  externalNotificationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}
