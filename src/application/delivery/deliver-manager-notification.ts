import type { ManagerNotification } from "@/domain/notification/manager-notification";

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
import type { ManagerNotificationProvider } from "../ports/channels";
import type { Persistence } from "../ports/repositories";

export function createManagerNotificationDelivery({
  persistence,
  provider,
  logger = silentLogger,
  now: clock = () => new Date(),
  eventId = null,
}: {
  persistence: Persistence;
  provider: ManagerNotificationProvider;
  logger?: StructuredLogger;
  now?: () => Date;
  eventId?: string | null;
}) {
  return async function deliverManagerNotification(
    notificationId: string,
  ): Promise<ManagerNotification> {
    const notification =
      await persistence.managerNotifications.findById(notificationId);
    if (!notification) throw new Error("Manager notification was not found");
    if (notification.deliveryStatus === "SENT") return notification;
    if (
      notification.deliveryStatus === "FAILED" &&
      (notification.deliveryRetryable === false ||
        notification.deliveryAttempts >= MAX_EXTERNAL_DELIVERY_ATTEMPTS)
    ) {
      return notification;
    }

    try {
      const result = await provider.notify({
        notificationId: notification.id,
        leadId: notification.leadId,
        conversationId: notification.conversationId,
        qualificationStatus: notification.qualificationStatus,
        summary: notification.summary,
        idempotencyKey: notification.idempotencyKey,
        createdAt: notification.createdAt,
      });
      const attempts =
        notification.deliveryAttempts +
        (result.status === "FAILED" && result.attempted === false ? 0 : 1);
      const updated: ManagerNotification =
        result.status === "SENT"
          ? {
              ...notification,
              deliveryStatus: "SENT",
              deliveryAttempts: attempts,
              deliveryRetryable: false,
              lastDeliveryErrorCode: null,
              externalNotificationId: result.externalId,
              updatedAt: clock(),
              sentAt: clock(),
            }
          : {
              ...notification,
              deliveryStatus: "FAILED",
              deliveryAttempts: attempts,
              deliveryRetryable:
                result.retryable && attempts < MAX_EXTERNAL_DELIVERY_ATTEMPTS,
              lastDeliveryErrorCode: sanitizeExternalErrorCode(result.errorCode),
              updatedAt: clock(),
            };
      await persistence.managerNotifications.update(updated);
      logger[result.status === "SENT" ? "info" : "error"](
        result.status === "SENT"
          ? "manager_notification.sent"
          : "manager_notification.failed",
        {
          leadId: notification.leadId,
          conversationId: notification.conversationId,
          eventId,
          notificationId: notification.id,
          attempts,
          retryable: updated.deliveryRetryable,
          errorCode: updated.lastDeliveryErrorCode,
        },
      );
      return updated;
    } catch (error) {
      const attempts = notification.deliveryAttempts + 1;
      const retryable =
        isRetryableExternalError(error) &&
        attempts < MAX_EXTERNAL_DELIVERY_ATTEMPTS;
      const updated: ManagerNotification = {
        ...notification,
        deliveryStatus: "FAILED",
        deliveryAttempts: attempts,
        deliveryRetryable: retryable,
        lastDeliveryErrorCode: externalErrorCode(error),
        updatedAt: clock(),
      };
      await persistence.managerNotifications.update(updated);
      logger.error("manager_notification.failed", {
        leadId: notification.leadId,
        conversationId: notification.conversationId,
        eventId,
        notificationId: notification.id,
        attempts,
        retryable,
        errorCode: updated.lastDeliveryErrorCode,
      });
      return updated;
    }
  };
}
