import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { readBaseEnvironment, readTelegramEnvironment } from "../src/config/environment";
import { TelegramBotApiClient } from "../src/integrations/telegram/telegram-bot-api-client";
import { runProductionWatchdog } from "../src/application/health/production-watchdog";

async function main() {
  const base = readBaseEnvironment(process.env);
  if (!base.AVITO_CHANNEL_ENABLED) { console.log("PRODUCTION_WATCHDOG=DISABLED"); return; }
  const telegram = readTelegramEnvironment(process.env);
  const persistence = SqlitePersistence.create(base.DATABASE_URL);
  try {
    await persistence.checkReadiness();
    const result = await runProductionWatchdog({ persistence,
      sender: telegram.enabled ? new TelegramBotApiClient(telegram.botToken!) : undefined,
      probeHttp: async () => {
        const response = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(5_000) });
        return response.ok && (await response.json()).status === "ok";
      } });
    console.log(JSON.stringify({ event: "production.watchdog", ready: result.status.ready, issues: result.status.issues,
      backlog: result.status.backlog, alertDelivery: result.alertDelivery }));
    if (result.alertDelivery === "FAILED") process.exitCode = 1;
  } finally { persistence.close(); }
}
main().catch(() => { console.error("PRODUCTION_WATCHDOG_FAILED"); process.exitCode = 1; });
