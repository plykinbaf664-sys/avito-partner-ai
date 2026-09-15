import { createManagerNotificationDelivery } from "./deliver-manager-notification";
import type { ManagerNotificationProvider } from "../ports/channels";
import type { Persistence } from "../ports/repositories";
import type { StructuredLogger } from "../observability/structured-logger";

export function createPendingManagerNotificationDelivery({
  persistence,
  provider,
  logger,
}: {
  persistence: Persistence;
  provider: ManagerNotificationProvider;
  logger?: StructuredLogger;
}) {
  const deliver = createManagerNotificationDelivery({ persistence, provider, logger });
  return async function deliverPendingManagerNotifications(
    limit = 25,
  ): Promise<void> {
    const notifications =
      await persistence.managerNotifications.listDeliverable(limit);
    for (const notification of notifications) {
      await deliver(notification.id);
    }
  };
}
