import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createPendingManagerNotificationDelivery } from "../src/application/delivery/deliver-pending-manager-notifications";
import { ConsoleStructuredLogger } from "../src/application/observability/structured-logger";
import { readTelegramEnvironment } from "../src/config/environment";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { TelegramManagerNotificationProvider } from "../src/integrations/telegram/telegram-manager-notification-provider";

async function main() {
  const { values } = parseArgs({ options: { continuous: { type: "boolean", default: false }, "interval-ms": { type: "string", default: "10000" } } });
  const intervalMs = Number(values["interval-ms"]);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000) throw new Error("INVALID_INTERVAL");
  const config = readTelegramEnvironment(process.env);
  if (!config.enabled || !config.botToken) throw new Error("TELEGRAM_CONFIGURATION_REQUIRED");
  const persistence = SqlitePersistence.create(config.databaseUrl);
  const logger = new ConsoleStructuredLogger();
  const deliver = createPendingManagerNotificationDelivery({ persistence, logger,
    provider: new TelegramManagerNotificationProvider({ botToken: config.botToken, logger }, persistence) });
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  try {
    await persistence.checkReadiness();
    do {
      try {
        await deliver();
        logger.info("telegram_notifications.sweep_completed", {});
      } catch {
        logger.error("telegram_notifications.sweep_failed", { errorCode: "DELIVERY_SWEEP_ERROR" });
        if (!values.continuous) process.exitCode = 1;
      }
      if (!values.continuous) break;
      await delay(intervalMs, undefined, { signal: stop.signal }).catch((error: unknown) => {
        if (!stop.signal.aborted) throw error;
      });
    } while (!stop.signal.aborted);
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    persistence.close();
  }
}
main().catch(() => {
  console.error("TELEGRAM_NOTIFICATIONS=FAIL reason=CONFIGURATION_OR_DATABASE_ERROR");
  process.exitCode = 1;
});
