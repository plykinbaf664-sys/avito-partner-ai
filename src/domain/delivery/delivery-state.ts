export const deliveryStatuses = ["PENDING", "SENT", "FAILED"] as const;

export type DeliveryStatus = (typeof deliveryStatuses)[number];

export interface DeliveryState {
  status: DeliveryStatus;
  attempts: number;
  retryable: boolean | null;
  lastErrorCode: string | null;
  sentAt: Date | null;
}
