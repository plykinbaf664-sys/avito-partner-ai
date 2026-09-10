import { createManagerNotificationDelivery } from "./deliver-manager-notification";
import type { ManagerNotificationProvider } from "../ports/channels";
import type { Persistence } from "../ports/repositories";

export function createPendingManagerNotificationDelivery({
  persistence,
  provider,
}: {
  persistence: Persistence;
  provider: ManagerNotificationProvider;
}) {
  const deliver = createManagerNotificationDelivery({ persistence, provider });
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
