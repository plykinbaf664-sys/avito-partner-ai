import type { DeliveryStatus } from "../delivery/delivery-state";

export interface TelegramManagerDelivery {
  id: string;
  managerNotificationId: string;
  recipientId: string;
  idempotencyKey: string;
  deliveryStatus: DeliveryStatus;
  deliveryAttempts: number;
  deliveryRetryable: boolean | null;
  lastDeliveryErrorCode: string | null;
  externalMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

