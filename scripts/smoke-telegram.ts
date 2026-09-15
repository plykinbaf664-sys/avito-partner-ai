import { parseArgs } from "node:util";
import { z } from "zod";
import { readTelegramEnvironment } from "../src/config/environment";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { TelegramBotApiClient } from "../src/integrations/telegram/telegram-bot-api-client";
import { sendTelegramSmokeNotification } from "../src/integrations/telegram/telegram-smoke";

async function main() {
  const { values } = parseArgs({ options: { "chat-id": { type: "string" }, send: { type: "boolean", default: false } } });
  if (values.send && !values["chat-id"]) throw new Error("TEST_CHAT_ID_REQUIRED");
  const config = readTelegramEnvironment(process.env);
  if (!config.botToken) throw new Error("BOT_TOKEN_REQUIRED");
  const botResponse = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`, { signal: AbortSignal.timeout(10_000) });
  const bot = z.object({ ok: z.literal(true), result: z.object({ username: z.string() }) }).safeParse(await botResponse.json());
  if (!botResponse.ok || !bot.success) throw new Error("BOT_AUTH_FAILED");
  const webhookResponse = await fetch(`https://api.telegram.org/bot${config.botToken}/getWebhookInfo`, { signal: AbortSignal.timeout(10_000) });
  const webhook = z.object({ ok: z.literal(true), result: z.object({ url: z.string(), pending_update_count: z.number(), last_error_date: z.number().optional() }) }).safeParse(await webhookResponse.json());
  if (!webhookResponse.ok || !webhook.success) throw new Error("WEBHOOK_CHECK_FAILED");
  const persistence = SqlitePersistence.create(config.databaseUrl);
  try {
    await persistence.checkReadiness();
    const active = await persistence.telegramManagerRecipients.listActive();
    console.log(JSON.stringify({ event: "telegram_smoke.diagnostics", bot: bot.data.result.username,
      enabled: config.enabled, activeManagers: active.length,
      webhookConfigured: Boolean(webhook.data.result.url), pendingUpdates: webhook.data.result.pending_update_count,
      lastWebhookErrorAt: webhook.data.result.last_error_date ?? null,
      webhookSecretConfigured: Boolean(config.webhookSecret), webhookUrlConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_URL?.trim()) }));
    if (!values.send) {
      console.log("TELEGRAM_SMOKE=CHECKED sent=false (use --chat-id <TEST_MANAGER_CHAT_ID> --send for delivery)");
      return;
    }
    if (!config.enabled) throw new Error("TELEGRAM_NOT_ENABLED");
    const started = Date.now();
    const result = await sendTelegramSmokeNotification(persistence, new TelegramBotApiClient(config.botToken), values["chat-id"]!);
    console.log(JSON.stringify({ event: "telegram_smoke.delivery", status: result.status,
      providerMessageId: result.status === "SENT" ? result.externalId : null,
      errorCode: result.status === "FAILED" ? result.errorCode : null, latencyMs: Date.now() - started }));
    if (result.status === "FAILED") process.exitCode = 1;
  } finally { persistence.close(); }
}

main().catch(() => {
  // Never print API exception text: it can contain the token-bearing URL.
  console.error("TELEGRAM_SMOKE=FAIL check=ENV_BOT_DATABASE_AND_REGISTERED_TEST_CHAT");
  process.exitCode = 1;
});
